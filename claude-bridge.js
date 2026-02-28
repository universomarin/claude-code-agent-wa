const { spawn } = require('child_process');
const config = require('./config');

function buildPrompt(message, history) {
  let prompt = config.SYSTEM_PROMPT + '\n\n';

  // PDF/file generation instructions
  prompt += `If asked to create a file (PDF, proposal, quote, etc.):\n`;
  prompt += `1. Create a professional HTML file in ${config.FILES_DIR}/\n`;
  prompt += `2. Convert to PDF: "${config.CHROME_PATH}" --headless --disable-gpu --print-to-pdf=${config.FILES_DIR}/name.pdf --no-pdf-header-footer ${config.FILES_DIR}/name.html\n`;
  prompt += `3. Include the path at the end: [FILE:${config.FILES_DIR}/name.pdf]\n`;
  prompt += `4. The file will be sent automatically via WhatsApp.\n\n`;

  if (history && history.length > 0) {
    prompt += 'Recent conversation history:\n';
    // Only send last 10 messages, truncate long ones to keep prompt lean
    for (const msg of history.slice(-10)) {
      const userText = msg.text.length > 500 ? msg.text.substring(0, 500) + '...' : msg.text;
      prompt += `User: ${userText}\n`;
      if (msg.reply) {
        const replyText = msg.reply.length > 500 ? msg.reply.substring(0, 500) + '...' : msg.reply;
        prompt += `Assistant: ${replyText}\n`;
      }
    }
    prompt += '\n';
  }

  prompt += `Current message: ${message}\n\nRespond:`;
  return prompt;
}

function askClaude(message, history) {
  const prompt = buildPrompt(message, history);

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const maxTurns = config.MAX_TURNS || 25;
    const args = ['-p', '--dangerously-skip-permissions', '--max-turns', String(maxTurns)];
    if (config.CLAUDE_MODEL) args.push('--model', config.CLAUDE_MODEL);

    const proc = spawn(config.CLAUDE_PATH, args, {
      cwd: config.PROJECT_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: config.CLAUDE_TIMEOUT,
      env: { ...process.env, CLAUDECODE: '' }
    });

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`claude exit ${code}: ${stderr.substring(0, 500)}`));
      }
      resolve(stdout.trim());
    });

    proc.on('error', (err) => reject(err));

    // Send prompt via stdin (avoids argument length limits and escaping issues)
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

module.exports = { askClaude };
