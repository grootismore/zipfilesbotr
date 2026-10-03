# ZipFiles Bot

Telegram bot: send separate files → get one ZIP back.

## Setup

1. Open [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
2. Install and run (Node 18+):

```bash
npm install
BOT_TOKEN=123456:ABC... npm start
```

3. Optional – in BotFather use `/setcommands`:

```
start - How to use
zip - Zip collected files (optional name)
list - Show collected files
clear - Start over
```

## Usage

- Send documents, photos, videos, audio or voice notes.
- Tap **📦 Zip** or send `/zip my-archive` to name the ZIP.
- `/list` shows what's queued, `/clear` resets.

## Limits (Telegram Bot API)

- 20 MB max per incoming file, 50 MB max for the ZIP the bot sends back.
- Collected files are forgotten after 1 hour of inactivity.
- Sessions are in memory, so a restart clears them.

## Hosting

Needs a long-running Node process (Railway, Render, Fly.io, a VPS). It uses long polling, so no webhook or public URL is required.
Cloudflare Workers is a poor fit here because of its 128 MB memory limit and lack of disk.
