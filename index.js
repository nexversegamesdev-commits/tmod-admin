// tmod admin server: licensing, devices, bans and Telegram admin bot (button UI).
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ENV_ADMINS = String(process.env.ADMIN_ID || '5172079937,6514446862')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || './data.json';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const DATA_REPO = process.env.DATA_REPO;
const DATA_PATH = process.env.DATA_PATH || 'data.json';
const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

if (!BOT_TOKEN || !ADMIN_TOKEN) {
  console.error('BOT_TOKEN and ADMIN_TOKEN env vars are required');
  process.exit(1);
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LICENSE_SECRET = process.env.LICENSE_SECRET || 'tmod-lic-7f3a91c2d84b';
const PLANS = [
  { id: '7', days: 7, price: '$1' },
  { id: '30', days: 30, price: '$3' },
  { id: 'forever', days: 0, price: '$5' }
];
const FREE_COMMENTS = [
  '@GreiTikTok реально удобный мод 🔥',
  'С авто прогревом аккаунта намного удобнее, особенно через @GreiTikTok',
  'Автопрогрев — имба, @GreiTikTok',
  '@GreiTikTok стоит попробовать 👀',
  'Кто ещё не пробовал @GreiTikTok с авто прогревом?'
];
const ALLOWED_BUILDS = String(process.env.ALLOWED_BUILDS || '')
  .split(',').map((b) => b.trim()).filter(Boolean);
const BUILD_ENFORCE = process.env.BUILD_ENFORCE === '1';
const XROCKET_KEY = process.env.XROCKET_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhcHBJZCI6IjMxMDM2MyIsImp0aSI6ImFwcDozMTAzNjM6YzkzYmQ5MDItYjFjYS00M2EzLTgwYjctZTRmYTY2NTczN2VmIiwiaWF0IjoxNzk1MTY1Njk3fQ.kJ4mBlhaFh1fuGYFfaIwSH8OANd2BJi7FYb5aI527Tk';
const XROCKET_BASE = process.env.XROCKET_BASE || 'https://pay.xrocket.tg';
const REFERRAL_BONUS = 0.1;
const PLAN_PRICE = { '7': 1, '30': 3, forever: 5 };
const FREE_COOLDOWN_MS = 14 * 86400000;
const RESET_PRICE = 0.5;
let BOT_USERNAME = '';

function buildAllowed(build) {
  if (!BUILD_ENFORCE || !ALLOWED_BUILDS.length) return true;
  return ALLOWED_BUILDS.includes(String(build || ''));
}
const SEED_KEYS = [
  'Q2M7XK4P', 'R8TZ3WNF', 'B5YK9HJD', 'V6NX2QSL', 'C9PM4RTW',
  'D3QW8ZKX', 'F7HJ2MBN', 'G4XP9KRT', 'J6BR3VQY', 'L8MN5XZS'
];

function freshKeys() {
  return SEED_KEYS.map((key) => ({ key, usedBy: null, usedAt: 0, createdAt: 0 }));
}

let state = {
  devices: [], keys: freshKeys(), bannedKeys: [], bannedHwids: [],
  admins: [], pending: [], orders: [], promos: [], tickets: [],
  users: {}, invoices: []
};
const waiting = new Map();
try {
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  state = Object.assign(state, saved);
} catch (e) {
  // fresh start
}
if (!Array.isArray(state.keys) || !state.keys.length) state.keys = freshKeys();
if (!Array.isArray(state.admins)) state.admins = [];
if (!Array.isArray(state.pending)) state.pending = [];
if (!Array.isArray(state.orders)) state.orders = [];
if (!Array.isArray(state.promos)) state.promos = [];
if (!Array.isArray(state.tickets)) state.tickets = [];
if (!state.users || typeof state.users !== 'object') state.users = {};
if (!Array.isArray(state.invoices)) state.invoices = [];

function user(chatId) {
  const id = String(chatId);
  if (!state.users[id]) {
    state.users[id] = { balance: 0, referredBy: null, freeAt: 0 };
  }
  return state.users[id];
}
for (const id of ENV_ADMINS) {
  if (!state.admins.includes(id)) state.admins.push(id);
}

let lastSha = null;

function save() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('save failed', e);
  }
  if (GITHUB_TOKEN && DATA_REPO) {
    clearTimeout(save.timer);
    save.timer = setTimeout(persistRemote, 1500);
  }
}

function ghHeaders() {
  return {
    Authorization: 'token ' + GITHUB_TOKEN,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'tmod-admin'
  };
}

async function loadRemote() {
  if (!GITHUB_TOKEN || !DATA_REPO) return;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${DATA_REPO}/contents/${DATA_PATH}`,
      { headers: ghHeaders() });
    if (res.status === 200) {
      const json = await res.json();
      lastSha = json.sha;
      const text = Buffer.from(json.content, 'base64').toString('utf8');
      state = Object.assign(state, JSON.parse(text));
      console.log('state loaded from GitHub');
    }
  } catch (e) {
    console.error('remote load failed', e);
  }
}

async function persistRemote() {
  try {
    const body = {
      message: 'state ' + new Date().toISOString(),
      content: Buffer.from(JSON.stringify(state, null, 2)).toString('base64')
    };
    if (lastSha) body.sha = lastSha;
    const res = await fetch(
      `https://api.github.com/repos/${DATA_REPO}/contents/${DATA_PATH}`,
      {
        method: 'PUT',
        headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders()),
        body: JSON.stringify(body)
      });
    if (res.ok) {
      const json = await res.json();
      lastSha = json.content.sha;
    } else {
      console.error('persist failed', res.status, await res.text());
    }
  } catch (e) {
    console.error('persist error', e);
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

function newKey(days) {
  for (;;) {
    let key = '';
    const bytes = crypto.randomBytes(8);
    for (let i = 0; i < 8; i++) key += ALPHABET[bytes[i] % ALPHABET.length];
    if (!findKey(key)) {
      const now = Date.now();
      state.keys.push({
        key,
        usedBy: null,
        usedAt: 0,
        createdAt: now,
        expiresAt: days ? now + days * 86400000 : 0,
        resets: 0,
        maxResets: 1
      });
      return key;
    }
  }
}

function isExpired(entry) {
  return !!(entry && entry.expiresAt && Date.now() > entry.expiresAt);
}

function newPromo(days) {
  for (;;) {
    let code = '';
    const bytes = crypto.randomBytes(8);
    for (let i = 0; i < 8; i++) code += ALPHABET[bytes[i] % ALPHABET.length];
    if (!state.promos.find((p) => p.code === code) && !findKey(code)) {
      state.promos.push({ code, days: days || 0, usesLeft: 1, createdAt: Date.now() });
      return code;
    }
  }
}

function ticketFor(key, hwid) {
  return crypto.createHmac('sha256', LICENSE_SECRET)
    .update(key + '|' + hwid)
    .digest('hex');
}

function xrHeaders() {
  return { 'Content-Type': 'application/json', 'Rocket-Pay-Key': XROCKET_KEY };
}

async function xrCreateInvoice(amount, chatId) {
  try {
    const res = await fetch(XROCKET_BASE + '/tg-invoices', {
      method: 'POST',
      headers: xrHeaders(),
      body: JSON.stringify({
        amount,
        numPayments: 1,
        currency: 'USDT',
        description: 'GreiTikTok balance top-up',
        hiddenMessage: 'Баланс пополнен. Спасибо!',
        payload: 'topup:' + chatId,
        expiredIn: 86400
      })
    });
    const json = await res.json();
    if (json && json.data && json.data.link) return json.data;
    console.error('xrocket create failed', JSON.stringify(json).slice(0, 300));
  } catch (e) {
    console.error('xrocket create error', e.message);
  }
  return null;
}

async function xrInvoiceStatus(id) {
  try {
    const res = await fetch(XROCKET_BASE + '/tg-invoices/' + encodeURIComponent(id),
      { headers: xrHeaders() });
    const json = await res.json();
    return json && json.data ? json.data : null;
  } catch (e) {
    return null;
  }
}

function creditInvoice(invoice) {
  if (!invoice || invoice.status === 'paid') return false;
  const u = user(invoice.chatId);
  u.balance = Math.round((u.balance + invoice.amount) * 100) / 100;
  invoice.status = 'paid';
  save();
  return true;
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
  const jobs = state.admins.map((id) => tg('sendMessage', {
    chat_id: id, text, reply_markup: markup
  }));
  return Promise.all(jobs);
}

function isAdmin(id) {
  return state.admins.includes(String(id));
}

async function requestAccess(msg) {
  const id = String(msg.chat.id);
  const name = [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(' ') || 'без имени';
  const username = msg.chat.username ? '@' + msg.chat.username : '—';
  if (state.admins.includes(id)) return;
  if (state.pending.includes(id)) {
    await tg('sendMessage', {
      chat_id: id,
      text: 'Запрос на доступ уже отправлен администратору.'
    });
    return;
  }
  state.pending.push(id);
  save();
  await tg('sendMessage', {
    chat_id: id,
    text: 'Запрос на доступ отправлен администратору.'
  });
  await replyToAdmin(
    `🔔 Запрос доступа к боту\nИмя: ${name}\nUsername: ${username}\nID: ${id}`,
    {
      inline_keyboard: [[
        { text: '✅ Разрешить', callback_data: 'am:' + id },
        { text: '❌ Отклонить', callback_data: 'rj:' + id }
      ]]
    });
}

function deviceText(d) {
  return `Устройство\nКлюч: ${d.key}\nМодель: ${d.model}\nAndroid: ${d.android}\n` +
    `Регион: ${d.geo || '?'}\nСборка: ${d.build || '?'}\nHWID: ${d.hwid}\nIP: ${d.ip}`;
}

async function geoLookup(ip) {
  try {
    if (!ip || ip === '?' || ip.startsWith('10.') || ip.startsWith('192.168.')
        || ip.startsWith('127.') || ip.startsWith('172.')) return '?';
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country,region,city`);
    const json = await res.json();
    if (json && json.success) {
      return [json.country, json.region, json.city].filter(Boolean).join(', ') || '?';
    }
  } catch (e) {
    // гео недоступно
  }
  return '?';
}

function deviceButtons(index) {
  const device = state.devices[index];
  const rows = [
    [
      { text: '🚫 Бан HWID', callback_data: 'bh:' + index },
      { text: '🚫 Бан ключ', callback_data: 'bk:' + index }
    ]
  ];
  if (device && device.key) {
    rows.push([
      { text: '♻️ Сброс HWID', callback_data: 'fk:' + device.key },
      { text: '🔓 Сброс (force)', callback_data: 'frc:' + device.key }
    ]);
  }
  rows.push([{ text: '◀️ К устройствам', callback_data: 'm:devs' }]);
  return { inline_keyboard: rows };
}

async function handleActivation(body, ip, build) {
  if (!buildAllowed(build)) return { ok: false, error: 'banned' };
  const key = norm(body.key);
  const hwid = norm(body.hwid);
  if (!key || !hwid) return { ok: false, error: 'invalid' };
  if (isBanned(hwid, key)) return { ok: false, error: 'banned' };
  const entry = findKey(key);
  if (!entry) return { ok: false, error: 'invalid' };
  if (isExpired(entry)) return { ok: false, error: 'banned' };
  if (entry.usedBy && norm(entry.usedBy) !== hwid) return { ok: false, error: 'used' };
  entry.usedBy = hwid;
  entry.usedAt = entry.usedAt || Date.now();

  const geo = await geoLookup(ip);
  const record = {
    key,
    hwid,
    model: String(body.model || '?'),
    android: String(body.android || '?'),
    geo,
    build: String(build || '?'),
    ip,
    ts: Date.now()
  };
  let index = state.devices.findIndex((d) => norm(d.hwid) === hwid);
  if (index >= 0) {
    Object.assign(state.devices[index], record);
  } else {
    state.devices.push(record);
    index = state.devices.length - 1;
  }
  save();
  await replyToAdmin(deviceText(record), deviceButtons(index));
  return { ok: true, ticket: ticketFor(key, hwid) };
}

function handleCheck(hwid, key) {
  const h = norm(hwid);
  const k = norm(key);
  if (isBanned(h, k)) return { banned: true, reason: 'ban' };
  if (!k) return { banned: false };
  const entry = findKey(k);
  if (!entry) return { banned: true, reason: 'revoked' };
  if (isExpired(entry)) return { banned: true, reason: 'expired' };
  if (entry.usedBy && norm(entry.usedBy) !== h) return { banned: true, reason: 'used' };
  return { banned: false };
}

function mainMenuFor(id) {
  const rows = [
    [
      { text: '🛒 Маркет', callback_data: 'm:market' },
      { text: '💰 Баланс', callback_data: 'm:balance' }
    ],
    [
      { text: '👥 Реферальная система', callback_data: 'm:ref' },
      { text: '🆘 Поддержка', callback_data: 'm:support' }
    ],
    [{ text: 'ℹ️ Помощь', callback_data: 'm:help2' }]
  ];
  if (isAdmin(id)) {
    rows.push([{ text: '⚙️ Админ', callback_data: 'm:admin' }]);
  }
  return {
    text: 'GreiTikTok · мод для TikTok\n\nКупить ключ или получить бесплатный доступ — раздел «Маркет».',
    markup: { inline_keyboard: rows }
  };
}

function balanceMenu(chatId) {
  const u = user(chatId);
  return {
    text: `💰 Баланс\n\nДоступно: $${Number(u.balance || 0).toFixed(2)}\n\n` +
      'Ключи покупаются только с баланса. Пополните и вернитесь в «Маркет».',
    markup: {
      inline_keyboard: [
        [{ text: '➕ Пополнить', callback_data: 'm:topup' }],
        [{ text: `🔁 Сброс HWID — $${RESET_PRICE.toFixed(2)}`, callback_data: 'm:reset' }],
        [{ text: '◀️ Назад', callback_data: 'm:home' }]
      ]
    }
  };
}

function topupMenu() {
  return {
    text: '➕ Пополнение баланса\n\nВыберите сумму. Оплата через xRocket (USDT).',
    markup: {
      inline_keyboard: [
        [
          { text: '$1', callback_data: 'top:1' },
          { text: '$3', callback_data: 'top:3' },
          { text: '$5', callback_data: 'top:5' },
          { text: '$10', callback_data: 'top:10' }
        ],
        [{ text: '◀️ Назад', callback_data: 'm:balance' }]
      ]
    }
  };
}

function referralMenu(chatId) {
  const id = String(chatId);
  const u = user(chatId);
  const invited = Object.keys(state.users)
    .filter((other) => String(state.users[other].referredBy || '') === id).length;
  const link = BOT_USERNAME
    ? `https://t.me/${BOT_USERNAME}?start=ref_${id}`
    : 'ссылка появится после запуска бота';
  return {
    text: `👥 Реферальная система\n\n` +
      `Ваша ссылка:\n${link}\n\n` +
      `Приглашено: ${invited}\n` +
      `Заработано: $${(invited * REFERRAL_BONUS).toFixed(2)}\n\n` +
      `За каждого друга, который впервые зайдёт по ссылке — +$${REFERRAL_BONUS.toFixed(2)} на баланс.`,
    markup: {
      inline_keyboard: [
        [{ text: '📤 Поделиться ссылкой', url: link.startsWith('http') ? link : 'https://t.me' }],
        [{ text: '💰 Баланс', callback_data: 'm:balance' }],
        [{ text: '◀️ Назад', callback_data: 'm:home' }]
      ]
    }
  };
}

function marketMenu() {
  return {
    text: '🛒 Маркет GreiTikTok\n\n' +
      '7 дней — $1\n' +
      '30 дней — $3\n' +
      'Навсегда — $5\n\n' +
      'Оплата подключается. Пока ключ можно получить у @Ftor0_0.',
    markup: {
      inline_keyboard: [
        [{ text: '7 дней — $1', callback_data: 'plan:7' }],
        [{ text: '30 дней — $3', callback_data: 'plan:30' }],
        [{ text: 'Навсегда — $5', callback_data: 'plan:forever' }],
        [{ text: '🎁 Получить бесплатно', callback_data: 'free:get' }],
        [{ text: '🎟 Ввести промокод', callback_data: 'promo:enter' }],
        [{ text: '◀️ Назад', callback_data: 'm:home' }]
      ]
    }
  };
}

function freeMenu() {
  const rows = FREE_COMMENTS.map((c) => ([{
    text: '📋 ' + c.slice(0, 42),
    copy_text: { text: c }
  }]));
  rows.push([{ text: '📨 Отправить заявку', callback_data: 'free:req' }]);
  rows.push([{ text: '💬 Написать @Ftor0_0', url: 'https://t.me/Ftor0_0' }]);
  rows.push(backRow('m:market'));
  return {
    text: '🎁 Бесплатная подписка на 1 день\n\n' +
      'Условия: написать 15 комментариев — каждый из списка по 3 раза — ' +
      'и отправить их @Ftor0_0.\n' +
      'Бесплатный ключ можно получать раз в 2 недели.\n\n' +
      'Нажми на комментарий, чтобы скопировать его:',
    markup: { inline_keyboard: rows }
  };
}

function adminMenu() {
  const free = state.keys.filter((k) => !k.usedBy).length;
  return {
    text: 'GreiTikTok · админ-панель\n' +
      `Устройств: ${state.devices.length}\n` +
      `Ключей: ${state.keys.length} (свободных ${free})\n` +
      `Банов: ${state.bannedKeys.length + state.bannedHwids.length}`,
    markup: {
      inline_keyboard: [
        [
          { text: '🔑 Ключи', callback_data: 'm:keys' },
          { text: '📱 Устройства', callback_data: 'm:devs' }
        ],
        [
          { text: '🚫 Бан-лист', callback_data: 'm:bans' },
          { text: '👤 Админы', callback_data: 'm:admins' }
        ],
        [
          { text: '🛒 Заявки', callback_data: 'm:orders' },
          { text: '🎟 Промокоды', callback_data: 'm:promos' }
        ],
        [
          { text: '💰 Балансы', callback_data: 'm:balances' },
          { text: '🎫 Тикеты', callback_data: 'm:tickets' }
        ],
        [
          { text: 'ℹ️ Помощь', callback_data: 'm:help' },
          { text: '◀️ Меню', callback_data: 'm:home' }
        ]
      ]
    }
  };
}

function ordersMenu() {
  const rows = [];
  const fresh = state.orders.filter((o) => o.status === 'new').slice(-10);
  fresh.forEach((o) => {
    rows.push([
      { text: `✅ ${o.id} · ${o.days ? o.days + 'д' : '∞'} · ${o.price}`, callback_data: 'ord:' + o.id + ':ok' },
      { text: '❌ ' + o.id, callback_data: 'ord:' + o.id + ':no' }
    ]);
  });
  rows.push(backRow('m:admin'));
  const issued = state.orders.filter((o) => o.status === 'issued').length;
  return {
    text: fresh.length
      ? 'Новые заявки: ✅ выдать ключ, ❌ отменить.'
      : `Новых заявок нет. Выдано всего: ${issued}.`,
    markup: { inline_keyboard: rows }
  };
}

function promosMenu() {
  const rows = [
    [
      { text: '➕ Промокод 7 дней', callback_data: 'promo:new:7' },
      { text: '➕ 30 дней', callback_data: 'promo:new:30' }
    ],
    [{ text: '➕ Промокод навсегда', callback_data: 'promo:new:0' }]
  ];
  state.promos.slice(-15).forEach((p) => {
    rows.push([{
      text: `🗑 ${p.code} · ${p.days ? p.days + 'д' : '∞'} · осталось ${p.usesLeft}`,
      callback_data: 'promo:del:' + p.code
    }]);
  });
  rows.push(backRow('m:admin'));
  return {
    text: state.promos.length ? 'Промокоды (тап — удалить):' : 'Промокодов нет.',
    markup: { inline_keyboard: rows }
  };
}

function ticketsMenu() {
  const rows = [];
  state.tickets.filter((t) => t.status !== 'closed').slice(-10).forEach((t) => {
    rows.push([
      { text: `✍️ #${t.id} ${t.username ? '@' + t.username : ''}`, callback_data: 'sup:' + t.id + ':reply' },
      { text: '✅ ' + t.id, callback_data: 'sup:' + t.id + ':close' }
    ]);
  });
  rows.push(backRow('m:admin'));
  return {
    text: state.tickets.some((t) => t.status !== 'closed')
      ? 'Открытые тикеты:'
      : 'Открытых тикетов нет.',
    markup: { inline_keyboard: rows }
  };
}

function balancesMenu() {
  const rows = [];
  Object.keys(state.users).slice(-10).forEach((id) => {
    const u = state.users[id];
    rows.push([
      { text: `👤 ${id} · $${Number(u.balance || 0).toFixed(2)}`, callback_data: 'nop' },
      { text: '➕$1', callback_data: 'bal:' + id + ':1' },
      { text: '➕$5', callback_data: 'bal:' + id + ':5' }
    ]);
  });
  rows.push(backRow('m:admin'));
  return {
    text: Object.keys(state.users).length
      ? 'Балансы пользователей (➕ — начислить вручную):'
      : 'Пользователей пока нет.',
    markup: { inline_keyboard: rows }
  };
}

function adminsMenu() {
  const rows = state.admins.map((id) => [{
    text: '🗑 ' + id,
    callback_data: 'rmadm:' + id
  }]);
  rows.push(backRow('m:admin'));
  return {
    text: 'Админы бота (нажми ID, чтобы снять доступ):',
    markup: { inline_keyboard: rows }
  };
}

function keysMenu() {
  const free = state.keys.filter((k) => !k.usedBy).length;
  return {
    text: `Ключи\nВсего: ${state.keys.length}\nСвободных: ${free}`,
    markup: {
      inline_keyboard: [
        [
          { text: '➕ Создать ключ', callback_data: 'k:new' },
          { text: '➕ Создать ×5', callback_data: 'k:new5' }
        ],
        [
          { text: '⏳ 7 дней', callback_data: 'k:new7' },
          { text: '⏳ 30 дней', callback_data: 'k:new30' }
        ],
        [
          { text: '📋 Свободные', callback_data: 'k:free' },
          { text: '📋 Все ключи', callback_data: 'k:all' }
        ],
        [{ text: '◀️ Назад', callback_data: 'm:admin' }]
      ]
    }
  };
}

function backRow(target) {
  return [{ text: '◀️ Назад', callback_data: target }];
}

function devicesMenu() {
  const rows = [];
  state.devices.slice(-10).forEach((d, i) => {
    const idx = state.devices.length - Math.min(10, state.devices.length) + i;
    rows.push([{
      text: `📱 ${String(d.model).slice(0, 28)} · ${d.key}`,
      callback_data: 'd:' + idx
    }]);
  });
  rows.push(backRow('m:admin'));
  return {
    text: state.devices.length ? 'Устройства (последние 10):' : 'Устройств пока нет.',
    markup: { inline_keyboard: rows }
  };
}

function bansMenu() {
  const rows = [];
  state.bannedKeys.forEach((_, i) => {
    rows.push([{ text: '✅ ' + state.bannedKeys[i], callback_data: 'ub:sk:' + i }]);
  });
  state.bannedHwids.forEach((_, i) => {
    rows.push([{ text: '✅ ' + String(state.bannedHwids[i]).slice(0, 18) + '…', callback_data: 'ub:sh:' + i }]);
  });
  rows.push(backRow('m:admin'));
  const total = state.bannedKeys.length + state.bannedHwids.length;
  return {
    text: total ? 'Бан-лист (нажми, чтобы разбанить):' : 'Бан-лист пуст.',
    markup: { inline_keyboard: rows }
  };
}

async function show(cbq, menu) {
  const chatId = cbq.message.chat.id;
  const messageId = cbq.message.message_id;
  await tg('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: menu.text,
    reply_markup: menu.markup,
    disable_web_page_preview: true
  });
}

async function handleCallback(q) {
  const admin = isAdmin(q.from && q.from.id);
  const data = String(q.data || '');
  try {
    if (data === 'm:home') return show(q, mainMenuFor(q.from.id));
    if (data === 'm:market') return show(q, marketMenu());
    if (data === 'free:get') return show(q, freeMenu());
    if (data === 'm:balance') return show(q, balanceMenu(q.from.id));
    if (data === 'm:topup') return show(q, topupMenu());
    if (data === 'm:ref') return show(q, referralMenu(q.from.id));
    if (data === 'm:reset') {
      waiting.set(String(q.from.id), { action: 'reset' });
      return show(q, {
        text: '🔁 Сброс HWID\n\nОтправьте ключ, который нужно отвязать от устройства.\n' +
          `Первый сброс бесплатный, далее $${RESET_PRICE.toFixed(2)} с баланса.`,
        markup: { inline_keyboard: [backRow('m:balance')] }
      });
    }
    if (data.startsWith('top:check:')) {
      const id = data.slice(10);
      const inv = state.invoices.find((i) => i.id === id
        && String(i.chatId) === String(q.from.id));
      if (!inv) return show(q, topupMenu());
      if (inv.status !== 'paid') {
        const remote = await xrInvoiceStatus(inv.id);
        if (remote && remote.status === 'paid') creditInvoice(inv);
      }
      if (inv.status === 'paid') {
        return show(q, {
          text: `✅ Баланс пополнен на $${Number(inv.amount).toFixed(2)}.\n` +
            `Текущий баланс: $${Number(user(q.from.id).balance).toFixed(2)}`,
          markup: {
            inline_keyboard: [
              [{ text: '🛒 В маркет', callback_data: 'm:market' }],
              backRow('m:balance')
            ]
          }
        });
      }
      return show(q, {
        text: 'Оплата пока не поступила. Если уже оплатили — подождите минуту и нажмите снова.',
        markup: {
          inline_keyboard: [
            [{ text: '✅ Я оплатил', callback_data: 'top:check:' + id }],
            backRow('m:balance')
          ]
        }
      });
    }
    if (data.startsWith('top:')) {
      const amount = Number(data.slice(4));
      if (!amount || amount <= 0) return show(q, topupMenu());
      const invoice = await xrCreateInvoice(amount, q.from.id);
      if (!invoice) {
        return show(q, {
          text: 'Оплата временно недоступна. Попробуйте позже или напишите @Ftor0_0.',
          markup: { inline_keyboard: [backRow('m:topup')] }
        });
      }
      state.invoices.push({
        id: String(invoice.id),
        chatId: q.from.id,
        amount,
        status: 'active',
        link: invoice.link
      });
      save();
      return show(q, {
        text: `Счёт на $${amount.toFixed(2)} создан.\n` +
          'Оплатите по кнопке ниже, затем нажмите «Я оплатил».',
        markup: {
          inline_keyboard: [
            [{ text: '💳 Оплатить через xRocket', url: invoice.link }],
            [{ text: '✅ Я оплатил', callback_data: 'top:check:' + invoice.id }],
            backRow('m:balance')
          ]
        }
      });
    }
    if (data === 'free:req') {
      const freeUser = user(q.from.id);
      if (freeUser.freeAt && Date.now() - freeUser.freeAt < FREE_COOLDOWN_MS) {
        const next = new Date(freeUser.freeAt + FREE_COOLDOWN_MS);
        const day = next.toLocaleDateString('ru-RU');
        return show(q, {
          text: `🎁 Бесплатный ключ уже был получен.\nСледующий можно получить ${day}.`,
          markup: { inline_keyboard: [backRow('m:market')] }
        });
      }
      const order = {
        id: crypto.randomBytes(3).toString('hex'),
        days: 1,
        price: 'бесплатно',
        chatId: q.from.id,
        username: q.from.username || '',
        status: 'new',
        type: 'free',
        ts: Date.now()
      };
      state.orders.push(order);
      save();
      await replyToAdmin(
        `🎁 Заявка на бесплатный доступ #${order.id}\n` +
        `Покупатель: ${order.username ? '@' + order.username : '—'} (${order.chatId})\n` +
        'Проверьте 15 комментариев и выдайте ключ на 1 день.',
        {
          inline_keyboard: [[
            { text: '✅ Выдать 1 день', callback_data: 'ord:' + order.id + ':ok' },
            { text: '❌ Отклонить', callback_data: 'ord:' + order.id + ':no' }
          ]]
        });
      return show(q, {
        text: `Заявка #${order.id} отправлена.\n` +
          'Админ проверит ваши комментарии и выдаст ключ на 1 день прямо в этот чат.',
        markup: { inline_keyboard: [backRow('m:market')] }
      });
    }
    if (data === 'promo:enter') {
      waiting.set(String(q.from.id), { action: 'promo' });
      return show(q, {
        text: '🎟 Отправьте промокод одним сообщением — активирую ключ сразу.',
        markup: { inline_keyboard: [backRow('m:market')] }
      });
    }
    if (data === 'm:support') {
      waiting.set(String(q.from.id), { action: 'support' });
      return show(q, {
        text: '🆘 Поддержка\n\nОпишите проблему одним сообщением: установка, ключ, ИИ, бан — ответим в этот чат.',
        markup: { inline_keyboard: [backRow('m:home')] }
      });
    }
    if (data === 'm:help2') {
      return show(q, {
        text: 'tmod — мод для TikTok: автопрогрев ленты, лайки, сохранения, '
          + 'комментарии по теме и ИИ-чекер.\n\nКлючи и бесплатный доступ — в «Маркете».',
        markup: { inline_keyboard: [backRow('m:home')] }
      });
    }
    if (data.startsWith('plan:')) {
      const plan = PLANS.find((p) => p.id === data.slice(5));
      if (!plan) return show(q, marketMenu());
      const price = PLAN_PRICE[plan.id];
      const u = user(q.from.id);
      if (Number(u.balance || 0) + 1e-9 < price) {
        return show(q, {
          text: `Недостаточно средств.\n\nТариф: ${plan.days ? plan.days + ' дней' : 'навсегда'} — $${price}\n` +
            `Ваш баланс: $${Number(u.balance || 0).toFixed(2)}\n\n` +
            'Пополните баланс и вернитесь в «Маркет».',
          markup: {
            inline_keyboard: [
              [{ text: '➕ Пополнить', callback_data: 'm:topup' }],
              backRow('m:market')
            ]
          }
        });
      }
      u.balance = Math.round((u.balance - price) * 100) / 100;
      const key = newKey(plan.days);
      const entry = findKey(key);
      if (entry) entry.chatId = q.from.id;
      save();
      return show(q, {
        text: `✅ Оплачено с баланса: $${price}\n\n` +
          `Ваш ключ: ${key}\n` +
          `Тариф: ${plan.days ? plan.days + ' дней' : 'навсегда'}\n` +
          'Введите его в «Настройки → Мод клиента».',
        markup: { inline_keyboard: [backRow('m:market')] }
      });
    }
    if (!admin) return;
    if (data.startsWith('ord:')) {
      const parts = data.split(':');
      const order = state.orders.find((o) => o.id === parts[1]);
      if (!order || order.status !== 'new') {
        await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Заявка уже обработана' });
        return;
      }
      if (parts[2] === 'ok') {
        const key = newKey(order.days);
        const entry = findKey(key);
        if (entry) entry.chatId = order.chatId;
        if (order.type === 'free') user(order.chatId).freeAt = Date.now();
        order.status = 'issued';
        order.key = key;
        save();
        await tg('sendMessage', {
          chat_id: order.chatId,
          text: `Ваш ключ GreiTikTok: ${key}\nТариф: ` +
            (order.days ? order.days + ' дней' : 'навсегда') +
            '\nВведите его в «Настройки → Мод клиента».'
        });
        await replyToAdmin(`✅ Ключ выдан по заявке #${order.id}: ${key}`);
        await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Ключ выдан' });
      } else {
        order.status = 'cancelled';
        save();
        await replyToAdmin(`❌ Заявка #${order.id} отменена`);
        await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Отменено' });
      }
      return;
    }
    if (data === 'm:admin') return show(q, adminMenu());
    if (data === 'm:keys') return show(q, keysMenu());
    if (data === 'm:devs') return show(q, devicesMenu());
    if (data === 'm:bans') return show(q, bansMenu());
    if (data === 'm:admins') return show(q, adminsMenu());
    if (data === 'm:orders') return show(q, ordersMenu());
    if (data === 'm:promos') return show(q, promosMenu());
    if (data === 'm:tickets') return show(q, ticketsMenu());
    if (data === 'm:balances') return show(q, balancesMenu());
    if (data === 'nop') {
      await tg('answerCallbackQuery', { callback_query_id: q.id, text: '' });
      return;
    }
    if (data.startsWith('bal:')) {
      const parts = data.split(':');
      const target = String(parts[1]);
      const amount = Number(parts[2]);
      if (!state.users[target] || !amount) {
        await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Не найдено' });
        return show(q, balancesMenu());
      }
      const u = state.users[target];
      u.balance = Math.round((Number(u.balance || 0) + amount) * 100) / 100;
      save();
      await tg('sendMessage', {
        chat_id: target,
        text: `💰 Баланс пополнен на $${amount.toFixed(2)}.\nТекущий баланс: $${u.balance.toFixed(2)}`
      });
      await tg('answerCallbackQuery', {
        callback_query_id: q.id,
        text: 'Начислено $' + amount.toFixed(2)
      });
      return show(q, balancesMenu());
    }
    if (data.startsWith('sup:')) {
      const parts = data.split(':');
      const ticket = state.tickets.find((t) => t.id === parts[1]);
      if (!ticket) {
        await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Тикет не найден' });
        return;
      }
      if (parts[2] === 'reply') {
        waiting.set(String(q.from.id), { action: 'reply', ticketId: ticket.id });
        await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Напишите ответ сообщением' });
        return show(q, {
          text: `Тикет #${ticket.id}\n${ticket.text}\n\nОтправьте ответ одним сообщением.`,
          markup: { inline_keyboard: [backRow('m:tickets')] }
        });
      }
      ticket.status = 'closed';
      save();
      await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Тикет закрыт' });
      return show(q, ticketsMenu());
    }
    if (data.startsWith('promo:new:')) {
      const days = parseInt(data.slice(10), 10) || 0;
      const code = newPromo(days);
      save();
      return show(q, {
        text: `🎟 Промокод: ${code}\n` +
          `Тариф: ${days ? days + ' дней' : 'навсегда'}\n` +
          'Отправьте его покупателю — активирует в «Маркете».',
        markup: {
          inline_keyboard: [
            [{ text: '➕ Ещё', callback_data: 'promo:new:' + days }],
            backRow('m:promos')
          ]
        }
      });
    }
    if (data.startsWith('promo:del:')) {
      const code = norm(data.slice(10));
      state.promos = state.promos.filter((p) => norm(p.code) !== code);
      save();
      await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Промокод удалён' });
      return show(q, promosMenu());
    }
    if (data.startsWith('am:') || data.startsWith('rj:')) {
      const approve = data.startsWith('am:');
      const id = String(data.slice(3)).trim();
      state.pending = state.pending.filter((pending) => pending !== id);
      if (approve && !state.admins.includes(id)) state.admins.push(id);
      save();
      await tg('answerCallbackQuery', {
        callback_query_id: q.id,
        text: approve ? 'Доступ выдан' : 'Отклонено'
      });
      if (approve) {
        await tg('sendMessage', {
          chat_id: id,
          text: 'Доступ к админ-панели выдан. Отправь /start.'
        });
      }
      return show(q, adminsMenu());
    }
    if (data.startsWith('rmadm:')) {
      const id = String(data.slice(6)).trim();
      if (state.admins.length <= 1) {
        await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Нельзя убрать последнего админа' });
        return show(q, adminsMenu());
      }
      state.admins = state.admins.filter((admin) => admin !== id);
      save();
      await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Доступ снят' });
      return show(q, adminsMenu());
    }
    if (data === 'm:help') {
      return show(q, {
        text: 'Разделы кнопками:\n• Ключи — создание и удаление\n' +
          '• Устройства — карточка и бан по HWID/ключу\n' +
          '• Бан-лист — разбан кнопкой',
        markup: { inline_keyboard: [backRow('m:admin')] }
      });
    }
    if (data.startsWith('k:new')) {
      const count = data === 'k:new5' ? 5 : 1;
      const days = data === 'k:new7' ? 7 : data === 'k:new30' ? 30 : 0;
      const created = [];
      for (let i = 0; i < count; i++) created.push(newKey(days));
      save();
      return show(q, {
        text: (days ? `Новые ключи на ${days} дн.:\n` : 'Новые ключи (навсегда):\n') +
          created.map((k) => '• ' + k).join('\n'),
        markup: {
          inline_keyboard: [
            [{ text: '➕ Ещё', callback_data: 'k:new' }],
            backRow('m:keys')
          ]
        }
      });
    }
    if (data === 'k:free') {
      const free = state.keys.filter((k) => !k.usedBy);
      return show(q, {
        text: free.length
          ? 'Свободные ключи:\n' + free.map((k) => '• ' + k.key).join('\n')
          : 'Свободных ключей нет.',
        markup: { inline_keyboard: [backRow('m:keys')] }
      });
    }
    if (data === 'k:all') {
      const rows = [];
      state.keys.slice(-25).forEach((k) => {
        const status = k.usedBy
          ? `занят${k.resets ? ' · сбросов ' + k.resets + '/' + (k.maxResets || 1) : ''}`
          : 'свободен';
        const row = [{ text: `🗑 ${k.key} · ${status}`, callback_data: 'del:' + k.key }];
        if (k.usedBy) {
          row.push({ text: '♻️ ' + k.key, callback_data: 'fk:' + k.key });
          row.push({ text: '🔓 ' + k.key, callback_data: 'frc:' + k.key });
        }
        rows.push(row);
      });
      rows.push(backRow('m:keys'));
      return show(q, {
        text: 'Все ключи: 🗑 — удалить, ♻️ — сброс HWID (лимит), 🔓 — сброс без лимита.',
        markup: { inline_keyboard: rows }
      });
    }
    if (data.startsWith('frc:')) {
      const key = norm(data.slice(4));
      const entry = findKey(key);
      if (!entry) {
        await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Ключ не найден' });
        return show(q, keysMenu());
      }
      entry.usedBy = null;
      entry.usedAt = 0;
      save();
      await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Сброшено' });
      return show(q, keysMenu());
    }
    if (data.startsWith('fk:')) {
      const key = norm(data.slice(3));
      const entry = findKey(key);
      if (!entry || !entry.usedBy) {
        await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Ключ не занят' });
        return show(q, keysMenu());
      }
      const used = entry.resets || 0;
      const max = entry.maxResets == null ? 1 : entry.maxResets;
      if (used >= max) {
        await tg('answerCallbackQuery', {
          callback_query_id: q.id,
          text: 'Лимит сбросов исчерпан — нажми 🔓 рядом с ключом'
        });
        return;
      }
      entry.usedBy = null;
      entry.usedAt = 0;
      entry.resets = used + 1;
      save();
      await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Привязка сброшена' });
      return show(q, keysMenu());
    }
    if (data.startsWith('del:')) {
      const key = norm(data.slice(4));
      const before = state.keys.length;
      state.keys = state.keys.filter((k) => norm(k.key) !== key);
      save();
      await tg('answerCallbackQuery', { callback_query_id: q.id, text: state.keys.length < before ? 'Ключ удалён' : 'Не найден' });
      return show(q, keysMenu());
    }
    if (data.startsWith('d:')) {
      const index = parseInt(data.slice(2), 10);
      const d = state.devices[index];
      if (!d) return show(q, devicesMenu());
      return show(q, { text: deviceText(d), markup: deviceButtons(index) });
    }
    if (data.startsWith('bh:') || data.startsWith('bk:')) {
      const isHwid = data.startsWith('bh:');
      const index = parseInt(data.slice(3), 10);
      const d = state.devices[index];
      if (!d) return show(q, devicesMenu());
      if (isHwid) {
        if (!state.bannedHwids.map(norm).includes(norm(d.hwid))) state.bannedHwids.push(d.hwid);
      } else {
        if (!state.bannedKeys.map(norm).includes(norm(d.key))) state.bannedKeys.push(d.key);
      }
      save();
      await tg('answerCallbackQuery', {
        callback_query_id: q.id,
        text: isHwid ? 'HWID забанен' : 'Ключ забанен'
      });
      return show(q, {
        text: (isHwid ? '🚫 HWID забанен\n' : '🚫 Ключ забанен\n') + deviceText(d),
        markup: deviceButtons(index)
      });
    }
    if (data.startsWith('ub:sk:') || data.startsWith('ub:sh:')) {
      const isKey = data.startsWith('ub:sk:');
      const index = parseInt(data.slice(6), 10);
      if (isKey) state.bannedKeys.splice(index, 1);
      else state.bannedHwids.splice(index, 1);
      save();
      await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Разбанен' });
      return show(q, bansMenu());
    }
  } catch (e) {
    console.error('callback failed', e);
  }
}

async function handleMessage(msg) {
  const chatId = msg.chat && msg.chat.id;
  if (!chatId) return;
  const text = String(msg.text || '').trim();
  if (text.startsWith('/start')) {
    const payload = text.split(/\s+/)[1] || '';
    const isNewUser = !state.users[String(chatId)];
    const current = user(chatId);
    if (payload.startsWith('ref_') && isNewUser) {
      const refId = payload.slice(4);
      if (refId && refId !== String(chatId) && state.users[refId]) {
        current.referredBy = refId;
        const referrer = state.users[refId];
        referrer.balance = Math.round((Number(referrer.balance || 0) + REFERRAL_BONUS) * 100) / 100;
        save();
        await tg('sendMessage', {
          chat_id: refId,
          text: `🎉 Новый реферал!\n+$${REFERRAL_BONUS.toFixed(2)} зачислено на баланс.`
        });
      } else {
        save();
      }
    } else if (isNewUser) {
      save();
    }
    const m = mainMenuFor(chatId);
    return tg('sendMessage', { chat_id: chatId, text: m.text, reply_markup: m.markup });
  }
  if (text === '/menu' || text === '/help') {
    const menu = mainMenuFor(chatId);
    return tg('sendMessage', { chat_id: chatId, text: menu.text, reply_markup: menu.markup });
  }
  const pendingInput = waiting.get(String(chatId));
  if (pendingInput && pendingInput.action === 'promo' && text && !text.startsWith('/')) {
    waiting.delete(String(chatId));
    const code = norm(text);
    const promo = state.promos.find((p) => norm(p.code) === code && p.usesLeft > 0);
    if (!promo) {
      return tg('sendMessage', {
        chat_id: chatId,
        text: '🎟 Промокод не найден или уже использован.',
        reply_markup: { inline_keyboard: [backRow('m:market')] }
      });
    }
    promo.usesLeft -= 1;
    if (promo.usesLeft <= 0) state.promos = state.promos.filter((p) => p !== promo);
    const key = newKey(promo.days);
    const entry = findKey(key);
    if (entry) entry.chatId = chatId;
    save();
    return tg('sendMessage', {
      chat_id: chatId,
      text: `🎟 Промокод активирован!\nВаш ключ: ${key}\n` +
        `Тариф: ${promo.days ? promo.days + ' дней' : 'навсегда'}\n` +
        'Введите его в «Настройки → Мод клиента».'
    });
  }
  if (pendingInput && pendingInput.action === 'reset' && text && !text.startsWith('/')) {
    waiting.delete(String(chatId));
    const key = norm(text);
    const entry = findKey(key);
    if (!entry || !entry.usedBy) {
      return tg('sendMessage', { chat_id: chatId, text: 'Ключ не найден или ещё не привязан.' });
    }
    if (String(entry.chatId || '') !== String(chatId)) {
      return tg('sendMessage', {
        chat_id: chatId,
        text: 'Этот ключ был получен с другого аккаунта Telegram — сброс недоступен.'
      });
    }
    const usedResets = entry.resets || 0;
    const maxResets = entry.maxResets == null ? 1 : entry.maxResets;
    let paid = false;
    if (usedResets >= maxResets) {
      const u = user(chatId);
      if (Number(u.balance || 0) < RESET_PRICE) {
        return tg('sendMessage', {
          chat_id: chatId,
          text: `Недостаточно средств: сброс стоит $${RESET_PRICE.toFixed(2)}.\n` +
            `Баланс: $${Number(u.balance || 0).toFixed(2)}`,
          reply_markup: { inline_keyboard: [[{ text: '➕ Пополнить', callback_data: 'm:topup' }]] }
        });
      }
      u.balance = Math.round((u.balance - RESET_PRICE) * 100) / 100;
      paid = true;
    }
    entry.usedBy = null;
    entry.usedAt = 0;
    entry.resets = usedResets + 1;
    save();
    return tg('sendMessage', {
      chat_id: chatId,
      text: `✅ Привязка ключа сброшена ${paid ? `(списано $${RESET_PRICE.toFixed(2)})` : '(бесплатно)'}.\n` +
        'Введите ключ на новом устройстве.'
    });
  }
  if (pendingInput && pendingInput.action === 'support' && text && !text.startsWith('/')) {
    waiting.delete(String(chatId));
    const user = msg.chat;
    const ticket = {
      id: crypto.randomBytes(3).toString('hex'),
      chatId,
      username: user.username || '',
      name: [user.first_name, user.last_name].filter(Boolean).join(' '),
      text: text.slice(0, 500),
      status: 'open',
      ts: Date.now()
    };
    state.tickets.push(ticket);
    save();
    await replyToAdmin(
      `🆘 Тикет #${ticket.id}\n` +
      (ticket.username ? '@' + ticket.username : ticket.name) + ` (${chatId})\n\n` + ticket.text,
      {
        inline_keyboard: [[
          { text: '✍️ Ответить', callback_data: 'sup:' + ticket.id + ':reply' },
          { text: '✅ Закрыть', callback_data: 'sup:' + ticket.id + ':close' }
        ]]
      });
    return tg('sendMessage', {
      chat_id: chatId,
      text: `Тикет #${ticket.id} отправлен. Ответ придёт в этот чат.`
    });
  }
  if (pendingInput && pendingInput.action === 'reply' && text && !text.startsWith('/') && isAdmin(chatId)) {
    waiting.delete(String(chatId));
    const ticket = state.tickets.find((t) => t.id === pendingInput.ticketId);
    if (!ticket) {
      return tg('sendMessage', { chat_id: chatId, text: 'Тикет не найден.' });
    }
    ticket.status = 'answered';
    save();
    await tg('sendMessage', { chat_id: ticket.chatId, text: '🆘 Ответ поддержки:\n' + text });
    return tg('sendMessage', { chat_id: chatId, text: 'Ответ отправлен пользователю.' });
  }
  if (!isAdmin(chatId)) return;
  if (text === '/devices') {
    const m = devicesMenu();
    return tg('sendMessage', { chat_id: chatId, text: m.text, reply_markup: m.markup });
  }
  if (text === '/bans') {
    const m = bansMenu();
    return tg('sendMessage', { chat_id: chatId, text: m.text, reply_markup: m.markup });
  }
  if (text === '/keys') {
    const m = keysMenu();
    return tg('sendMessage', { chat_id: chatId, text: m.text, reply_markup: m.markup });
  }
  if (text === '/newkey') {
    const key = newKey();
    save();
    return tg('sendMessage', {
      chat_id: chatId,
      text: 'Новый ключ: ' + key,
      reply_markup: {
        inline_keyboard: [[{ text: '➕ Ещё', callback_data: 'k:new' }], backRow('m:keys')]
      }
    });
  }
  if (text.startsWith('/forcefree')) {
    const key = norm(text.split(/\s+/)[1] || '');
    const entry = findKey(key);
    if (!entry) {
      return tg('sendMessage', { chat_id: chatId, text: 'Ключ не найден: ' + key });
    }
    entry.usedBy = null;
    entry.usedAt = 0;
    save();
    return tg('sendMessage', { chat_id: chatId, text: '♻️ Привязка сброшена принудительно: ' + key });
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
    if (!buildAllowed(url.searchParams.get('build'))) {
      return json(res, 200, { banned: true, reason: 'build' });
    }
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
        const result = await handleActivation(data, ip, req.headers['x-tmod-build']);
        json(res, 200, result);
      } catch (e) {
        json(res, 400, { ok: false, error: 'bad request' });
      }
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/xrocket/webhook') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10000) req.destroy();
    });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}');
        if (data.type === 'invoicePay' && data.data && data.data.status === 'paid') {
          const inv = state.invoices.find((i) => i.id === String(data.data.id));
          if (inv && creditInvoice(inv)) {
            await tg('sendMessage', {
              chat_id: inv.chatId,
              text: `✅ Баланс пополнен на $${Number(inv.amount).toFixed(2)}.\n` +
                `Текущий баланс: $${Number(user(inv.chatId).balance).toFixed(2)}`
            });
          }
        }
      } catch (e) {
        console.error('webhook parse failed', e);
      }
      json(res, 200, { ok: true });
    });
    return;
  }
  json(res, 404, { error: 'not found' });
});

async function start() {
  await loadRemote();
  if (!Array.isArray(state.keys) || !state.keys.length) state.keys = freshKeys();
  try {
    const me = await fetch(`${TG}/getMe`).then((r) => r.json());
    if (me && me.ok && me.result) BOT_USERNAME = me.result.username || '';
  } catch (e) {
    // без username ссылка появится позже
  }
  server.listen(PORT, () => {
    console.log('tmod admin listening on ' + PORT);
    poll();
    selfPing();
    reminderLoop();
  });
}

/** Напоминания покупателям об истечении ключа (за 3 дня и за 1 день). */
function reminderLoop() {
  setInterval(async () => {
    const now = Date.now();
    for (const entry of state.keys) {
      if (!entry.chatId || !entry.expiresAt) continue;
      const left = entry.expiresAt - now;
      try {
        if (left <= 3 * 86400000 && left > 2 * 86400000 && !entry.reminded3) {
          entry.reminded3 = true;
          save();
          await tg('sendMessage', {
            chat_id: entry.chatId,
            text: `⏳ Подписка GreiTikTok истекает через 3 дня (ключ ${entry.key}).\n` +
              'Продлить можно в «Маркете».',
            reply_markup: { inline_keyboard: [[{ text: '🛒 Маркет', callback_data: 'm:market' }]] }
          });
        } else if (left <= 1 * 86400000 && left > 0 && !entry.reminded1) {
          entry.reminded1 = true;
          save();
          await tg('sendMessage', {
            chat_id: entry.chatId,
            text: `⚠️ Подписка GreiTikTok истекает завтра (ключ ${entry.key}).\n` +
              'Продлить можно в «Маркете».',
            reply_markup: { inline_keyboard: [[{ text: '🛒 Маркет', callback_data: 'm:market' }]] }
          });
        }
      } catch (e) {
        // напоминание не критично
      }
    }
  }, 3600000);
}

/** Самопинг: Render free засыпает без входящих запросов, свой URL держит сервис живым. */
function selfPing() {
  const url = process.env.RENDER_EXTERNAL_URL || 'https://tmod-admin.onrender.com/';
  setInterval(() => {
    fetch(url).catch(() => {});
  }, 4 * 60 * 1000);
}

start();
