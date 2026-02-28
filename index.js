const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { askClaude } = require('./claude-bridge');
const { textToSpeech } = require('./tts');
const config = require('./config');

const AUDIO_DIR = './audio_tmp';
const HISTORY_DIR = './history';
const AUTH_DIR = './auth_info';

// ─── Suppress Baileys internal noise ────────────────────────────
const NOISE = ['Closing session', 'SessionEntry', 'Decrypted message', 'Bad MAC', 'Failed to decrypt', 'Session error', 'Closing open session', 'pendingPreKey', 'registrationId', 'ephemeralKeyPair', '_chains', 'chainKey', 'rootKey', 'baseKey', 'indexInfo', 'currentRatchet'];
const isNoise = (msg) => NOISE.some(p => (msg || '').includes(p));
const isNoiseArgs = (...a) => a.some(arg => isNoise(typeof arg === 'string' ? arg : JSON.stringify(arg).substring(0, 200)));
const _log = console.log;
const _err = console.error;
const _warn = console.warn;
console.log = (...a) => { if (!isNoiseArgs(...a)) _log(...a); };
console.error = (...a) => { if (!isNoiseArgs(...a)) _err(...a); };
console.warn = (...a) => { if (!isNoiseArgs(...a)) _warn(...a); };
// Also intercept direct stdout writes from Baileys signal protocol
const _stdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = function(chunk, ...args) {
  if (typeof chunk === 'string' && isNoise(chunk)) return true;
  return _stdoutWrite(chunk, ...args);
};

// ─── Logger ─────────────────────────────────────────────────────
const logger = pino({ level: 'silent' });
const logFile = path.join(config.LOG_DIR, 'agent.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  _log(line);
  try { fs.appendFileSync(logFile, line + '\n'); } catch {}
}

// ─── Startup validation ─────────────────────────────────────────
function validateConfig() {
  if (config.ALLOWED_NUMBERS.length === 0) {
    log('WARNING: No WHATSAPP_NUMBERS configured in .env — the agent will not respond to anyone.');
  }
  if (!config.CLAUDE_PATH || config.CLAUDE_PATH === 'claude') {
    log('INFO: Using "claude" from PATH. Set CLAUDE_CLI_PATH in .env if this fails.');
  }
  if (!config.ELEVENLABS_API_KEY) {
    log('INFO: ElevenLabs not configured — voice responses disabled.');
  }
}

// ─── History ────────────────────────────────────────────────────
function sanitizeChatId(chatId) {
  return chatId.replace(/[^a-zA-Z0-9@._-]/g, '_');
}

function getHistory(chatId) {
  const file = path.join(HISTORY_DIR, `${sanitizeChatId(chatId)}.json`);
  if (!fs.existsSync(file)) return [];
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return []; }
}

function saveHistory(chatId, history) {
  const file = path.join(HISTORY_DIR, `${sanitizeChatId(chatId)}.json`);
  fs.writeFileSync(file, JSON.stringify(history.slice(-config.MAX_HISTORY), null, 2));
}

// ─── Message queue (sequential processing) ──────────────────────
const messageQueue = [];
let processing = false;

async function processQueue(sock) {
  if (processing || messageQueue.length === 0) return;
  processing = true;

  while (messageQueue.length > 0) {
    const { chatId, text, fromMe, wasAudio, cleanupPaths } = messageQueue.shift();
    try {
      await sock.presenceSubscribe(chatId);
      await sock.sendPresenceUpdate('composing', chatId);
      log(`Processing: ${text.substring(0, 80)}...`);

      const history = getHistory(chatId);
      const response = await askClaude(text, history);

      await sock.sendPresenceUpdate('paused', chatId);

      // Strip [FILE:] tags from text response (files are sent as attachments below)
      const fileMatches = response.match(/\[FILE:([^\]]+)\]/g);
      const cleanResponse = response.replace(/\[FILE:[^\]]+\]/g, '').replace(/\n{3,}/g, '\n\n').trim();

      // Voice reply
      const shouldSendAudio = config.VOICE_REPLY_MODE === 'always'
        || (config.VOICE_REPLY_MODE === 'auto' && wasAudio);

      if (shouldSendAudio && config.ELEVENLABS_API_KEY) {
        try {
          log('Generating voice response...');
          const audioPath = await textToSpeech(cleanResponse);
          const audioBuffer = fs.readFileSync(audioPath);
          await sock.sendMessage(chatId, { audio: audioBuffer, mimetype: 'audio/ogg; codecs=opus', ptt: true });
          try { fs.unlinkSync(audioPath); } catch {}
          log('Voice sent.');
        } catch (ttsErr) {
          log(`TTS failed, sending text: ${ttsErr.message}`);
          await sendTextChunks(sock, chatId, cleanResponse);
        }
      } else {
        if (cleanResponse) await sendTextChunks(sock, chatId, cleanResponse);
      }

      // Send file attachments
      if (fileMatches) {
        const allowedDirs = [
          path.resolve(config.FILES_DIR),
          path.resolve(config.PROJECT_DIR),
        ].filter(Boolean);

        for (const match of fileMatches) {
          const filePath = match.replace('[FILE:', '').replace(']', '').trim();
          const resolvedPath = path.resolve(filePath);
          // Security: only allow files inside allowed directories
          const isAllowedPath = allowedDirs.some(dir =>
            resolvedPath.startsWith(dir + path.sep) || resolvedPath === dir
          );
          if (!isAllowedPath) {
            log(`Blocked file outside allowed dirs: ${filePath}`);
            continue;
          }
          if (fs.existsSync(resolvedPath)) {
            const fileBuffer = fs.readFileSync(resolvedPath);
            const fileName = path.basename(resolvedPath);
            const ext = path.extname(resolvedPath).toLowerCase();
            const mimeTypes = { '.pdf': 'application/pdf', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg' };
            await sock.sendMessage(chatId, { document: fileBuffer, mimetype: mimeTypes[ext] || 'application/octet-stream', fileName });
            log(`File sent: ${fileName}`);
          } else {
            log(`File not found: ${resolvedPath}`);
          }
        }
      }

      // Clean up downloaded media after processing
      if (cleanupPaths && cleanupPaths.length > 0) {
        for (const p of cleanupPaths) {
          try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
        }
      }

      history.push({ text, fromMe, reply: response, timestamp: Date.now() });
      saveHistory(chatId, history);
      log(`Response sent (${response.length} chars)`);
    } catch (err) {
      log(`Error: ${err.message}`);
      try { await sock.sendPresenceUpdate('paused', chatId); } catch {}
      const isTimeout = err.message?.includes('exit 143') || err.message?.includes('SIGTERM') || err.message?.includes('timeout');
      const errorMsg = isTimeout
        ? 'Response timed out. Try a shorter or more specific message.'
        : 'Error processing your message. Please try again.';
      try { await sock.sendMessage(chatId, { text: errorMsg }); } catch {}
    }
  }

  processing = false;
}

function sendTextChunks(sock, chatId, text) {
  const chunks = splitMessage(text, 4000);
  return chunks.reduce((p, chunk) => p.then(() => sock.sendMessage(chatId, { text: chunk })), Promise.resolve());
}

function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) { chunks.push(remaining); break; }
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.3) splitAt = maxLen;
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }
  return chunks;
}

// ─── Audio transcription (Whisper) ──────────────────────────────
async function transcribeAudio(msg, sock) {
  if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const ts = Date.now();
  const oggPath = path.join(AUDIO_DIR, `${ts}.ogg`);
  const wavPath = path.join(AUDIO_DIR, `${ts}.wav`);

  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
      logger: pino({ level: 'silent' }),
      reuploadRequest: sock.updateMediaMessage
    });
    fs.writeFileSync(oggPath, buffer);
    log(`Audio downloaded: ${buffer.length} bytes`);
    if (buffer.length < 100) throw new Error(`Downloaded audio too small: ${buffer.length} bytes`);

    execSync(`ffmpeg -i "${oggPath}" -ar 16000 -ac 1 "${wavPath}" -y 2>&1`);
    execSync(`whisper "${wavPath}" --model base --output_format txt --output_dir "${AUDIO_DIR}" 2>&1`, { encoding: 'utf-8', timeout: 60000 });

    const txtPath = path.join(AUDIO_DIR, `${ts}.txt`);
    if (fs.existsSync(txtPath)) return fs.readFileSync(txtPath, 'utf-8').trim();
    return null;
  } finally {
    for (const f of [oggPath, wavPath, path.join(AUDIO_DIR, `${ts}.txt`)]) {
      try { fs.unlinkSync(f); } catch {}
    }
  }
}

// ─── Allowlist ──────────────────────────────────────────────────
function isAllowed(jid) {
  if (config.ALLOWED_NUMBERS.length === 0) return false;
  const number = jid.replace(/:.*@/, '@');
  return config.ALLOWED_NUMBERS.includes(number);
}

// ─── Session recovery ───────────────────────────────────────────
let reconnectAttempts = 0;
const MAX_RECONNECTS = 3;

function clearAuthState() {
  log('Clearing expired session... Please scan QR code again.');
  try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  reconnectAttempts = 0;
}

// ─── Main daemon ────────────────────────────────────────────────
let activeSock = null;

async function startDaemon() {
  // Clean up previous socket to prevent ghost listeners
  if (activeSock) {
    try { activeSock.ev.removeAllListeners(); activeSock.ws.close(); } catch {}
    activeSock = null;
  }

  log('Starting agent...');

  for (const dir of [config.LOG_DIR, HISTORY_DIR, AUTH_DIR, AUDIO_DIR, config.FILES_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    generateHighQualityLinkPreview: false
  });
  activeSock = sock;

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      log('Scan QR code with WhatsApp (Settings > Linked Devices > Link a Device):');
      qrcode.generate(qr, { small: true });
      reconnectAttempts = 0;
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      log(`Connection closed (status: ${statusCode}, shouldReconnect: ${shouldReconnect})`);

      // Status 401 = logged out — session is truly dead
      if (statusCode === 401 || statusCode === DisconnectReason.loggedOut) {
        clearAuthState();
        startDaemon();
        return;
      }

      // Status 440/515 = session needs refresh, just reconnect (don't clear auth)
      if (shouldReconnect) {
        reconnectAttempts++;
        if (reconnectAttempts >= MAX_RECONNECTS) {
          log(`Failed to reconnect after ${MAX_RECONNECTS} attempts. Clearing session.`);
          clearAuthState();
        }
        log(`Reconnecting (${reconnectAttempts}/${MAX_RECONNECTS})...`);
        setTimeout(startDaemon, 3000);
        return;
      }
    }

    if (connection === 'open') {
      log('Connected to WhatsApp!');
      reconnectAttempts = 0;
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ─── Message handler ────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      const chatId = msg.key.remoteJid;
      const fromMe = msg.key.fromMe;

      if (!isAllowed(chatId)) continue;
      if (fromMe && !config.SELF_CHAT_MODE) continue;

      const m = msg.message;
      let text = m?.conversation
        || m?.extendedTextMessage?.text
        || m?.imageMessage?.caption
        || m?.videoMessage?.caption
        || m?.documentMessage?.caption;
      const isAudio = !!(m?.audioMessage);
      const isImage = !!(m?.imageMessage);
      const isVideo = !!(m?.videoMessage);

      // Transcribe voice notes
      if (isAudio) {
        log('Voice note received, transcribing...');
        try {
          const transcription = await transcribeAudio(msg, sock);
          if (!transcription) continue;
          text = `[Voice note] ${transcription}`;
          log(`Transcription: ${text.substring(0, 80)}...`);
        } catch (err) {
          log(`Transcription error: ${err.message}`);
          await sock.sendMessage(chatId, { text: 'Could not understand the voice note. Please try again or type your message.' });
          continue;
        }
      }

      // Download and pass images to Claude (vision)
      if (isImage) {
        log('Image received, downloading...');
        try {
          const imgBuffer = await downloadMediaMessage(msg, 'buffer', {}, {
            logger: pino({ level: 'silent' }),
            reuploadRequest: sock.updateMediaMessage
          });
          const imgPath = path.resolve(AUDIO_DIR, `img_${Date.now()}.jpg`);
          fs.writeFileSync(imgPath, imgBuffer);
          const caption = text || '';
          text = `[Image at: ${imgPath}] Read the image with your Read tool and analyze it. ${caption ? 'Caption: ' + caption : 'No caption provided, describe what you see.'}`;
        } catch (err) {
          log(`Image download error: ${err.message}`);
          if (!text) text = '[Image sent but could not be downloaded]';
        }
      }

      // Download videos: extract frames + transcribe audio
      if (isVideo) {
        log('Video received, downloading...');
        try {
          const vidBuffer = await downloadMediaMessage(msg, 'buffer', {}, {
            logger: pino({ level: 'silent' }),
            reuploadRequest: sock.updateMediaMessage
          });
          const ts = Date.now();
          const vidPath = path.resolve(AUDIO_DIR, `vid_${ts}.mp4`);
          fs.writeFileSync(vidPath, vidBuffer);
          log(`Video downloaded: ${vidBuffer.length} bytes`);

          // Extract 4 evenly spaced frames
          const framesDir = path.resolve(AUDIO_DIR, `frames_${ts}`);
          fs.mkdirSync(framesDir, { recursive: true });
          try {
            execSync(`ffmpeg -i "${vidPath}" -vf "select='eq(n\\,0)+eq(n\\,30)+eq(n\\,60)+eq(n\\,90)',setpts=N/FRAME_RATE/TB" -frames:v 4 "${framesDir}/frame_%02d.jpg" -y 2>&1`, { timeout: 30000 });
          } catch {
            execSync(`ffmpeg -i "${vidPath}" -vf "fps=1/2" -frames:v 4 "${framesDir}/frame_%02d.jpg" -y 2>&1`, { timeout: 30000 });
          }

          // Extract and transcribe audio track
          let audioTranscription = '';
          const wavPath = path.resolve(AUDIO_DIR, `vid_audio_${ts}.wav`);
          try {
            execSync(`ffmpeg -i "${vidPath}" -vn -ar 16000 -ac 1 "${wavPath}" -y 2>&1`, { timeout: 30000 });
            const wavSize = fs.statSync(wavPath).size;
            if (wavSize > 1000) {
              execSync(`whisper "${wavPath}" --model base --output_format txt --output_dir "${AUDIO_DIR}" 2>&1`, { encoding: 'utf-8', timeout: 60000 });
              const txtPath = path.resolve(AUDIO_DIR, `vid_audio_${ts}.txt`);
              if (fs.existsSync(txtPath)) {
                audioTranscription = fs.readFileSync(txtPath, 'utf-8').trim();
                try { fs.unlinkSync(txtPath); } catch {}
              }
            }
            try { fs.unlinkSync(wavPath); } catch {}
          } catch (e) {
            log(`Video audio extraction: ${e.message}`);
            try { fs.unlinkSync(wavPath); } catch {}
          }

          const frames = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort();
          const framePaths = frames.map(f => path.join(framesDir, f));
          const caption = text || '';

          let vidParts = [];
          if (framePaths.length > 0) {
            const frameList = framePaths.map((fp, i) => `Frame ${i + 1}: ${fp}`).join('\n');
            vidParts.push(`[Video frames]\n${frameList}\nRead each frame with your Read tool.`);
          }
          if (audioTranscription) {
            vidParts.push(`[Video audio transcription] ${audioTranscription}`);
            log(`Video audio transcribed: ${audioTranscription.substring(0, 80)}...`);
          }
          if (caption) vidParts.push(`Caption: ${caption}`);
          if (vidParts.length === 0 && !caption) vidParts.push('[Video sent but could not be processed]');

          text = vidParts.join('\n') + '\nAnalyze both the visual frames and audio content of this video.';

          try { fs.unlinkSync(vidPath); } catch {}
        } catch (err) {
          log(`Video processing error: ${err.message}`);
          if (!text) text = '[Video sent but could not be processed]';
        }
      }

      if (!text) continue;

      // Skip daemon's own messages (prevent loops)
      if (fromMe && (text.startsWith('Error processing') || text.startsWith('Could not understand'))) continue;

      // Commands
      if (text.toLowerCase() === '/ping') {
        await sock.sendMessage(chatId, { text: 'Pong! Agent is running.' });
        continue;
      }
      if (text.toLowerCase() === '/clear') {
        saveHistory(chatId, []);
        await sock.sendMessage(chatId, { text: 'Conversation history cleared.' });
        continue;
      }

      let cleanupPaths = [];
      if (isImage) {
        const imgMatch = text.match(/\[Image at: ([^\]]+)\]/);
        if (imgMatch) cleanupPaths.push(imgMatch[1]);
      }
      if (isVideo) {
        const framePaths = (text.match(/Frame \d+: (.+)/g) || []).map(m => m.replace(/Frame \d+: /, ''));
        cleanupPaths.push(...framePaths);
        if (framePaths[0]) cleanupPaths.push(path.dirname(framePaths[0]));
      }

      messageQueue.push({ chatId, text, fromMe, wasAudio: isAudio, cleanupPaths });
      processQueue(sock);
    }
  });
}

// ─── Prevent Baileys internal crashes from killing the process ──
process.on('uncaughtException', (err) => {
  if (err.isBoom || err.message?.includes('Connection Closed')) {
    log(`Baileys internal error (handled): ${err.message}`);
    return;
  }
  log(`Uncaught exception: ${err.message}`);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  log(`Unhandled rejection (handled): ${err?.message || err}`);
});

// ─── Start ──────────────────────────────────────────────────────
validateConfig();
startDaemon().catch((err) => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
