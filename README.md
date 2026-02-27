# claude-code-agent-wa

A WhatsApp AI agent powered by your **Claude Code CLI subscription**. Zero API tokens needed.

```
WhatsApp ←→ Baileys ←→ Node.js ←→ claude -p (subscription) ←→ Response ←→ WhatsApp
                                       ↑                            ↓
                                   Whisper (STT)            ElevenLabs (TTS)
```

## Features

- **Text chat** — Send a message, get an AI response with full project context
- **Voice notes** — Whisper transcribes incoming audio, Claude responds, ElevenLabs speaks back
- **Image vision** — Send an image, Claude sees and analyzes it
- **PDF generation** — Ask for a proposal/quote, get a professional PDF delivered via WhatsApp
- **Conversation history** — Remembers the last 20 messages per chat
- **File attachments** — Claude can create and send files (PDF, HTML, images)
- **Typing indicator** — Shows "typing..." while processing
- **Auto-reconnect** — Recovers from disconnections and expired sessions automatically

## How It Works

This agent uses `claude -p` (the Claude Code CLI in print mode) which runs on your **existing Claude Code subscription** — not API tokens. Every message is processed by the same Claude that powers Claude Code, with access to your project's `CLAUDE.md` for business context.

## Prerequisites

| Tool | Required | Notes |
|------|----------|-------|
| **Node.js 20+** | Yes | `node --version` |
| **Claude Code CLI** | Yes | `claude --version` — requires active subscription |
| **ffmpeg** | For voice | `brew install ffmpeg` / `apt install ffmpeg` |
| **Whisper** | For voice | `pip install openai-whisper` (local, free) |
| **ElevenLabs API key** | For voice replies | Optional — get one at elevenlabs.io |
| **Google Chrome** | For PDFs | Optional — for HTML→PDF conversion |

## Quick Start

```bash
# 1. Clone
git clone https://github.com/universomarin/claude-code-agent-wa.git
cd claude-code-agent-wa

# 2. Install
npm install

# 3. Configure
cp .env.example .env
# Edit .env with your WhatsApp number and preferences

# 4. Run
npm start
```

On first run, scan the QR code with WhatsApp (**Settings > Linked Devices > Link a Device**).

## Configuration

Edit `.env` to customize:

| Variable | Default | Description |
|----------|---------|-------------|
| `WHATSAPP_NUMBERS` | — | **Required.** Your number(s), comma-separated, without `+` |
| `SYSTEM_PROMPT` | Generic assistant | Customize the AI personality and instructions |
| `CLAUDE_MODEL` | `sonnet` | `sonnet` (fast, ~10s) or `opus` (smart, ~60s) |
| `PROJECT_DIR` | `.` | Working directory — point to a folder with `CLAUDE.md` for context |
| `ELEVENLABS_API_KEY` | — | Optional. Enables voice responses |
| `ELEVENLABS_VOICE_ID` | — | Optional. ElevenLabs voice to use |
| `VOICE_REPLY_MODE` | `auto` | `auto` (voice→voice), `always`, or `never` |
| `CLAUDE_CLI_PATH` | auto-detected | Override path to `claude` binary |
| `CHROME_PATH` | OS default | Path to Chrome/Chromium for PDF generation |
| `SELF_CHAT_MODE` | `true` | Respond to your own messages from another device |
| `MAX_HISTORY` | `20` | Messages to keep per conversation |
| `CLAUDE_TIMEOUT` | `300000` | Timeout in ms (5 min default) |

## Commands

Send these in WhatsApp:

| Command | Action |
|---------|--------|
| `/ping` | Check if the agent is running |
| `/clear` | Clear conversation history |

## Important: WhatsApp Session

This agent connects to WhatsApp as a **linked device** (like WhatsApp Web). Keep in mind:

- **If you remove linked devices** from your phone (Settings > Linked Devices), the agent's session is revoked. You must delete `auth_info/` and restart to scan a new QR code.
- **Only one Baileys-based service** can be connected to your WhatsApp at a time. If you have another bot (e.g., OpenClaw), disconnect it first — otherwise they will conflict and create message loops.
- **The `auth_info/` folder** contains your WhatsApp session keys. Do not share it. If compromised, remove the linked device from your phone immediately.
- **If your computer sleeps or loses internet**, the agent reconnects automatically. But after long disconnections, WhatsApp may expire the session — just delete `auth_info/` and re-scan.

## Troubleshooting

**QR code keeps appearing / status 440 loop**
Session expired. The agent handles this automatically — it clears the old session and shows a new QR code. If stuck, manually run `rm -rf auth_info/` and restart.

**Agent doesn't respond after restarting**
Your WhatsApp session may be stale. Delete `auth_info/` and restart to get a fresh QR code.

**Claude times out**
Increase `CLAUDE_TIMEOUT` in `.env` or switch to `CLAUDE_MODEL=sonnet` for faster responses.

**Voice notes not working**
Make sure `ffmpeg` and `whisper` are installed and in your PATH. Run `ffmpeg -version` and `whisper --help` to verify.

**Message loops (agent keeps replying to itself)**
Another bot is connected to your WhatsApp and generating messages. Disconnect it first, then restart the agent.

**"Waiting for message" on phone**
Normal WhatsApp multi-device behavior. The message is sent — your phone just takes a moment to decrypt it. Check WhatsApp Web to confirm.

**"Cannot be launched inside another Claude Code session"**
The agent is being started from within Claude Code. The agent handles this automatically, but if it happens, set `CLAUDECODE=` in your environment before running.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     WhatsApp                              │
└────────┬──────────────────┬──────────────────┬───────────┘
         │ Text             │ Voice            │ Image
         ▼                  ▼                  ▼
┌──────────────────────────────────────────────────────────┐
│                  Baileys (Node.js)                        │
│  QR auth · Allowlist · Queue · Typing · Auto-reconnect   │
└────────┬──────────────────┬──────────────────┬───────────┘
         │                  │                  │
         │           ┌──────▼──────┐    ┌──────▼──────┐
         │           │   Whisper   │    │  Download   │
         │           │  (local)    │    │  to disk    │
         │           └──────┬──────┘    └──────┬──────┘
         │                  │ text             │ path
         ▼                  ▼                  ▼
┌──────────────────────────────────────────────────────────┐
│              Claude Code CLI (claude -p)                   │
│         Uses your SUBSCRIPTION — zero API tokens          │
│         Reads CLAUDE.md · Full tool access                │
└──────────────────────────┬───────────────────────────────┘
                           │ response
              ┌────────────┴────────────┐
              │                         │
        If text input            If voice input
              │                         │
              ▼                         ▼
    ┌──────────────┐      ┌───────────────────┐
    │  Text reply   │      │   ElevenLabs TTS  │
    │  via WhatsApp │      │   → Voice note    │
    └──────────────┘      └───────────────────┘
```

## Security

**Read this before running the agent.**

This agent uses `--dangerously-skip-permissions` to allow Claude Code to read/write files and run commands without interactive approval. This is necessary for autonomous operation but means:

- **Claude has full access** to read, write, and execute within your `PROJECT_DIR`
- **Only add your own number** to `WHATSAPP_NUMBERS`. Anyone on the allowlist can trigger Claude actions on your machine
- **Do not point `PROJECT_DIR`** to sensitive directories (home dir, `/`, etc.). Use a dedicated project folder
- **Do not run as root**. Use a regular user account
- **Conversation history and logs** are stored in plaintext. Keep the agent directory secure

**Best practices:**

1. Use a dedicated, sandboxed directory for `PROJECT_DIR`
2. Keep the allowlist minimal — only trusted numbers
3. Run on a machine you control, not a shared server
4. Review `logs/agent.log` periodically
5. If you stop using the agent, delete `auth_info/` to revoke the WhatsApp session

## Disclaimer

This project uses [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial WhatsApp Web API library. It is **not affiliated with or endorsed by WhatsApp or Meta**. Use responsibly and at your own risk. Do not use for spam or automated mass messaging.

## License

MIT — see [LICENSE](LICENSE)

---

Built by [@universomarin](https://github.com/universomarin)
