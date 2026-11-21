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
  { id: '3', days: 3, price: '$1' },
  { id: '7', days: 7, price: '$2' },
  { id: '30', days: 30, price: '$7' },
  { id: 'forever', days: 0, price: '$20' }
];
const ALLOWED_BUILDS = String(process.env.ALLOWED_BUILDS || '')
  .split(',').map((b) => b.trim()).filter(Boolean);
const BUILD_ENFORCE = process.env.BUILD_ENFORCE === '1';
const XROCKET_KEY = process.env.XROCKET_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhcHBJZCI6IjMxMDM2MyIsImp0aSI6ImFwcDozMTAzNjM6YzkzYmQ5MDItYjFjYS00M2EzLTgwYjctZTRmYTY2NTczN2VmIiwiaWF0IjoxNzk1MTY1Njk3fQ.kJ4mBlhaFh1fuGYFfaIwSH8OANd2BJi7FYb5aI527Tk';
const XROCKET_BASE = process.env.XROCKET_BASE || 'https://pay.api.xrocket.exchange';
const XROCKET_WEBHOOK_TOKEN = process.env.XROCKET_WEBHOOK_TOKEN || '';
const REFERRAL_BONUS = 0.1;
const REF_L1_PERCENT = 0.10;
const REF_L2_PERCENT = 0.05;
const DAILY_BONUS = 0.02;
const PLAN_PRICE = { '3': 1, '7': 2, '30': 7, forever: 20 };

function planWord(days) {
  if (!days) return 'навсегда';
  const n = Math.abs(days) % 100;
  const d = n % 10;
  const word = n > 10 && n < 20 ? 'дней' : d === 1 ? 'день' : d >= 2 && d <= 4 ? 'дня' : 'дней';
  return days + ' ' + word;
}
const FREE_COOLDOWN_MS = 14 * 86400000;
const RESET_PRICE = 0.5;
let BOT_USERNAME = '';
const APK_URL = process.env.APK_URL || 'https://t.me/+kdzKWVZcvUljZmE6';
const SUB_CHANNEL = process.env.SUB_CHANNEL || '-1003492504126';
const SUB_LINK = 'https://t.me/GreiTikTok';
const SUB_GATE = process.env.SUB_GATE !== '0';
const SUB_OK_TTL = 10 * 60 * 1000;
const SUB_NO_TTL = 30 * 1000;
const subCache = new Map();
const pendingStart = new Map();
const AVATAR_URL = 'https://tmod-admin.onrender.com/avatar.png';
let AVATAR_BYTES = null;
try {
  AVATAR_BYTES = fs.readFileSync(__dirname + '/avatar.png');
} catch (e) {
  console.error('avatar.png missing');
}
const PROMO_VERSION = '2';
const PROMO_URL = 'https://tmod-admin.onrender.com/promo.png?v=' + PROMO_VERSION;
let PROMO_BYTES = null;
try {
  PROMO_BYTES = fs.readFileSync(__dirname + '/promo.png');
} catch (e) {
  console.error('promo.png missing');
}

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
if (!Array.isArray(state.purchases)) state.purchases = [];

function user(chatId) {
  const id = String(chatId);
  if (!state.users[id]) {
    state.users[id] = {
      balance: 0, referredBy: null, freeAt: 0,
      resetCredits: 0, lowNotifiedAt: 0,
      createdAt: Date.now(), lastBonusDay: ''
    };
  }
  const u = state.users[id];
  if (u.resetCredits == null) u.resetCredits = 0;
  if (u.lowNotifiedAt == null) u.lowNotifiedAt = 0;
  return u;
}

/** Уведомление о низком балансе после списаний (не чаще раза в сутки). */
async function checkLowBalance(chatId) {
  const u = user(chatId);
  const balance = Number(u.balance || 0);
  if (balance >= 1) {
    u.lowNotifiedAt = 0;
    return;
  }
  if (Date.now() - Number(u.lowNotifiedAt || 0) < 86400000) return;
  u.lowNotifiedAt = Date.now();
  save();
  await tg('sendMessage', {
    chat_id: chatId,
    text: `⚠️ Баланс ниже $1 (сейчас $${balance.toFixed(2)}).\n` +
      'Пополните, чтобы купить или продлить подписку.',
    reply_markup: { inline_keyboard: [[{ text: '➕ Пополнить', callback_data: 'm:topup' }]] }
  });
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
        planDays: days || 0,
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
      state.promos.push({
        code, type: 'key', days: days || 0,
        usesLeft: 1, createdAt: Date.now()
      });
      return code;
    }
  }
}

function newPromoBalance(amount) {
  for (;;) {
    let code = '';
    const bytes = crypto.randomBytes(8);
    for (let i = 0; i < 8; i++) code += ALPHABET[bytes[i] % ALPHABET.length];
    if (!state.promos.find((p) => p.code === code) && !findKey(code)) {
      state.promos.push({
        code, type: 'balance', amount: amount,
        usesLeft: 1, createdAt: Date.now()
      });
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
  return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + XROCKET_KEY };
}

async function xrCreateInvoice(amount, chatId) {
  try {
    const clientInvoiceId = 'topup-' + chatId + '-' + Date.now();
    const res = await fetch(XROCKET_BASE + '/api/v1/invoices', {
      method: 'POST',
      headers: xrHeaders(),
      body: JSON.stringify({
        priceAmount: String(amount),
        priceCurrency: 'USDT',
        payoutCurrency: 'USDT',
        description: 'GreiTikTok balance top-up',
        clientInvoiceId,
        expiresIn: 3600000,
        callback: {
          callbackUrl: 'https://tmod-admin.onrender.com/xrocket/webhook',
          payload: { chatId: String(chatId), kind: 'topup' }
        },
        data: { chatId: String(chatId), kind: 'topup' }
      })
    });
    const json = await res.json();
    const link = json && json.links
      ? (json.links.telegramBotLink || json.links.webLink) : null;
    if (json && json.id && link) {
      return {
        id: String(json.id),
        clientInvoiceId,
        amount,
        link,
        status: json.status || 'active'
      };
    }
    console.error('xrocket create failed', JSON.stringify(json).slice(0, 300));
  } catch (e) {
    console.error('xrocket create error', e.message);
  }
  return null;
}

async function xrInvoiceStatus(id) {
  try {
    const res = await fetch(XROCKET_BASE + '/api/v1/invoices/' + encodeURIComponent(id),
      { headers: xrHeaders() });
    const json = await res.json();
    return json && json.id ? json : null;
  } catch (e) {
    return null;
  }
}

function creditInvoice(invoice) {
  if (!invoice || invoice.status === 'paid') return false;
  const u = user(invoice.chatId);
  u.balance = Math.round((u.balance + invoice.amount) * 100) / 100;
  if (u.balance >= 1) u.lowNotifiedAt = 0;
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

function subGateMenu() {
  return {
    text: '🔒 Доступ к боту — только для подписчиков канала.\n\n' +
      '1) Подпишитесь на канал: @GreiTikTok\n' +
      '2) Нажмите «✅ Проверить подписку».',
    markup: {
      inline_keyboard: [
        [{ text: '📢 Подписаться', url: SUB_LINK }],
        [{ text: '✅ Проверить подписку', callback_data: 'sub:check' }]
      ]
    }
  };
}

function sendSubGate(chatId) {
  return sendWithPhoto(chatId, subGateMenu());
}

/** Отправляет меню фотографией с подписью и кнопками; при сбое — текстом. */
async function sendWithPhoto(chatId, menu) {
  const photo = menu.photo || AVATAR_URL;
  if (photo) {
    const r = await tg('sendPhoto', {
      chat_id: chatId,
      photo: state.avatarFileId || photo,
      caption: menu.text,
      reply_markup: menu.markup
    });
    if (r && r.ok) {
      const sizes = r.result && r.result.photo;
      if (!state.avatarFileId && sizes && sizes.length) {
        state.avatarFileId = sizes[sizes.length - 1].file_id;
        save();
      }
      return r;
    }
    if (state.avatarFileId) {
      const retry = await tg('sendPhoto', {
        chat_id: chatId,
        photo: photo,
        caption: menu.text,
        reply_markup: menu.markup
      });
      if (retry && retry.ok) {
        const sizes = retry.result && retry.result.photo;
        if (sizes && sizes.length) {
          state.avatarFileId = sizes[sizes.length - 1].file_id;
          save();
        }
        return retry;
      }
    }
    console.error('sendPhoto failed:', (r && r.description) || 'unknown');
  }
  return tg('sendMessage', { chat_id: chatId, text: menu.text, reply_markup: menu.markup });
}

function sendMainMenu(chatId) {
  return sendWithPhoto(chatId, mainMenuFor(chatId));
}

/** true — подписан, false — нет. При технической ошибке не блокируем доступ. */
async function checkSubscription(userId) {
  try {
    const r = await tg('getChatMember', { chat_id: SUB_CHANNEL, user_id: userId });
    if (r && r.ok) {
      const status = r.result && r.result.status;
      if (status === 'creator' || status === 'administrator' || status === 'member') return true;
      if (status === 'restricted') return !!(r.result && r.result.is_member);
      return false;
    }
    const desc = String((r && r.description) || '');
    if (/member list is inaccessible|chat not found|not enough rights|user not found/i.test(desc)) {
      console.error('sub check unavailable:', desc);
      return true;
    }
    console.error('sub check failed:', desc);
    return false;
  } catch (e) {
    console.error('sub check error', e);
    return true;
  }
}

async function isSubscribed(userId, force) {
  if (!SUB_GATE || isAdmin(userId)) return true;
  const id = String(userId);
  const cached = subCache.get(id);
  if (!force && cached && Date.now() - cached.at < cached.ttl) return cached.ok;
  const ok = await checkSubscription(id);
  subCache.set(id, { ok, at: Date.now(), ttl: ok ? SUB_OK_TTL : SUB_NO_TTL });
  return ok;
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

async function sendEvidence(adminId, photos) {
  for (let i = 0; i < photos.length; i += 10) {
    const chunk = photos.slice(i, i + 10).map((id) => ({ type: 'photo', media: id }));
    try {
      await tg('sendMediaGroup', { chat_id: adminId, media: chunk });
    } catch (e) {
      console.error('evidence send failed', e.message);
    }
  }
}

function moscowTime(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('ru-RU', {
      timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit',
      year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  } catch (e) {
    return new Date(ts).toISOString();
  }
}

function moscowDay() {
  try {
    return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
  } catch (e) {
    return new Date().toISOString().slice(0, 10);
  }
}

/** Проценты с покупки: 10% пригласившему и 5% его пригласившему. */
async function awardPurchase(buyerId, price) {
  const buyer = state.users[String(buyerId)];
  const l1 = buyer && buyer.referredBy ? String(buyer.referredBy) : null;
  if (!l1 || !state.users[l1]) return;
  const b1 = Math.round(price * REF_L1_PERCENT * 100) / 100;
  if (b1 > 0) {
    const r1 = state.users[l1];
    r1.balance = Math.round((Number(r1.balance || 0) + b1) * 100) / 100;
    await tg('sendMessage', {
      chat_id: l1,
      text: `💸 +$${b1.toFixed(2)} — 10% с покупки вашего реферала.`
    });
  }
  const l2 = state.users[l1].referredBy ? String(state.users[l1].referredBy) : null;
  if (l2 && l2 !== String(buyerId) && state.users[l2]) {
    const b2 = Math.round(price * REF_L2_PERCENT * 100) / 100;
    if (b2 > 0) {
      const r2 = state.users[l2];
      r2.balance = Math.round((Number(r2.balance || 0) + b2) * 100) / 100;
      await tg('sendMessage', {
        chat_id: l2,
        text: `💸 +$${b2.toFixed(2)} — 5% с покупки реферала вашего реферала.`
      });
    }
  }
  save();
}

function statsMenu() {
  const now = Date.now();
  const day = now - 86400000;
  const week = now - 7 * 86400000;
  const devices = state.devices || [];
  const active24 = devices.filter((d) => (d.ts || 0) >= day).length;
  const keys = state.keys || [];
  const activeKeys = keys.filter((k) => !k.expiresAt || k.expiresAt > now).length;
  const freeKeys = keys.filter((k) => !k.usedBy).length;
  const users = Object.values(state.users || {});
  const newUsers = users.filter((u) => (u.createdAt || 0) >= day).length;
  const invoices = (state.invoices || []).filter((i) => i.status === 'paid');
  const sum = (list) => list.reduce((acc, i) => acc + Number(i.amount || 0), 0);
  const incomeTotal = sum(invoices);
  const income24 = sum(invoices.filter((i) => (i.createdAt || 0) >= day));
  const income7 = sum(invoices.filter((i) => (i.createdAt || 0) >= week));
  const purchases = state.purchases || [];
  const purchases24 = purchases.filter((p) => (p.ts || 0) >= day).length;
  const buyers = new Set(purchases.map((p) => String(p.chatId)));
  const conv = users.length ? Math.round((buyers.size / users.length) * 100) : 0;
  return {
    text: `📊 Статистика

👥 Пользователи: ${users.length} (новых за 24ч: ${newUsers})
📱 Устройства: ${devices.length} (активных за 24ч: ${active24})
🔑 Ключи: ${keys.length} (активных: ${activeKeys}, свободных: ${freeKeys})
🛒 Покупок тарифов: ${purchases.length} (за 24ч: ${purchases24})
💵 Доход: $${incomeTotal.toFixed(2)} · 24ч: $${income24.toFixed(2)} · 7д: $${income7.toFixed(2)}
📈 Конверсия в покупку: ${conv}%

Доход — по оплаченным пополнениям; конверсия — доля пользователей, купивших тариф.`,
    markup: {
      inline_keyboard: [
        [{ text: '🔄 Обновить', callback_data: 'm:stats' }],
        [{ text: '◀️ Админка', callback_data: 'm:admin' }]
      ]
    }
  };
}

function subText(key) {
  const entry = findKey(key);
  if (!entry) return 'Подписка: ключ не найден';
  const days = entry.planDays || (entry.expiresAt && entry.createdAt
    ? Math.round((entry.expiresAt - entry.createdAt) / 86400000) : 0);
  const left = !entry.expiresAt ? 'бессрочно'
    : (entry.expiresAt <= Date.now() ? 'истекла'
      : Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 86400000)) + ' дн.');
  return 'Подписка: ' + (days ? days + ' дн.' : 'навсегда') + ' (осталось: ' + left + ')\n' +
    'Куплена: ' + moscowTime(entry.createdAt) + ' (МСК)\n' +
    'Активирована: ' + (entry.usedAt ? moscowTime(entry.usedAt) + ' (МСК)' : 'ещё нет') + '\n' +
    'Действует до: ' + (entry.expiresAt ? moscowTime(entry.expiresAt) + ' (МСК)' : 'бессрочно');
}

function deviceText(d) {
  return `Устройство\nКлюч: ${d.key}\nМодель: ${d.model}\nAndroid: ${d.android}\n` +
    `Регион: ${d.geo || '?'}\nСборка: ${d.build || '?'}\nHWID: ${d.hwid}\nIP: ${d.ip}\n` +
    `Последняя активация: ${moscowTime(d.ts)} (МСК)\n\n` + subText(d.key);
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
  rows.push([{ text: '🗑 Удалить устройство', callback_data: 'dd:' + index }]);
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
  const firstBind = !entry.usedBy;
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
  if (firstBind) await replyToAdmin(deviceText(record), deviceButtons(index));
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
      { text: '👤 Профиль', callback_data: 'm:profile' },
      { text: '🎟 Промокоды', callback_data: 'promo:enter' }
    ],
    [
      { text: '👥 Реферальная система', callback_data: 'm:ref' },
      { text: '🆘 Поддержка', callback_data: 'm:support' }
    ],
    [{ text: '📥 Скачать APK', url: APK_URL }],
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
        [{ text: '◀️ Назад', callback_data: 'm:home' }]
      ]
    }
  };
}

function topupMenu() {
  return {
    text: '➕ Пополнение баланса\n\nВыберите сумму или введите свою (от $0.10). Оплата через xRocket (USDT).',
    markup: {
      inline_keyboard: [
        [
          { text: '$1', callback_data: 'top:1' },
          { text: '$3', callback_data: 'top:3' },
          { text: '$5', callback_data: 'top:5' },
          { text: '$10', callback_data: 'top:10' }
        ],
        [{ text: '✍️ Своя сумма', callback_data: 'top:custom' }],
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
  const refPurchases = (state.purchases || []).filter((p) => {
    const bu = state.users[String(p.chatId)];
    return bu && String(bu.referredBy || '') === id;
  });
  const refSpent = refPurchases.reduce((acc, p) => acc + Number(p.price || 0), 0);
  const link = BOT_USERNAME
    ? `https://t.me/${BOT_USERNAME}?start=ref_${id}`
    : 'ссылка появится после запуска бота';
  return {
    text: `👥 Реферальная система\n\n` +
      `Ваша ссылка:\n${link}\n\n` +
      `Приглашено: ${invited}\n` +
      `За входы: $${(invited * REFERRAL_BONUS).toFixed(2)}\n` +
      `Покупок рефералов: ${refPurchases.length} на $${refSpent.toFixed(2)}\n\n` +
      `За каждого друга, который впервые зайдёт по ссылке — +$${REFERRAL_BONUS.toFixed(2)}.\n` +
      `С покупки друга — 10% на баланс, с покупки его друга — 5%.`,
    markup: {
      inline_keyboard: [
        [{ text: '📤 Поделиться ссылкой', url: link.startsWith('http') ? link : 'https://t.me' }],
        [{ text: '💰 Баланс', callback_data: 'm:balance' }],
        [{ text: '◀️ Назад', callback_data: 'm:home' }]
      ]
    }
  };
}

function profileMenu(chatId) {
  const id = String(chatId);
  const u = user(chatId);
  const mine = state.keys.filter((k) => String(k.chatId || '') === id);
  mine.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const now = Date.now();
  const active = mine.find((k) => !k.expiresAt || k.expiresAt > now) || mine[0];

  const lines = ['👤 Профиль', ''];
  if (!active) {
    lines.push('Подписки пока нет.');
  } else {
    const planDays = active.planDays
      || (active.expiresAt ? Math.round((active.expiresAt - (active.createdAt || 0)) / 86400000) : 0);
    lines.push('Ключ: ' + active.key);
    lines.push('Подписка: ' + (planDays ? planDays + ' дней' : 'навсегда'));
    if (!active.usedBy) {
      lines.push('Статус: ожидает активации');
    } else if (active.expiresAt && active.expiresAt <= now) {
      lines.push('Статус: истекла');
    } else {
      lines.push('Статус: активна');
    }
    if (active.expiresAt) {
      const left = Math.max(0, Math.ceil((active.expiresAt - now) / 86400000));
      const until = new Date(active.expiresAt).toLocaleDateString('ru-RU');
      lines.push(`Осталось: ${left} дн. (до ${until})`);
    } else {
      lines.push('Осталось: бессрочно');
    }
    const device = state.devices.find((d) => d.key === active.key);
    if (device) {
      lines.push(`Устройство: ${device.model} · ${String(device.hwid).slice(0, 10)}…`);
    } else if (active.usedBy) {
      lines.push('Устройство: ' + String(active.usedBy).slice(0, 10) + '…');
    } else {
      lines.push('Устройство: ещё не привязано');
    }
  }
  lines.push('', `Баланс: $${Number(u.balance || 0).toFixed(2)}`);

  return {
    text: lines.join('\n'),
    markup: {
      inline_keyboard: [
        [
          { text: '💰 Баланс', callback_data: 'm:balance' },
          { text: '🛒 Маркет', callback_data: 'm:market' }
        ],
        [{ text: '◀️ Назад', callback_data: 'm:home' }]
      ]
    }
  };
}

function marketMenu() {
  const labels = PLANS.map((p) => (p.days ? planWord(p.days) : 'Навсегда') + ' — ' + p.price);
  const planRows = PLANS.map((p) => ([{
    text: (p.days ? planWord(p.days) : 'Навсегда') + ' — ' + p.price,
    callback_data: 'plan:' + p.id
  }]));
  return {
    text: '🛒 Маркет GreiTikTok\n\n' +
      labels.join('\n') + '\n\n' +
      'Покупка с баланса. Сначала пополните баланс в разделе «Баланс».',
    markup: {
      inline_keyboard: [
        ...planRows,
        [{ text: '🎁 Получить бесплатно', callback_data: 'free:get' }],
        [{ text: `🔁 Сброс HWID — $${RESET_PRICE.toFixed(2)}`, callback_data: 'm:reset' }],
        [{ text: '📦 +3 сброса HWID — $1', callback_data: 'resetpack' }],
        [{ text: '◀️ Назад', callback_data: 'm:home' }]
      ]
    }
  };
}

function freeMenu() {
  return {
    text: '🎁 Бесплатная подписка на 1 день\n\n' +
      'Что нужно сделать:\n' +
      '1) Сохраните картинку с рекламой мода (она выше).\n' +
      '2) Под 15 разными видео по теме TikTok, автопрогрева или модов ' +
      'напишите комментарий и прикрепите эту картинку.\n' +
      '3) Сделайте скриншот каждого комментария (15 скриншотов).\n' +
      '4) Нажмите «📨 Оставить заявку» и отправьте все 15 скриншотов.\n\n' +
      'Бесплатный ключ можно получать раз в 2 недели.',
    markup: {
      inline_keyboard: [
        [{ text: '📨 Оставить заявку', callback_data: 'free:req' }],
        backRow('m:market')
      ]
    }
  };
}

/** Присылает картинку-рекламу с подписью и кнопками; file_id кэшируется по версии. */
async function sendPromo(chatId) {
  const m = freeMenu();
  const cached = state.promoVersion === PROMO_VERSION ? state.promoFileId : null;
  const send = (photo) => tg('sendPhoto', {
    chat_id: chatId,
    photo,
    caption: m.text,
    reply_markup: m.markup
  });
  let r = await send(cached || PROMO_URL);
  if ((!r || !r.ok) && cached) {
    r = await send(PROMO_URL);
  }
  if (r && r.ok) {
    const sizes = r.result && r.result.photo;
    if (!cached && sizes && sizes.length) {
      state.promoFileId = sizes[sizes.length - 1].file_id;
      state.promoVersion = PROMO_VERSION;
      save();
    }
    return r;
  }
  console.error('promo photo failed:', (r && r.description) || 'unknown');
  return tg('sendMessage', { chat_id: chatId, text: m.text, reply_markup: m.markup });
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
          { text: '👥 Пользователи', callback_data: 'm:users' },
          { text: '💰 Балансы', callback_data: 'm:balances' }
        ],
        [
          { text: '🎫 Тикеты', callback_data: 'm:tickets' },
          { text: 'ℹ️ Помощь', callback_data: 'm:help' }
        ],
        [{ text: '📊 Статистика', callback_data: 'm:stats' }],
        [{ text: '◀️ Меню', callback_data: 'm:home' }]
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
    [{ text: '➕ Промокод навсегда', callback_data: 'promo:new:0' }],
    [
      { text: '💵 Баланс $0.5', callback_data: 'promo:newbal:0.5' },
      { text: '💵 Баланс $1', callback_data: 'promo:newbal:1' }
    ]
  ];
  state.promos.slice(-15).forEach((p) => {
    const label = p.type === 'balance'
      ? `$${Number(p.amount).toFixed(2)}`
      : (p.days ? p.days + 'д' : '∞');
    rows.push([{
      text: `🗑 ${p.code} · ${label} · осталось ${p.usesLeft}`,
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

function usersMenu() {
  const rows = [];
  Object.keys(state.users).slice(-10).forEach((id) => {
    const u = state.users[id];
    rows.push([{
      text: `👤 ${id} · $${Number(u.balance || 0).toFixed(2)}`,
      callback_data: 'user:' + id
    }]);
  });
  rows.push(backRow('m:admin'));
  return {
    text: rows.length > 1 ? 'Пользователи (тап — управление):' : 'Пользователей нет.',
    markup: { inline_keyboard: rows }
  };
}

function userMenu(id) {
  const u = user(id);
  const mine = state.keys.filter((k) => String(k.chatId || '') === String(id));
  mine.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const key = mine.find((k) => !k.expiresAt || k.expiresAt > Date.now()) || mine[0];
  const lines = [
    `👤 Пользователь ${id}`,
    `Баланс: $${Number(u.balance || 0).toFixed(2)}`,
    `Сбросы из пакета: ${Number(u.resetCredits || 0)}`
  ];
  if (key) {
    const until = key.expiresAt
      ? new Date(key.expiresAt).toLocaleDateString('ru-RU') : 'бессрочно';
    lines.push(`Ключ: ${key.key}`);
    lines.push(`До: ${until}`);
  } else {
    lines.push('Ключа нет');
  }
  return {
    text: lines.join('\n'),
    markup: {
      inline_keyboard: [
        [
          { text: '🎁 Выдать 7 дней', callback_data: 'uissue:' + id + ':7' },
          { text: '🎁 30 дней', callback_data: 'uissue:' + id + ':30' }
        ],
        [
          { text: '⏳ Продлить +7', callback_data: 'uext:' + id + ':7' },
          { text: '⏳ +30', callback_data: 'uext:' + id + ':30' }
        ],
        [{ text: '◀️ Назад', callback_data: 'm:users' }]
      ]
    }
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
    const entry = findKey(d.key);
    let badge = '?';
    if (entry) {
      badge = entry.expiresAt
        ? (entry.expiresAt > Date.now()
          ? Math.ceil((entry.expiresAt - Date.now()) / 86400000) + 'д'
          : 'истёк')
        : '∞';
    }
    rows.push([{
      text: `📱 ${String(d.model).slice(0, 24)} · ${d.key} · ${badge}`,
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
  if (cbq.message.photo) {
    const caption = await tg('editMessageCaption', {
      chat_id: chatId,
      message_id: messageId,
      caption: menu.text,
      reply_markup: menu.markup
    });
    if (caption && caption.ok) return;
  }
  const edited = await tg('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: menu.text,
    reply_markup: menu.markup,
    disable_web_page_preview: true
  });
  if (edited && edited.ok) return;
  await tg('deleteMessage', { chat_id: chatId, message_id: messageId });
  await tg('sendMessage', { chat_id: chatId, text: menu.text, reply_markup: menu.markup });
}

async function handleCallback(q) {
  const admin = isAdmin(q.from && q.from.id);
  const data = String(q.data || '');
  try {
    if (data === 'sub:check') {
      const id = q.from.id;
      const ok = await isSubscribed(id, true);
      if (!ok) {
        await tg('answerCallbackQuery', {
          callback_query_id: q.id,
          text: 'Подписка не найдена — подпишитесь на канал и попробуйте снова',
          show_alert: true
        });
        return show(q, subGateMenu());
      }
      await tg('answerCallbackQuery', {
        callback_query_id: q.id,
        text: '✅ Подписка подтверждена'
      });
      const payload = pendingStart.get(String(id)) || '';
      pendingStart.delete(String(id));
      return startFlow(id, payload, q);
    }
    if (!admin && !(await isSubscribed(q.from.id))) {
      await tg('answerCallbackQuery', {
        callback_query_id: q.id,
        text: 'Сначала подпишитесь на канал @GreiTikTok'
      });
      return show(q, subGateMenu());
    }
    if (data === 'apk:send') {
      const chatId = q.from.id;
      if (state.apkMessageId) {
        const r = await tg('copyMessage', {
          chat_id: chatId,
          from_chat_id: state.apkChatId || SUB_CHANNEL,
          message_id: state.apkMessageId
        });
        if (r && r.ok) {
          await tg('answerCallbackQuery', {
            callback_query_id: q.id, text: 'APK отправлен'
          });
          return;
        }
        console.error('apk copy failed:', (r && r.description) || 'unknown');
      }
      await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Открываю ссылку' });
      return tg('sendMessage', {
        chat_id: chatId,
        text: 'APK файлом отправить не удалось. Скачайте по кнопке:',
        reply_markup: { inline_keyboard: [[{ text: '📥 Скачать APK', url: APK_URL }]] }
      });
    }
    if (data === 'm:home') return show(q, mainMenuFor(q.from.id));
    if (data === 'm:market') return show(q, marketMenu());
    if (data === 'free:get') return sendPromo(q.message.chat.id);
    if (data === 'm:balance') return show(q, balanceMenu(q.from.id));
    if (data === 'm:profile') return show(q, profileMenu(q.from.id));
    if (data === 'm:topup') return show(q, topupMenu());
    if (data === 'm:ref') return show(q, referralMenu(q.from.id));
    if (data === 'resetpack') {
      const u = user(q.from.id);
      if (Number(u.balance || 0) < 1) {
        return show(q, {
          text: `Пакет «+3 сброса HWID» стоит $1.\nБаланс: $${Number(u.balance || 0).toFixed(2)}`,
          markup: {
            inline_keyboard: [
              [{ text: '➕ Пополнить', callback_data: 'm:topup' }],
              backRow('m:market')
            ]
          }
        });
      }
      u.balance = Math.round((u.balance - 1) * 100) / 100;
      u.resetCredits = (u.resetCredits || 0) + 3;
      save();
      await checkLowBalance(q.from.id);
      return show(q, {
        text: `✅ Куплено 3 сброса HWID.\nОсталось сбросов: ${u.resetCredits}\n` +
          `Баланс: $${Number(u.balance).toFixed(2)}`,
        markup: { inline_keyboard: [backRow('m:market')] }
      });
    }
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
    if (data === 'top:custom') {
      waiting.set(String(q.from.id), { action: 'topup_amount' });
      return show(q, {
        text: '✍️ Введите сумму пополнения в долларах (минимум 0.10):\nнапример, 1.5',
        markup: { inline_keyboard: [backRow('m:topup')] }
      });
    }
    if (data.startsWith('top:')) {
      const amount = Number(data.slice(4));
      if (!amount || amount <= 0) return show(q, topupMenu());
      const invoice = await xrCreateInvoice(amount, q.from.id);
      if (!invoice) {
        return show(q, {
          text: 'Оплата временно недоступна. Попробуйте позже или напишите в поддержку.',
          markup: { inline_keyboard: [backRow('m:topup')] }
        });
      }
      state.invoices.push({
        id: String(invoice.id),
        clientInvoiceId: invoice.clientInvoiceId,
        chatId: q.from.id,
        amount,
        status: 'active',
        link: invoice.link,
        createdAt: Date.now()
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
      waiting.set(String(q.from.id), { action: 'free_shots', photos: [] });
      return show(q, {
        text: '📸 Отправьте 15 скриншотов ваших комментариев с картинкой по одному сообщению.\n' +
          'Я буду считать: 0/15.',
        markup: { inline_keyboard: [backRow('m:market')] }
      });
    }

    if (data === 'free:confirm') {
      const shot = waiting.get(String(q.from.id));
      if (!shot || shot.action !== 'free_confirm' || shot.photos.length < 15) {
        return show(q, {
          text: 'Не хватает скриншотов. Начните заявку заново.',
          markup: { inline_keyboard: [backRow('m:market')] }
        });
      }
      waiting.delete(String(q.from.id));
      const order = {
        id: crypto.randomBytes(3).toString('hex'),
        days: 1,
        price: 'бесплатно',
        chatId: q.from.id,
        username: q.from.username || '',
        status: 'new',
        type: 'free',
        photos: shot.photos.slice(),
        ts: Date.now()
      };
      state.orders.push(order);
      save();
      await replyToAdmin(
        `🎁 Заявка на бесплатный доступ #${order.id}\n` +
        `Покупатель: ${order.username ? '@' + order.username : '—'} (${order.chatId})\n` +
        'Скриншоты: 15 шт. Ниже придут фото.',
        {
          inline_keyboard: [[
            { text: '✅ Выдать 1 день', callback_data: 'ord:' + order.id + ':ok' },
            { text: '❌ Отклонить', callback_data: 'ord:' + order.id + ':no' }
          ]]
        });
      for (const adminId of state.admins) {
        await sendEvidence(adminId, order.photos);
      }
      return show(q, {
        text: `Заявка #${order.id} отправлена на проверку.\nОтвет придёт в этот чат.`,
        markup: { inline_keyboard: [backRow('m:market')] }
      });
    }
    if (data === 'free:cancel') {
      waiting.delete(String(q.from.id));
      return show(q, {
        text: 'Заявка отменена.',
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
        text: 'GreiTikTok — мод для TikTok: автопрогрев ленты, лайки, сохранения, '
          + 'комментарии по теме и ИИ-чекер.\n\nКлючи и бесплатный доступ — в «Маркете».',
        markup: { inline_keyboard: [backRow('m:home')] }
      });
    }
    if (data.startsWith('plan:')) {
      const plan = PLANS.find((p) => p.id === data.slice(5));
      if (!plan) return show(q, marketMenu());
      const price = PLAN_PRICE[plan.id];
      const u = user(q.from.id);
      const balance = Number(u.balance || 0);
      if (balance + 1e-9 < price) {
        return show(q, {
          text: `Недостаточно средств.\n\nТариф: ${planWord(plan.days)} — $${price}\n` +
            `Ваш баланс: $${balance.toFixed(2)}\n\n` +
            'Пополните баланс и вернитесь в «Маркет».',
          markup: {
            inline_keyboard: [
              [{ text: '➕ Пополнить', callback_data: 'm:topup' }],
              backRow('m:market')
            ]
          }
        });
      }
      return show(q, {
        text: 'Подтвердите покупку\n\n' +
          `Тариф: ${planWord(plan.days)}\n` +
          `Цена: $${price}\n` +
          `Баланс: $${balance.toFixed(2)}\n` +
          `После покупки: $${(balance - price).toFixed(2)}`,
        markup: {
          inline_keyboard: [
            [{ text: '✅ Подтвердить', callback_data: 'buy:' + plan.id }],
            [{ text: '❌ Отмена', callback_data: 'm:market' }]
          ]
        }
      });
    }
    if (data.startsWith('buy:')) {
      const plan = PLANS.find((p) => p.id === data.slice(4));
      if (!plan) return show(q, marketMenu());
      const price = PLAN_PRICE[plan.id];
      const u = user(q.from.id);
      if (Number(u.balance || 0) + 1e-9 < price) {
        return show(q, {
          text: 'Недостаточно средств.',
          markup: { inline_keyboard: [[{ text: '➕ Пополнить', callback_data: 'm:topup' }], backRow('m:market')] }
        });
      }
      u.balance = Math.round((u.balance - price) * 100) / 100;
      const key = newKey(plan.days);
      const entry = findKey(key);
      if (entry) entry.chatId = q.from.id;
      state.purchases.push({ chatId: q.from.id, plan: plan.id, price, ts: Date.now() });
      save();
      await awardPurchase(q.from.id, price);
      await checkLowBalance(q.from.id);
      return show(q, {
        text: `✅ Оплачено с баланса: $${price}\n\n` +
          `Ваш ключ: ${key}\n` +
          `Тариф: ${planWord(plan.days)}\n` +
          'Введите его в «Настройки и конфиденциальность → GreiTikTok».',
        markup: {
          inline_keyboard: [
            [{ text: '👤 Профиль', callback_data: 'm:profile' }],
            backRow('m:market')
          ]
        }
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
            '\nВведите его в «Настройки и конфиденциальность → GreiTikTok».'
        });
        await replyToAdmin(`✅ Ключ выдан по заявке #${order.id}: ${key}`);
        await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Ключ выдан' });
      } else {
        order.status = 'cancelled';
        save();
        await replyToAdmin(`❌ Заявка #${order.id} отменена`);
        await tg('sendMessage', {
          chat_id: order.chatId,
          text: `❌ Заявка #${order.id} отклонена.\n` +
            'Проверьте, что отправлены 15 скриншотов комментариев с картинкой мода.'
        });
        await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Отменено' });
      }
      return;
    }
    if (data === 'm:admin') return show(q, adminMenu());
    if (data === 'm:stats') return show(q, statsMenu());
    if (data === 'm:keys') return show(q, keysMenu());
    if (data === 'm:devs') return show(q, devicesMenu());
    if (data === 'm:bans') return show(q, bansMenu());
    if (data === 'm:admins') return show(q, adminsMenu());
    if (data === 'm:orders') return show(q, ordersMenu());
    if (data === 'm:promos') return show(q, promosMenu());
    if (data === 'm:tickets') return show(q, ticketsMenu());
    if (data === 'm:balances') return show(q, balancesMenu());
    if (data === 'm:users') return show(q, usersMenu());
    if (data.startsWith('user:')) {
      return show(q, userMenu(String(data.slice(5))));
    }
    if (data.startsWith('uissue:')) {
      const parts = data.split(':');
      const target = String(parts[1]);
      const days = parseInt(parts[2], 10) || 0;
      const key = newKey(days);
      const entry = findKey(key);
      if (entry) entry.chatId = target;
      save();
      await tg('sendMessage', {
        chat_id: target,
        text: `🎁 Вам выдан ключ GreiTikTok: ${key}\n` +
          `Тариф: ${days ? days + ' дней' : 'навсегда'}`
      });
      await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Ключ выдан' });
      return show(q, userMenu(target));
    }
    if (data.startsWith('uext:')) {
      const parts = data.split(':');
      const target = String(parts[1]);
      const days = parseInt(parts[2], 10) || 0;
      const mine = state.keys.filter((k) => String(k.chatId || '') === target);
      mine.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      const entry = mine.find((k) => !k.expiresAt || k.expiresAt > Date.now()) || mine[0];
      if (!entry) {
        await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'У пользователя нет ключа' });
        return show(q, userMenu(target));
      }
      if (!entry.expiresAt) {
        await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Ключ бессрочный' });
        return show(q, userMenu(target));
      }
      entry.expiresAt += days * 86400000;
      entry.planDays = Number(entry.planDays || 0) + days;
      save();
      await tg('sendMessage', {
        chat_id: target,
        text: `⏳ Подписка продлена на ${days} дн.\n` +
          `Ключ: ${entry.key}\nДо: ${new Date(entry.expiresAt).toLocaleDateString('ru-RU')}`
      });
      await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Продлено' });
      return show(q, userMenu(target));
    }
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
    if (data.startsWith('promo:newbal:')) {
      const amount = Number(data.slice(13));
      if (!amount || amount <= 0) return show(q, promosMenu());
      const code = newPromoBalance(amount);
      save();
      return show(q, {
        text: `💵 Промокод на баланс: ${code}\nСумма: $${amount.toFixed(2)}\n` +
          'Отправьте его покупателю — активирует в «Маркете».',
        markup: {
          inline_keyboard: [
            [{ text: '➕ Ещё', callback_data: 'promo:newbal:' + amount }],
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
    if (data.startsWith('dd!:')) {
      const index = parseInt(data.slice(4), 10);
      const d = state.devices[index];
      if (d) {
        state.devices.splice(index, 1);
        save();
        await tg('answerCallbackQuery', {
          callback_query_id: q.id, text: 'Устройство удалено'
        });
      } else {
        await tg('answerCallbackQuery', {
          callback_query_id: q.id, text: 'Уже удалено'
        });
      }
      return show(q, devicesMenu());
    }
    if (data.startsWith('dd:')) {
      const index = parseInt(data.slice(3), 10);
      const d = state.devices[index];
      if (!d) return show(q, devicesMenu());
      return show(q, {
        text: 'Удалить устройство из списка?\n\n' + deviceText(d) +
          '\n\nКлюч и подписка останутся, удалится только запись об устройстве.',
        markup: {
          inline_keyboard: [
            [{ text: '✅ Удалить', callback_data: 'dd!:' + index }],
            [{ text: '❌ Отмена', callback_data: 'd:' + index }]
          ]
        }
      });
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

async function startFlow(chatId, payload, cbq) {
  const isNewUser = !state.users[String(chatId)];
  const current = user(chatId);
  if (payload && payload.startsWith('ref_') && isNewUser) {
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
  const today = moscowDay();
  if (current.lastBonusDay !== today) {
    current.lastBonusDay = today;
    current.balance = Math.round((Number(current.balance || 0) + DAILY_BONUS) * 100) / 100;
    save();
    await tg('sendMessage', {
      chat_id: chatId,
      text: `🎁 Ежедневный бонус: +$${DAILY_BONUS.toFixed(2)} на баланс.`
    });
  }
  const m = mainMenuFor(chatId);
  if (cbq) return show(cbq, m);
  return sendMainMenu(chatId);
}

/** Пост в канале с APK: запоминаем сообщение, чтобы бот мог переслать файл. */
async function handleChannelPost(msg) {
  try {
    const doc = msg && msg.document;
    if (!doc) return;
    const name = String(doc.file_name || '');
    if (!name.toLowerCase().endsWith('.apk')) return;
    state.apkMessageId = msg.message_id;
    state.apkChatId = msg.chat.id;
    state.apkFileName = name;
    save();
    console.log('apk stored', name, msg.message_id);
  } catch (e) {
    console.error('channel post failed', e);
  }
}

async function handleMessage(msg) {
  const chatId = msg.chat && msg.chat.id;
  if (!chatId) return;
  const rawText = String(msg.text || '').trim();
  if (rawText.startsWith('/start')) {
    const payload = rawText.split(/\s+/)[1] || '';
    if (!isAdmin(chatId) && !(await isSubscribed(chatId))) {
      pendingStart.set(String(chatId), payload);
      return sendSubGate(chatId);
    }
    return startFlow(chatId, payload);
  }
  if (!isAdmin(chatId) && !(await isSubscribed(chatId))) return sendSubGate(chatId);
  if (msg.photo && msg.photo.length) {
    const shot = waiting.get(String(chatId));
    if (shot && shot.action === 'free_shots') {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      shot.photos.push(fileId);
      const count = shot.photos.length;
      if (count < 15) {
        return tg('sendMessage', {
          chat_id: chatId,
          text: `📸 Принято ${count}/15. Отправьте следующий скриншот.`
        });
      }
      shot.action = 'free_confirm';
      return tg('sendMessage', {
        chat_id: chatId,
        text: '📸 Получено 15/15 скриншотов.\nПодтвердите отправку заявки.',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Отправить заявку', callback_data: 'free:confirm' }],
            [{ text: '❌ Отмена', callback_data: 'free:cancel' }]
          ]
        }
      });
    }
    return;
  }
  const text = rawText;
  if (text === '/menu' || text === '/help') {
    return sendMainMenu(chatId);
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
    if (promo.type === 'balance') {
      const u = user(chatId);
      u.balance = Math.round((Number(u.balance || 0) + Number(promo.amount)) * 100) / 100;
      save();
      return tg('sendMessage', {
        chat_id: chatId,
        text: `🎟 Промокод активирован!\n+$${Number(promo.amount).toFixed(2)} на баланс.\n` +
          `Текущий баланс: $${Number(u.balance).toFixed(2)}`,
        reply_markup: {
          inline_keyboard: [
            [{ text: '🛒 Маркет', callback_data: 'm:market' }],
            [{ text: '💰 Баланс', callback_data: 'm:balance' }]
          ]
        }
      });
    }
    const key = newKey(promo.days);
    const entry = findKey(key);
    if (entry) entry.chatId = chatId;
    save();
    return tg('sendMessage', {
      chat_id: chatId,
      text: `🎟 Промокод активирован!\nВаш ключ: ${key}\n` +
        `Тариф: ${promo.days ? promo.days + ' дней' : 'навсегда'}\n` +
        'Введите его в «Настройки и конфиденциальность → GreiTikTok».'
    });
  }
  if (pendingInput && pendingInput.action === 'topup_amount' && text && !text.startsWith('/')) {
    waiting.delete(String(chatId));
    const amount = Math.round(parseFloat(text.replace(',', '.')) * 100) / 100;
    if (!isFinite(amount) || amount < 0.1 || amount > 1000) {
      return tg('sendMessage', {
        chat_id: chatId,
        text: 'Сумма должна быть от $0.10 до $1000. Попробуйте ещё раз.',
        reply_markup: { inline_keyboard: [backRow('m:topup')] }
      });
    }
    const invoice = await xrCreateInvoice(amount, chatId);
    if (!invoice) {
      return tg('sendMessage', {
        chat_id: chatId,
        text: 'Оплата временно недоступна. Попробуйте позже.'
      });
    }
    state.invoices.push({
      id: String(invoice.id),
      clientInvoiceId: invoice.clientInvoiceId,
      chatId,
      amount,
      status: 'active',
      link: invoice.link,
      createdAt: Date.now()
    });
    save();
    return tg('sendMessage', {
      chat_id: chatId,
      text: `Счёт на $${amount.toFixed(2)} создан.\nОплатите и нажмите «Я оплатил».`,
      reply_markup: {
        inline_keyboard: [
          [{ text: '💳 Оплатить через xRocket', url: invoice.link }],
          [{ text: '✅ Я оплатил', callback_data: 'top:check:' + invoice.id }],
          backRow('m:balance')
        ]
      }
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
    let usedCredit = false;
    if (usedResets >= maxResets) {
      const u = user(chatId);
      if (Number(u.resetCredits || 0) > 0) {
        u.resetCredits = Number(u.resetCredits) - 1;
        usedCredit = true;
      } else if (Number(u.balance || 0) >= RESET_PRICE) {
        u.balance = Math.round((u.balance - RESET_PRICE) * 100) / 100;
        paid = true;
      } else {
        return tg('sendMessage', {
          chat_id: chatId,
          text: `Недостаточно средств: сброс стоит $${RESET_PRICE.toFixed(2)}, ` +
            `либо пакет «3 сброса» за $1.\nБаланс: $${Number(u.balance || 0).toFixed(2)}`,
          reply_markup: {
            inline_keyboard: [
              [{ text: '➕ Пополнить', callback_data: 'm:topup' }],
              [{ text: '📦 +3 сброса — $1', callback_data: 'resetpack' }]
            ]
          }
        });
      }
    }
    entry.usedBy = null;
    entry.usedAt = 0;
    entry.resets = usedResets + 1;
    save();
    if (paid) await checkLowBalance(chatId);
    return tg('sendMessage', {
      chat_id: chatId,
      text: `✅ Привязка ключа сброшена ` +
        `${paid ? `(списано $${RESET_PRICE.toFixed(2)})` : usedCredit ? '(списан 1 сброс из пакета)' : '(бесплатно)'}.\n` +
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
        if (u.channel_post) await handleChannelPost(u.channel_post);
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
  if (req.method === 'GET' && url.pathname === '/avatar.png') {
    if (!AVATAR_BYTES) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*'
    });
    return res.end(AVATAR_BYTES);
  }
  if (req.method === 'GET' && url.pathname === '/promo.png') {
    if (!PROMO_BYTES) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*'
    });
    return res.end(PROMO_BYTES);
  }
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
  if (req.method === 'GET' && (url.pathname === '/ban' || url.pathname === '/unban')) {
    if (url.searchParams.get('token') !== ADMIN_TOKEN) return json(res, 403, { error: 'forbidden' });
    const hwid = norm(url.searchParams.get('hwid') || '');
    const key = norm(url.searchParams.get('key') || '');
    if (!hwid && !key) return json(res, 400, { error: 'hwid or key required' });
    const ban = url.pathname === '/ban';
    if (hwid) {
      const list = state.bannedHwids.map(norm);
      const has = list.includes(hwid);
      if (ban && !has) state.bannedHwids.push(hwid);
      if (!ban) state.bannedHwids = state.bannedHwids.filter((x) => norm(x) !== hwid);
    }
    if (key) {
      const list = state.bannedKeys.map(norm);
      const has = list.includes(key);
      if (ban && !has) state.bannedKeys.push(key);
      if (!ban) state.bannedKeys = state.bannedKeys.filter((x) => norm(x) !== key);
    }
    save();
    return json(res, 200, {
      ok: true,
      banned: ban,
      bannedHwids: state.bannedHwids.length,
      bannedKeys: state.bannedKeys.length
    });
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
      if (body.length > 30000) req.destroy();
    });
    req.on('end', async () => {
      try {
        if (XROCKET_WEBHOOK_TOKEN) {
          const signature = String(req.headers['signature'] || '');
          const version = String(req.headers['signature-version'] || '');
          const timestamp = String(req.headers['signature-timestamp'] || '');
          if (!signature || !timestamp || (version && version !== 'v1')) {
            console.error('webhook signature headers missing');
            json(res, 401, { ok: false });
            return;
          }
          const expected = crypto.createHmac('sha256', XROCKET_WEBHOOK_TOKEN)
            .update(timestamp + '.' + body).digest('hex');
          const a = Buffer.from(signature.toLowerCase(), 'hex');
          const b = Buffer.from(expected, 'hex');
          if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            console.error('webhook signature mismatch');
            json(res, 401, { ok: false });
            return;
          }
          if (Math.abs(Date.now() - Number(timestamp)) > 5 * 60 * 1000) {
            console.error('webhook stale');
            json(res, 401, { ok: false });
            return;
          }
        }
        const event = JSON.parse(body || '{}');
        const invoice = event && event.data && event.data.invoice;
        const paid = invoice && invoice.status === 'paid';
        if (event.type === 'invoice' && paid) {
          const inv = state.invoices.find((i) => i.id === String(invoice.id)
            || (invoice.clientInvoiceId && i.clientInvoiceId === invoice.clientInvoiceId));
          if (inv && creditInvoice(inv)) {
            console.log('webhook invoice paid: ' + invoice.id);
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
        } else if (left <= 6 * 3600000 && left > 0 && !entry.reminded6) {
          entry.reminded6 = true;
          save();
          await tg('sendMessage', {
            chat_id: entry.chatId,
            text: `⏰ Подписка GreiTikTok истекает менее чем через 6 часов (ключ ${entry.key}).`,
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
