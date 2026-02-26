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
const NOISE = ['Closing session', 'SessionEntry', 'Decrypted message', 'Bad MAC', 'Failed to decrypt', 'Session error', 'Closing open session', 'pendingPreKey', 'registrationId', 'ephemeralKeyPair', '_chains', 'chainKey', 'rootKey', 'baseKey'];
const isNoise = (msg) => NOISE.some(p => (msg || '').includes(p));
const _log = console.log;
const _err = console.error;
const _warn = console.warn;
console.log = (...a) => { if (!isNoise(a[0]?.toString())) _log(...a); };
console.error = (...a) => { if (!isNoise(a[0]?.toString())) _err(...a); };
console.warn = (...a) => { if (!isNoise(a[0]?.toString())) _warn(...a); };

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
function getHistory(chatId) {
  const file = path.join(HISTORY_DIR, `${chatId}.json`);
  if (!fs.existsSync(file)) return [];
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return []; }
}

function saveHistory(chatId, history) {
  const file = path.join(HISTORY_DIR, `${chatId}.json`);
  fs.writeFileSync(file, JSON.stringify(history.slice(-config.MAX_HISTORY), null, 2));
}

// ─── Message queue (sequential processing) ──────────────────────
const messageQueue = [];
let processing = false;

async function processQueue(sock) {
  if (processing || messageQueue.length === 0) return;
  processing = true;

  while (messageQueue.length > 0) {
    const { chatId, text, fromMe, wasAudio } = messageQueue.shift();
    try {
      await sock.presenceSubscribe(chatId);
      await sock.sendPresenceUpdate('composing', chatId);
      log(`Processing: ${text.substring(0, 80)}...`);

      const history = getHistory(chatId);
      const response = await askClaude(text, history);

      await sock.sendPresenceUpdate('paused', chatId);

      // Voice reply
      const shouldSendAudio = config.VOICE_REPLY_MODE === 'always'
        || (config.VOICE_REPLY_MODE === 'auto' && wasAudio);

      if (shouldSendAudio && config.ELEVENLABS_API_KEY) {
        try {
          log('Generating voice response...');
          const audioPath = await textToSpeech(response);
          const audioBuffer = fs.readFileSync(audioPath);
          await sock.sendMessage(chatId, { audio: audioBuffer, mimetype: 'audio/ogg; codecs=opus', ptt: true });
          try { fs.unlinkSync(audioPath); } catch {}
          log('Voice sent.');
        } catch (ttsErr) {
          log(`TTS failed, sending text: ${ttsErr.message}`);
          await sendTextChunks(sock, chatId, response);
        }
      } else {
        await sendTextChunks(sock, chatId, response);
      }

      // Detect file attachments [FILE:/path/to/file.pdf]
      const fileMatches = response.match(/\[FILE:([^\]]+)\]/g);
      if (fileMatches) {
        for (const match of fileMatches) {
          const filePath = match.replace('[FILE:', '').replace(']', '').trim();
          if (fs.existsSync(filePath)) {
            const fileBuffer = fs.readFileSync(filePath);
            const fileName = path.basename(filePath);
            const ext = path.extname(filePath).toLowerCase();
            const mimeTypes = { '.pdf': 'application/pdf', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg' };
            await sock.sendMessage(chatId, { document: fileBuffer, mimetype: mimeTypes[ext] || 'application/octet-stream', fileName });
            log(`File sent: ${fileName}`);
          }
        }
      }

      history.push({ text, fromMe, reply: response, timestamp: Date.now() });
      saveHistory(chatId, history);
      log(`Response sent (${response.length} chars)`);
    } catch (err) {
      log(`Error: ${err.message}`);
      try { await sock.sendPresenceUpdate('paused', chatId); } catch {}
      try { await sock.sendMessage(chatId, { text: 'Error processing your message. Please try again.' }); } catch {}
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
    if (buffer.length < 100) throw new Error('Downloaded audio is empty or corrupt');

    execSync(`ffmpeg -i "${oggPath}" -ar 16000 -ac 1 "${wavPath}" -y 2>/dev/null`);
    execSync(`whisper "${wavPath}" --model base --output_format txt --output_dir "${AUDIO_DIR}" 2>/dev/null`, { encoding: 'utf-8', timeout: 60000 });

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
async function startDaemon() {
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

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      log('Scan QR code with WhatsApp (Settings > Linked Devices > Link a Device):');
      qrcode.generate(qr, { small: true });
      reconnectAttempts = 0;
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;

      // Status 440 = session expired, 401 = logged out
      if (statusCode === 440 || statusCode === 401 || statusCode === DisconnectReason.loggedOut) {
        clearAuthState();
        startDaemon();
        return;
      }

      reconnectAttempts++;
      if (reconnectAttempts >= MAX_RECONNECTS) {
        log(`Failed to reconnect after ${MAX_RECONNECTS} attempts.`);
        clearAuthState();
        startDaemon();
        return;
      }

      log(`Connection closed (status: ${statusCode}). Reconnecting (${reconnectAttempts}/${MAX_RECONNECTS})...`);
      setTimeout(startDaemon, 5000);
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

      if (isVideo && !text) {
        text = '[Video sent without caption]';
      }

      if (!text) continue;

      // Skip daemon's own messages
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

      messageQueue.push({ chatId, text, fromMe, wasAudio: isAudio });
      processQueue(sock);
    }
  });
}

// ─── Start ──────────────────────────────────────────────────────
validateConfig();
startDaemon().catch((err) => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
