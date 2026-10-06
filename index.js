/**
 * Farmaline WhatsApp Bridge (Baileys) — deploy on Railway.
 *
 * Connects a WhatsApp number via Baileys, forwards every incoming farmer
 * message to the Farmaline AI agent edge function, and replies with the
 * agent's answer. The agent resolves the farmer from their phone number,
 * so the farmer gets their own farms, orders, soil and weather data.
 *
 * Env vars (set in Railway):
 *   SUPABASE_URL            https://<ref>.supabase.co
 *   SUPABASE_ANON_KEY       publishable/anon key
 *   WHATSAPP_BRIDGE_SECRET  same secret configured on the backend
 *   AUTH_DIR                (optional) session folder, default ./auth
 *   PORT                    (optional) health/QR server port
 */
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import QR from 'qrcode';
import http from 'node:http';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const BRIDGE_SECRET = process.env.WHATSAPP_BRIDGE_SECRET;
const AUTH_DIR = process.env.AUTH_DIR || './auth';
const PORT = process.env.PORT || 3000;
const BRIDGE_VERSION = '1.4.0';
/** Bot's own WhatsApp number in international digits, e.g. 919876500000.
 *  When set, the bridge prints an 8-char PAIRING CODE instead of needing a QR. */
const PAIRING_NUMBER = (process.env.PAIRING_NUMBER || '').replace(/\D/g, '');

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !BRIDGE_SECRET) {
  console.error('Missing SUPABASE_URL / SUPABASE_ANON_KEY / WHATSAPP_BRIDGE_SECRET');
  process.exit(1);
}

const AGENT_URL = `${SUPABASE_URL}/functions/v1/ai-agent`;
const DISEASE_URL = `${SUPABASE_URL}/functions/v1/disease-detection`;

/** In-memory conversation history per chat (last 10 turns). */
const history = new Map();
const greeted = new Set();
let lastQR = null;
let connected = false;
let pairingCode = null;
let botNumber = null;
let starting = false;

async function publishBotNumber(number, attempt = 1) {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/bot-config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'x-bridge-secret': BRIDGE_SECRET,
      },
      body: JSON.stringify({ botNumber: number }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`${res.status}: ${body}`);
    console.log(`Published WhatsApp assistant number +${number} to Farmaline.`);
  } catch (error) {
    console.log(`bot-config publication attempt ${attempt} failed:`, error?.message || error);
    if (attempt < 5) {
      setTimeout(() => publishBotNumber(number, attempt + 1), attempt * 5000);
    }
  }
}

function incomingIdentity(msg) {
  const replyJid = msg.key.remoteJid;
  // Newer WhatsApp accounts may deliver an opaque @lid as remoteJid while
  // remoteJidAlt contains the sender's real phone-number JID.
  const identityJid = msg.key.remoteJidAlt || replyJid;
  const phone = (identityJid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
  return { replyJid, phone };
}

/** IDs of messages this bridge sent, so self-chat testing never loops. */
const ownSent = new Set();

async function sendText(sock, jid, text) {
  if (!connected) throw new Error('WhatsApp connection is not open yet');
  const sent = await sock.sendMessage(jid, { text });
  if (sent?.key?.id) {
    ownSent.add(sent.key.id);
    if (ownSent.size > 500) ownSent.delete(ownSent.values().next().value);
  }
  return sent;
}

function pushHistory(jid, role, content) {
  const turns = history.get(jid) || [];
  turns.push({ role, content });
  history.set(jid, turns.slice(-10));
}

/** Phones already known to belong to a Farmaline account. */
const linkedPhones = new Set();
/** Unlinked chats already told once — after that we stay silent. */
const notifiedUnlinked = new Set();

async function askAgent(jid, phone, text, extra = {}) {
  const res = await fetch(AGENT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'x-bridge-secret': BRIDGE_SECRET,
      'x-language': 'en',
    },
    body: JSON.stringify({
      phone,
      message: text,
      ...extra,
      context: { channel: 'whatsapp', currentPage: 'whatsapp' },
      conversationHistory: history.get(jid) || [],
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (data.error === 'not_linked') return { linked: false, text: data.response };
  if (!res.ok) return { linked: true, text: data.error || 'Sorry, something went wrong. Please try again.' };
  if (phone) linkedPhones.add(phone);
  return { linked: true, text: data.response || 'Sorry, I could not answer that.' };
}

async function diagnoseImage(base64, phone) {
  const res = await fetch(DISEASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'x-bridge-secret': BRIDGE_SECRET,
    },
    body: JSON.stringify({ imageBase64: base64 }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return null;
  return data;
}

function messageText(msg) {
  const m = msg.message || {};
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ''
  ).trim();
}

async function start() {
  if (starting) return;
  starting = true;
  let state;
  let saveCreds;
  try {
    ({ state, saveCreds } = await useMultiFileAuthState(AUTH_DIR));
  } catch (error) {
    starting = false;
    throw error;
  }

  // Keep the socket configuration minimal. Extra browser/history/cache hooks
  // caused current WhatsApp notification payloads to enter legacy decoders.
  const sock = makeWASocket({ auth: state });
  starting = false;

  sock.ev.on('creds.update', saveCreds);

  // Pairing-code login (no QR): set PAIRING_NUMBER to the bot's own number.
  if (PAIRING_NUMBER && !state.creds.registered && !pairingCode) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(PAIRING_NUMBER);
        pairingCode = code;
        console.log('\n==============================');
        console.log(`WHATSAPP PAIRING CODE: ${code}`);
        console.log('WhatsApp → Linked devices → Link with phone number instead');
        console.log('==============================\n');
      } catch (e) {
        console.error('pairing code request failed:', e?.message || e);
      }
    }, 4000);
  }

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      lastQR = qr;
      if (!PAIRING_NUMBER) {
        console.log('Open /qr on your deployment to scan. Terminal QR below (may be unreadable):');
        qrcode.generate(qr, { small: true });
      }
    }
    if (connection === 'open') {
      connected = true;
      lastQR = null;
      pairingCode = null;
      const connectedNumber = (sock.user?.id || '').split(':')[0].split('@')[0].replace(/\D/g, '');
      botNumber = PAIRING_NUMBER || connectedNumber || null;
      console.log(`Farmaline bridge v${BRIDGE_VERSION} connected. Bot number: ${botNumber || 'unknown'}`);
      console.log('Farmers can now message this number.');

      // Publish the bot number to the backend so the app can show it to farmers.
      if (botNumber) {
        publishBotNumber(botNumber);

        // Self-chat note: confirms the link and shows the number farmers should save.
        const selfJid = `${botNumber}@s.whatsapp.net`;
        sendText(
          sock,
          selfJid,
          `Farmaline bridge connected ✅\n\nBot number: +${botNumber}\nFarmers: save this number and send any message — you'll get a "Hi from Farmaline 👋" welcome, then the AI assistant answers weather, mandi prices, crop photos, orders and more.`,
        ).catch((e) => console.log('self-chat note failed (non-fatal):', e?.message || e));
      }
    }
    if (connection === 'close') {
      connected = false;
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      // 515 = restart required right after pairing; it's expected, just reconnect.
      console.log('Connection closed.', code, loggedOut ? '(logged out)' : '(reconnecting)');
      if (!loggedOut) setTimeout(() => start().catch(console.error), 3000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      const { replyJid: jid, phone } = incomingIdentity(msg);
      if (!jid) continue;
      // Skip only messages this bridge itself sent; allow self-chat testing
      // (messages you type to your own number arrive with fromMe: true).
      if (msg.key.fromMe) {
        const selfChat = botNumber && jid.startsWith(`${botNumber}@`);
        if (!selfChat || ownSent.has(msg.key.id)) continue;
      }
      if (jid.endsWith('@g.us') || jid === 'status@broadcast') continue;

      const text = messageText(msg);
      const isImage = Boolean(msg.message?.imageMessage);
      const audioMsg = msg.message?.audioMessage;
      const isAudio = Boolean(audioMsg);

      if (!text && !isImage && !isAudio) continue;

      let step = 'received';
      try {
        // Only registered Farmaline users get the assistant. Unknown numbers
        // are told once what to do, then ignored (no welcome, no AI replies).
        if (!linkedPhones.has(phone)) {
          step = 'link check';
          const probe = await askAgent(jid, phone, text || (isAudio ? 'voice note' : 'photo'));
          if (!probe.linked) {
            if (!notifiedUnlinked.has(jid)) {
              notifiedUnlinked.add(jid);
              await sendText(sock, jid, probe.text);
            }
            continue;
          }
        }

        step = 'presence';
        // Presence can fail before the profile name is synced — never fatal.
        try {
          await sock.sendPresenceUpdate('composing', jid);
        } catch {}


        // First-time greeting so the farmer knows they reached Farmaline
        // and can save this WhatsApp number as the assistant.
        if (!greeted.has(jid)) {
          step = 'welcome';
          greeted.add(jid);
          const welcome =
            `Hi from Farmaline! 👋\n\n` +
            `Save this number — it's your Farmaline assistant on WhatsApp.\n\n` +
            `You can:\n` +
            `• Send a photo of your crop for disease/pest check\n` +
            `• Ask weather, mandi prices, schemes, soil advice\n` +
            `• Track orders and get recommendations\n\n` +
            `Just reply in your language. How can I help you today?`;
          await sendText(sock, jid, welcome);
          pushHistory(jid, 'assistant', welcome);
        }

        // Voice note → transcribe on the backend, then answer.
        if (isAudio) {
          step = 'download audio';
          const buffer = await downloadMediaMessage(msg, 'buffer', {});
          const mime = audioMsg.mimetype || 'audio/ogg';
          const format = mime.includes('mp4') || mime.includes('m4a')
            ? 'm4a'
            : mime.includes('mpeg') || mime.includes('mp3')
              ? 'mp3'
              : mime.includes('wav')
                ? 'wav'
                : 'ogg';
          step = 'agent request (voice)';
          const reply = await askAgent(jid, phone, text || '', {
            audioBase64: buffer.toString('base64'),
            audioFormat: format,
          });
          pushHistory(jid, 'user', text || '[voice note]');
          pushHistory(jid, 'assistant', reply.text);
          step = 'send agent reply (voice)';
          await sendText(sock, jid, reply.text);
          continue;
        }

        // Photo → crop disease detection, then let the agent explain it.
        if (isImage) {
          step = 'download image';
          const buffer = await downloadMediaMessage(msg, 'buffer', {});
          const base64 = `data:image/jpeg;base64,${buffer.toString('base64')}`;
          step = 'disease detection';
          const diag = await diagnoseImage(base64, phone);
          if (diag?.disease) {
            const d = diag.disease;
            const treat = diag.treatments || d.treatments;
            const summary =
              `*${d.name || 'Result'}*` +
              (d.severity ? ` (${d.severity})` : '') +
              (d.confidence ? ` — ${d.confidence}% confidence` : '') +
              (diag.plantIdentified ? `\nPlant: ${diag.plantIdentified}` : '') +
              (d.description ? `\n${d.description}` : '') +
              (Array.isArray(treat) && treat.length
                ? `\n\n*Treatment*\n${treat.slice(0, 4).map((t) => `• ${typeof t === 'string' ? t : t.name || t.treatment || ''}`).join('\n')}`
                : '');
            step = 'send diagnosis';
            await sendText(sock, jid, summary);
            pushHistory(jid, 'assistant', summary);
          }
          const follow = text || 'I sent a photo of my crop. What should I do next?';
          pushHistory(jid, 'user', follow);
          step = 'agent request';
          const reply = await askAgent(jid, phone, follow);
          pushHistory(jid, 'assistant', reply.text);
          step = 'send agent reply';
          await sendText(sock, jid, reply.text);
          continue;
        }

        pushHistory(jid, 'user', text);
        step = 'agent request';
        const reply = await askAgent(jid, phone, text);
        pushHistory(jid, 'assistant', reply.text);
        step = 'send agent reply';
        await sendText(sock, jid, reply.text);
      } catch (err) {
        console.error(
          `Farmaline bridge v${BRIDGE_VERSION} handler failed at "${step}" for ${phone || 'unknown sender'} (${jid}):`,
          err?.message || err,
          err?.stack || '',
        );
        try {
          if (connected) await sendText(sock, jid, 'Sorry, I hit an error. Please send your message again.');
        } catch {}
      }
    }
  });
}

// Railway needs an open port; also exposes the pairing QR + status.
http
  .createServer(async (req, res) => {
    const path = (req.url || '/').split('?')[0];

    // Scannable QR image (PNG) — open this in a browser and scan with WhatsApp.
    if (path === '/qr.png') {
      if (!lastQR) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(connected ? 'Already connected.' : 'QR not ready yet, retry in a few seconds.');
        return;
      }
      const png = await QR.toBuffer(lastQR, { width: 512, margin: 2 });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(png);
      return;
    }

    // Raw QR string (for manual tooling).
    if (path === '/qr.txt') {
      res.writeHead(lastQR ? 200 : 404, { 'Content-Type': 'text/plain' });
      res.end(lastQR || 'no qr');
      return;
    }

    // Plain pairing code (8 chars) — use with "Link with phone number instead".
    if (path === '/pair' || path === '/code') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ version: BRIDGE_VERSION, connected, pairingCode, botNumber }));
      return;
    }

    // HTML page that auto-refreshes until paired.
    if (path === '/qr') {
      const body = connected
        ? `<h1>Connected ✅</h1><p>Bot number: <b>${botNumber || 'unknown'}</b><br/>Farmers can message this number now.</p>`
        : pairingCode
          ? `<h1>Pairing code</h1>
             <p>WhatsApp → Linked devices → <b>Link with phone number instead</b></p>
             <div style="font-size:44px;letter-spacing:6px;font-weight:700">${pairingCode}</div>`
        : lastQR
          ? `<h1>Scan with WhatsApp</h1>
             <p>WhatsApp → Linked devices → Link a device</p>
             <img src="/qr.png?t=${Date.now()}" width="320" height="320" alt="WhatsApp pairing QR" />`
          : `<h1>Waiting…</h1><p>This page refreshes automatically.</p>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta http-equiv="refresh" content="${connected ? 30 : 12}"/>
<title>Farmaline WhatsApp Bridge</title></head>
<body style="font-family:system-ui,sans-serif;text-align:center;padding:32px;background:#faf7f0;color:#2c2418">
${body}
</body></html>`);
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ ok: true, version: BRIDGE_VERSION, connected, botNumber, pairingCode, awaitingQR: Boolean(lastQR) }),
    );
  })
  .listen(PORT, () => console.log(`Farmaline bridge v${BRIDGE_VERSION} health server on :${PORT} — open /qr to pair`));

console.log(`Starting Farmaline WhatsApp bridge v${BRIDGE_VERSION} from ${import.meta.url}`);
start().catch((e) => {
  console.error('bridge failed to start', e);
  process.exit(1);
});
