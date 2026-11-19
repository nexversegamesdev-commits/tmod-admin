// tmod admin server: licensing, devices, bans and Telegram admin bot.
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID || '5172079937');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || './data.json';
const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

if (!BOT_TOKEN || !ADMIN_TOKEN) {
  console.error('BOT_TOKEN and ADMIN_TOKEN env vars are required');
  process.exit(1);
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SEED_KEYS = ['K7QM4XT2', 'R9PB3ZWD', 'H5NC8YFA', 'T4LW6KQS', 'M8JD2VXR'];

function freshKeys() {
  return SEED_KEYS.map((key) => ({ key, usedBy: null, usedAt: 0, createdAt: 0 }));
}

let state = { devices: [], keys: freshKeys(), bannedKeys: [], bannedHwids: [] };
try {
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  state = Object.assign(state, saved);
} catch (e) {
  // fresh start
}
if (!Array.isArray(state.keys) || !state.keys.length) state.keys = freshKeys();

function save() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('save failed', e);
  }
}

function norm(v) {
  return String(v == null ? '' : v).trim().toUpperCase();
}

function findKey(key) {
  const k = norm(key);
  return state.keys.find((item) => norm(item.key) === k);
}

function isBanned(hwid, key) {
  const h = norm(hwid);
  const k = norm(key);
  return (h && state.bannedHwids.map(norm).includes(h)) ||
    (k && state.bannedKeys.map(norm).includes(k));
}

function newKey() {
  for (;;) {
    let key = '';
    const bytes = crypto.randomBytes(8);
    for (let i = 0; i < 8; i++) key += ALPHABET[bytes[i] % ALPHABET.length];
    if (!findKey(key)) {
      state.keys.push({ key, usedBy: null, usedAt: 0, createdAt: Date.now() });
      return key;
    }
  }
}

async function tg(method, payload) {
  const res = await fetch(`${TG}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return res.json().catch(() => ({}));
}

function replyToAdmin(text, markup) {
  return tg('sendMessage', { chat_id: ADMIN_ID, text, reply_markup: markup });
}

function deviceButtons(d) {
  return {
    inline_keyboard: [[
      { text: '🚫 Бан HWID', callback_data: 'bh:' + d.hwid },
      { text: '🚫 Бан ключ', callback_data: 'bk:' + d.key }
    ]]
  };
}

function deviceText(d) {
  return `Ключ активирован\nКлюч: ${d.key}\nУстройство: ${d.model}\nAndroid: ${d.android}\nHWID: ${d.hwid}\nIP: ${d.ip}`;
}

async function handleActivation(body, ip) {
  const key = norm(body.key);
  const hwid = norm(body.hwid);
  if (!key || !hwid) return { ok: false, error: 'invalid' };
  if (isBanned(hwid, key)) return { ok: false, error: 'banned' };
  const entry = findKey(key);
  if (!entry) return { ok: false, error: 'invalid' };
  if (entry.usedBy && norm(entry.usedBy) !== hwid) return { ok: false, error: 'used' };
  entry.usedBy = hwid;
  entry.usedAt = entry.usedAt || Date.now();

  const record = {
    key,
    hwid,
    model: String(body.model || '?'),
    android: String(body.android || '?'),
    ip,
    ts: Date.now()
  };
  const existing = state.devices.find((d) => norm(d.hwid) === hwid);
  if (existing) {
    Object.assign(existing, record);
  } else {
    state.devices.push(record);
  }
  save();
  await replyToAdmin(deviceText(record), deviceButtons(record));
  return { ok: true };
}

function handleCheck(hwid, key) {
  const h = norm(hwid);
  const k = norm(key);
  if (isBanned(h, k)) return { banned: true, reason: 'ban' };
  if (!k) return { banned: false };
  const entry = findKey(k);
  if (!entry) return { banned: true, reason: 'revoked' };
  if (entry.usedBy && norm(entry.usedBy) !== h) return { banned: true, reason: 'used' };
  return { banned: false };
}

async function handleCallback(q) {
  if (String(q.from && q.from.id) !== ADMIN_ID) return;
  const data = String(q.data || '');
  const [action, ...rest] = data.split(':');
  const value = rest.join(':');
  if (action === 'bh') {
    if (!state.bannedHwids.map(norm).includes(norm(value))) state.bannedHwids.push(value);
    save();
    await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'HWID забанен' });
    await replyToAdmin(`🚫 HWID забанен:\n${value}`);
  } else if (action === 'bk') {
    if (!state.bannedKeys.map(norm).includes(norm(value))) state.bannedKeys.push(value);
    save();
    await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Ключ забанен' });
    await replyToAdmin(`🚫 Ключ забанен:\n${value}`);
  } else if (action === 'ub') {
    state.bannedKeys = state.bannedKeys.filter((k) => norm(k) !== norm(value));
    state.bannedHwids = state.bannedHwids.filter((h) => norm(h) !== norm(value));
    save();
    await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Разбанен' });
    await replyToAdmin(`✅ Разбанен:\n${value}`);
  }
}

async function handleMessage(msg) {
  if (String(msg.chat && msg.chat.id) !== ADMIN_ID) return;
  const text = String(msg.text || '').trim();
  const parts = text.split(/\s+/);
  const cmd = (parts[0] || '').toLowerCase();

  if (cmd === '/start' || cmd === '/help') {
    await replyToAdmin(
      'Команды:\n/newkey [N] — создать ключи\n/keys — свободные ключи\n' +
      '/keys all — все ключи\n/delkey <KEY> — удалить ключ (отзыв)\n' +
      '/devices — устройства\n/bans — бан-лист\n' +
      'Кнопки под устройством: бан HWID / бан ключа');
  } else if (cmd === '/newkey') {
    let count = parseInt(parts[1] || '1', 10);
    if (!count || count < 1) count = 1;
    if (count > 20) count = 20;
    const created = [];
    for (let i = 0; i < count; i++) created.push(newKey());
    save();
    await replyToAdmin('Новые ключи:\n' + created.map((k) => '• ' + k).join('\n'));
  } else if (cmd === '/keys') {
    const all = (parts[1] || '').toLowerCase() === 'all';
    const list = state.keys.filter((k) => all || !k.usedBy);
    if (!list.length) return replyToAdmin(all ? 'Ключей нет.' : 'Свободных ключей нет.');
    const lines = list.slice(-60).map((k) => {
      const status = k.usedBy ? 'занят' : 'свободен';
      return `${k.key} — ${status}`;
    });
    await replyToAdmin((all ? 'Все ключи' : 'Свободные ключи') + ':\n' + lines.join('\n'));
  } else if (cmd === '/delkey') {
    const key = norm(parts[1] || '');
    if (!key) return replyToAdmin('Использование: /delkey K7QM4XT2');
    const before = state.keys.length;
    state.keys = state.keys.filter((k) => norm(k.key) !== key);
    save();
    await replyToAdmin(state.keys.length < before
      ? `🗑 Ключ удалён: ${key}` : `Ключ не найден: ${key}`);
  } else if (cmd === '/devices') {
    if (!state.devices.length) return replyToAdmin('Устройств пока нет.');
    for (const d of state.devices.slice(-20)) {
      await replyToAdmin(deviceText(d), deviceButtons(d));
    }
  } else if (cmd === '/bans') {
    const rows = [];
    for (const k of state.bannedKeys) rows.push([{ text: '✅ ' + k, callback_data: 'ub:' + k }]);
    for (const h of state.bannedHwids) rows.push([{ text: '✅ ' + h.slice(0, 16) + '…', callback_data: 'ub:' + h }]);
    if (!rows.length) return replyToAdmin('Бан-лист пуст.');
    await replyToAdmin('Бан-лист (нажми, чтобы разбанить):', { inline_keyboard: rows });
  }
}

async function poll() {
  let offset = 0;
  for (;;) {
    try {
      const res = await fetch(`${TG}/getUpdates?timeout=25&offset=${offset}`);
      const json = await res.json();
      for (const u of json.result || []) {
        offset = u.update_id + 1;
        if (u.message) await handleMessage(u.message);
        if (u.callback_query) await handleCallback(u.callback_query);
      }
    } catch (e) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

function json(res, code, data) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/') {
    return json(res, 200, {
      ok: true,
      devices: state.devices.length,
      keys: state.keys.length,
      banned: state.bannedKeys.length + state.bannedHwids.length
    });
  }
  if (req.method === 'GET' && url.pathname === '/check') {
    return json(res, 200, handleCheck(url.searchParams.get('hwid'), url.searchParams.get('key')));
  }
  if (req.method === 'GET' && url.pathname === '/devices') {
    if (url.searchParams.get('token') !== ADMIN_TOKEN) return json(res, 403, { error: 'forbidden' });
    return json(res, 200, state);
  }
  if (req.method === 'POST' && url.pathname === '/activate') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10000) req.destroy();
    });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}');
        const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
          (req.socket.remoteAddress || '?');
        const result = await handleActivation(data, ip);
        json(res, 200, result);
      } catch (e) {
        json(res, 400, { ok: false, error: 'bad request' });
      }
    });
    return;
  }
  json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log('tmod admin listening on ' + PORT);
  poll();
});
