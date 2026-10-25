import 'dotenv/config';
import express from 'express';
import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, Browsers
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const BOT_NAME = process.env.BOT_NAME || 'RIO X MD';
const PREFIX = (process.env.PREFIX || '.').trim() || '.';
const API_KEY = process.env.PAIRING_API_KEY || '';
const SESSION_ROOT = path.join(__dirname, 'sessions');
fs.mkdirSync(SESSION_ROOT, { recursive: true });

const app = express();
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));
const sessions = new Map(); // sessionId -> { sock, qr, pairCode, status, phone, starting }
const cooldowns = new Map();

function safeId(value) {
  return /^[a-f0-9]{24}$/.test(String(value || ''));
}
function authRequired(req, res, next) {
  if (!API_KEY || req.get('x-api-key') !== API_KEY) {
    return res.status(401).json({ error: 'Set PAIRING_API_KEY and send it in the x-api-key header.' });
  }
  next();
}
function sessionPath(id) { return path.join(SESSION_ROOT, id); }

async function startSession(id, phone = '') {
  const current = sessions.get(id);
  if (current?.starting) return current;
  if (current?.sock && current.status === 'connected') return current;

  const record = current || { sock: null, qr: null, pairCode: null, status: 'starting', phone, starting: false };
  record.starting = true;
  record.status = 'starting';
  record.phone = phone || record.phone || '';
  sessions.set(id, record);

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath(id));
  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: Browsers.ubuntu(BOT_NAME),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false
  });
  record.sock = sock;
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async (update) => {
    if (update.qr) {
      record.qr = update.qr;
      record.status = 'waiting_for_scan';
    }
    if (update.connection === 'open') {
      record.status = 'connected';
      record.qr = null;
      record.pairCode = null;
      record.starting = false;
    }
    if (update.connection === 'close') {
      const statusCode = update.lastDisconnect?.error?.output?.statusCode;
      record.starting = false;
      record.status = statusCode === DisconnectReason.loggedOut ? 'logged_out' : 'disconnected';
      record.sock = null;
      if (statusCode !== DisconnectReason.loggedOut) {
        setTimeout(() => startSession(id, record.phone).catch(console.error), 2500);
      }
    }
  });
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try { await handleMessage(sock, msg); }
      catch (err) { console.error('Message handler error:', err?.message || err); }
    }
  });

  if (phone && !state.creds.registered) {
    // Wait briefly for the socket to initialize before requesting a pairing code.
    setTimeout(async () => {
      try {
        if (!state.creds.registered && record.sock === sock) {
          record.pairCode = await sock.requestPairingCode(phone);
          record.status = 'waiting_for_pair';
        }
      } catch (err) {
        record.status = 'pair_error';
        record.error = 'Could not generate pair code. Check the number and try again.';
        console.error('Pair code error:', err?.message || err);
      }
    }, 1800);
  }
  return record;
}

function unwrapMessage(message) {
  let m = message || {};
  while (m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message) {
    m = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message;
  }
  return m;
}
function getText(msg) {
  const m = unwrapMessage(msg.message);
  return m.conversation
    || m.extendedTextMessage?.text
    || m.imageMessage?.caption
    || m.videoMessage?.caption
    || m.buttonsResponseMessage?.selectedButtonId
    || m.templateButtonReplyMessage?.selectedId
    || m.listResponseMessage?.singleSelectReply?.selectedRowId
    || m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson
    || '';
}
function menuSections() {
  return [
    { title: 'MEDIA MENU', rows: [
      { title: 'Sticker help', rowId: `${PREFIX}sticker`, description: 'How to create a sticker' },
      { title: 'Image tools', rowId: `${PREFIX}media`, description: 'Media command guide' }
    ]},
    { title: 'GENERAL MENU', rows: [
      { title: 'Ping', rowId: `${PREFIX}ping`, description: 'Check bot response' },
      { title: 'Runtime', rowId: `${PREFIX}runtime`, description: 'Show uptime' },
      { title: 'About bot', rowId: `${PREFIX}about`, description: 'Bot information' }
    ]},
    { title: 'GROUP MENU', rows: [
      { title: 'Group info', rowId: `${PREFIX}groupinfo`, description: 'Show current group details' },
      { title: 'Admin commands', rowId: `${PREFIX}grouphelp`, description: 'Group command guide' }
    ]},
    { title: 'OWNER MENU', rows: [
      { title: 'Bot status', rowId: `${PREFIX}status`, description: 'Connection and version status' }
    ]}
  ];
}
async function sendMenu(sock, jid) {
  const caption = `╭─「 ${BOT_NAME} 」\n│ Welcome! Select a category or send a command.\n│ Prefix: ${PREFIX}\n╰────────────\nButtons/list support can vary by WhatsApp client; text commands remain available.`;
  try {
    await sock.sendMessage(jid, {
      text: caption,
      title: `${BOT_NAME} MENU`,
      footer: 'RIO X MD • Select a command',
      buttonText: 'OPEN MENU',
      sections: menuSections()
    });
  } catch {
    await sock.sendMessage(jid, { text: `${caption}\n\n${PREFIX}ping\n${PREFIX}runtime\n${PREFIX}about\n${PREFIX}media\n${PREFIX}grouphelp` });
  }
}
async function handleMessage(sock, msg) {
  if (!msg.message || msg.key.fromMe) return;
  const jid = msg.key.remoteJid;
  if (!jid || jid === 'status@broadcast') return;
  const text = getText(msg).trim();
  if (!text) return;

  // If the client returns JSON for a native-flow selection, attempt to read its command id.
  let commandText = text;
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      commandText = parsed.id || parsed.selectedId || parsed.selectedButtonId || text;
    } catch {}
  }
  if (!commandText.startsWith(PREFIX)) {
    if (/^(menu|help)$/i.test(commandText)) await sendMenu(sock, jid);
    return;
  }
  const [rawCommand, ...args] = commandText.slice(PREFIX.length).trim().split(/\s+/);
  const command = (rawCommand || '').toLowerCase();
  const now = Date.now();
  const key = `${jid}:${command}`;
  if (cooldowns.has(key) && now - cooldowns.get(key) < 700) return;
  cooldowns.set(key, now);

  switch (command) {
    case 'menu':
    case 'help':
      return sendMenu(sock, jid);
    case 'ping':
      return sock.sendMessage(jid, { text: '🏓 Pong! RIO X MD is responding.' }, { quoted: msg });
    case 'runtime': {
      const seconds = Math.floor(process.uptime());
      const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
      return sock.sendMessage(jid, { text: `⏱️ Runtime: ${h}h ${m}m ${s}s` }, { quoted: msg });
    }
    case 'about':
      return sock.sendMessage(jid, { text: `🤖 ${BOT_NAME}\nA multi-session WhatsApp MD starter.\nPrefix: ${PREFIX}\nCommands: ${PREFIX}menu, ${PREFIX}ping, ${PREFIX}runtime, ${PREFIX}media, ${PREFIX}grouphelp` }, { quoted: msg });
    case 'media':
    case 'sticker':
      return sock.sendMessage(jid, { text: `🎨 MEDIA MENU\n${PREFIX}sticker — sticker help\n${PREFIX}media — media command guide\n\nMedia conversion plugins can be added in the plugins/ folder.` }, { quoted: msg });
    case 'grouphelp':
      return sock.sendMessage(jid, { text: `👥 GROUP MENU\n${PREFIX}groupinfo — current group details\n\nAdmin moderation commands are intentionally not enabled until you configure and test permissions.` }, { quoted: msg });
    case 'groupinfo': {
      if (!jid.endsWith('@g.us')) return sock.sendMessage(jid, { text: 'This command only works in groups.' }, { quoted: msg });
      const meta = await sock.groupMetadata(jid);
      return sock.sendMessage(jid, { text: `👥 ${meta.subject}\nMembers: ${meta.participants.length}\nGroup ID: ${jid}` }, { quoted: msg });
    }
    case 'status':
      return sock.sendMessage(jid, { text: `✅ ${BOT_NAME}\nStatus: connected\nNode: ${process.version}` }, { quoted: msg });
    default:
      return sock.sendMessage(jid, { text: `❔ Unknown command: ${PREFIX}${command}\nSend ${PREFIX}menu to view commands.` }, { quoted: msg });
  }
}

// Pairing API is intentionally protected by an API key. Never expose an open pairing endpoint.
app.post('/api/session', authRequired, async (req, res) => {
  const phone = String(req.body?.phone || '').replace(/\D/g, '');
  if (phone.length < 8 || phone.length > 15) return res.status(400).json({ error: 'Enter a valid international phone number with country code, digits only.' });
  const id = crypto.randomBytes(12).toString('hex');
  try {
    await startSession(id, phone);
    res.json({ id, status: 'starting', message: 'Keep this page open and check status in a few seconds.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not start a session.' });
  }
});
app.get('/api/session/:id', authRequired, async (req, res) => {
  const { id } = req.params;
  if (!safeId(id)) return res.status(400).json({ error: 'Invalid session id.' });
  const record = sessions.get(id);
  if (!record) return res.status(404).json({ error: 'Session not found on this server instance.' });
  let qrDataUrl = null;
  if (record.qr) {
    try { qrDataUrl = await QRCode.toDataURL(record.qr, { margin: 1, width: 260 }); } catch {}
  }
  res.json({ id, status: record.status, phone: record.phone, pairCode: record.pairCode, qrDataUrl, error: record.error || null });
});
app.get('/health', (_req, res) => res.json({ ok: true, bot: BOT_NAME, activeSessions: sessions.size }));
app.listen(PORT, () => console.log(`${BOT_NAME} pairing site listening on port ${PORT}`));
