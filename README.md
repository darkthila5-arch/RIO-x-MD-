# RIO X MD

A starter WhatsApp MD bot with interactive list menus, text command handling, QR/pair-code pairing portal, per-session auth folders, and GitHub Actions syntax checks.

## Requirements
- Node.js 20+
- A host that supports a persistent Node process and persistent disk for `sessions/`
- WhatsApp account owner consent for every linked session

## Run locally
```bash
cp .env.example .env
# Edit .env and set a long random PAIRING_API_KEY
npm install
npm start
```
Open `http://localhost:3000`. Enter the same `PAIRING_API_KEY` configured in `.env`.

## Deploy
1. Create a GitHub repository and upload these files.
2. Add `.env` values as host environment variables. Never commit `.env` or `sessions/`.
3. Deploy the Node service to a host that supports persistent storage; set the service start command to `npm start` and expose port `3000` (or the platform's `PORT`).
4. Ensure the `sessions/` directory is on a persistent private disk. Ephemeral server storage will lose linked sessions on restart.
5. The GitHub Actions CI workflow checks syntax on push/PR. For automatic Render deploys, create a Render Web Service, copy its Deploy Hook URL, then add it in GitHub repository Settings → Secrets and variables → Actions as `RENDER_DEPLOY_HOOK`. The included deploy workflow triggers that hook on pushes to `main`. Configure Render with build command `npm install`, start command `npm start`, and a persistent disk mounted where `sessions/` is stored. Never commit the deploy hook.

## Commands
- `.menu` / `.help` — menu
- `.ping` — response test
- `.runtime` — uptime
- `.about` — bot info
- `.media` / `.sticker` — media help
- `.groupinfo` — group details
- `.grouphelp` — group help
- `.status` — status

Menus use WhatsApp list-message support where available and text-command fallback otherwise. WhatsApp client/library changes can affect interactive message rendering, so test with your own account before public use.

## Security
- Set a strong `PAIRING_API_KEY`; pairing endpoints reject requests without it.
- Do not expose this key publicly or commit it to GitHub.
- Session folders contain WhatsApp authentication keys. Do not share, publish, or upload them.
- Each new pairing creates a separate session folder. For production multi-user service, add a database-backed session registry, rate limits, session ownership/authentication, cleanup, monitoring, and persistent encrypted storage before opening it to the public.
- Use only with account-owner permission. Avoid spam/bulk messaging and follow WhatsApp's terms. Baileys is an unofficial WhatsApp Web client and may break when WhatsApp changes.
