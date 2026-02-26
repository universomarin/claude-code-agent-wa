require('dotenv').config();
const { execSync } = require('child_process');

// Auto-detect claude CLI path
let claudePath = 'claude';
try {
  claudePath = execSync('which claude', { encoding: 'utf-8' }).trim();
} catch {
  // Will use 'claude' and hope it's in PATH
}

module.exports = {
  // WhatsApp numbers allowed to interact (comma-separated in .env, without + or spaces)
  ALLOWED_NUMBERS: (process.env.WHATSAPP_NUMBERS || '')
    .split(',')
    .filter(Boolean)
    .map(n => n.includes('@') ? n : `${n}@s.whatsapp.net`),

  // Working directory for Claude Code (where your CLAUDE.md lives)
  PROJECT_DIR: process.env.PROJECT_DIR || process.cwd(),

  // Conversation history
  MAX_HISTORY: parseInt(process.env.MAX_HISTORY || '20'),

  // Claude Code CLI
  CLAUDE_TIMEOUT: parseInt(process.env.CLAUDE_TIMEOUT || '300000'), // 5 min
  CLAUDE_MODEL: process.env.CLAUDE_MODEL || 'sonnet',
  CLAUDE_PATH: process.env.CLAUDE_CLI_PATH || claudePath,

  // System prompt for the AI assistant
  SYSTEM_PROMPT: process.env.SYSTEM_PROMPT ||
    'You are a helpful AI assistant on WhatsApp. Be concise, direct, and action-oriented. Do not use heavy markdown (no code blocks, no tables). Use *bold* and simple lists when needed.',

  // Self-chat mode: respond to your own messages sent from another device
  SELF_CHAT_MODE: process.env.SELF_CHAT_MODE !== 'false',

  // Logging
  LOG_DIR: process.env.LOG_DIR || './logs',

  // ElevenLabs TTS (optional)
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY || '',
  ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID || '',

  // Voice reply mode: 'auto' (reply audio to audio), 'always', 'never'
  VOICE_REPLY_MODE: process.env.VOICE_REPLY_MODE || 'auto',

  // Chrome path for PDF generation (optional)
  CHROME_PATH: process.env.CHROME_PATH || (
    process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : process.platform === 'win32'
        ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
        : '/usr/bin/google-chrome'
  ),

  // Directory for generated files (PDFs, etc.)
  FILES_DIR: process.env.FILES_DIR || './files',
};
