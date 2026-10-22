/* ============================================================
   Geist 本机代理服务
   - key 可保存在环境变量或同目录的 key.txt 中。
   - 默认只监听本机回环地址，不要用公网隧道暴露这个开发代理。
   - 网页通过 /api/chat 间接调用模型；用户 key 仅在请求中转发，不写入文件。
   启动：node server.js   （访问 http://localhost:8788）
   ============================================================ */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8788;
const DIR = __dirname;
const KEY_FILE = path.join(DIR, 'key.txt');
const PROVIDERS = {
  'https://open.bigmodel.cn/api/paas/v4': { host: 'open.bigmodel.cn', path: '/api/paas/v4/chat/completions', model: 'glm-4-flash' },
  'https://api.deepseek.com/v1': { host: 'api.deepseek.com', path: '/v1/chat/completions', model: 'deepseek-chat' },
  'https://api.openai.com/v1': { host: 'api.openai.com', path: '/v1/chat/completions', model: 'gpt-4o-mini' },
  'https://dashscope.aliyuncs.com/compatible-mode/v1': { host: 'dashscope.aliyuncs.com', path: '/compatible-mode/v1/chat/completions', model: 'qwen-flash' }
};
const MAX_BODY_BYTES = 128 * 1024;
const MAX_REQUESTS = 30;
const WINDOW_MS = 60_000;
const rateBuckets = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.start >= WINDOW_MS) {
    rateBuckets.set(ip, { start: now, count: 1 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > MAX_REQUESTS;
}

function validMessages(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 25) return null;
  let total = 0;
  for (const message of value) {
    if (!message || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string') return null;
    total += Buffer.byteLength(message.content, 'utf8');
    if (message.content.length > 12_000 || total > 64 * 1024) return null;
  }
  return value.map(message => ({ role: message.role, content: message.content }));
}

/* ---------- 访问统计：只记录次数与 IP，不记录任何聊天内容 ---------- */
const STATS_FILE = path.join(DIR, 'stats.json');
let hits = [];
try {
  const stored = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
  hits = Array.isArray(stored.hits) ? stored.hits : [];
} catch (e) { hits = []; }
const retentionCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
const storedHitCount = hits.length;
hits = hits.filter(hit => hit && Date.parse(hit.t) >= retentionCutoff);
let statsDirty = hits.length !== storedHitCount;

function recordHit(req, p) {
  const counted = p === '/' || p === '/Geist.html' || p === '/index.html' || p === '/api/chat';
  if (!counted) return;
  let ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (ip === '::1' || ip === 'localhost') ip = '127.0.0.1';
  hits.push({ t: new Date().toISOString(), ip, path: p });
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  hits = hits.filter(hit => Date.parse(hit.t) >= cutoff);
  if (hits.length > 5000) hits.splice(0, hits.length - 5000);
  statsDirty = true;
}

function flushStats() {
  if (!statsDirty) return;
  statsDirty = false;
  try { fs.writeFileSync(STATS_FILE, JSON.stringify({ hits })); } catch (e) {}
}
setInterval(flushStats, 30000);
process.on('SIGINT', () => { flushStats(); process.exit(0); });

function statsSummary() {
  const pad2 = n => String(n).padStart(2, '0');
  const localDateKey = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const localDateTime = iso => {
    const d = new Date(iso);
    return `${localDateKey(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  };
  const today = localDateKey(new Date());
  const pages = hits.filter(h => h.path === '/' || h.path === '/Geist.html' || h.path === '/index.html').length;
  const chats = hits.filter(h => h.path === '/api/chat').length;
  const todayHits = hits.filter(h => localDateKey(new Date(h.t)) === today);
  const uniqIps = new Set(hits.map(h => h.ip)).size;
  const recent = hits.slice(-15).reverse().map(h => ({ ...h, label: localDateTime(h.t) }));
  return { total: hits.length, pages, chats, todayCount: todayHits.length, uniqIps, recent };
}

function readKey() {
  const env = String(process.env.GEIST_API_KEY || '').trim();
  if (env) return env;
  try { return fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch (e) { return ''; }
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let tooLarge = false;
    req.on('data', c => {
      size += c.length;
      if (size > limit) {
        if (!tooLarge) { tooLarge = true; reject(new Error('body too large')); }
        return;
      }
      if (!tooLarge) chunks.push(c);
    });
    req.on('end', () => { if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}

function callUpstream(provider, payload, key) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = https.request({
      hostname: provider.host,
      path: provider.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(data),
        Authorization: 'Bearer ' + key
      },
      timeout: 120000
    }, res => {
      let body = '';
      res.on('data', c => {
        body += c;
        if (body.length > 1024 * 1024) req.destroy(new Error('upstream response too large'));
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  recordHit(req, p);

  if (req.method === 'GET' && (p === '/' || p === '/Geist.html' || p === '/index.html')) {
    try {
      const html = fs.readFileSync(path.join(DIR, 'Geist.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      sendJson(res, 500, { error: 'Geist.html 不存在' });
    }
    return;
  }

  if (req.method === 'GET' && p === '/api/health') {
    sendJson(res, 200, { ok: true, keyConfigured: !!readKey() });
    return;
  }

  if (req.method === 'POST' && p === '/api/chat') {
    const ip = String(req.socket.remoteAddress || 'local');
    if (rateLimited(ip)) {
      sendJson(res, 429, { error: '请求过于频繁，请稍后再试。' });
      return;
    }
    if (Number(req.headers['content-length'] || 0) > MAX_BODY_BYTES) {
      sendJson(res, 413, { error: '请求内容过大。' });
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      sendJson(res, e && e.message === 'body too large' ? 413 : 400, { error: e && e.message === 'body too large' ? '请求内容过大。' : '请求内容无效。' });
      return;
    }
    if (!body || typeof body !== 'object' || Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_BODY_BYTES) {
      sendJson(res, 400, { error: '请求内容无效。' });
      return;
    }
    const messages = validMessages(body.messages);
    if (!messages) { sendJson(res, 400, { error: '消息格式无效或超出长度限制。' }); return; }

    const userKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    const key = userKey || readKey();
    if (!key || key.length > 512) { sendJson(res, 503, { error: '模型尚未配置，请在偏好中填写 API key 或配置本机服务密钥。' }); return; }
    const provider = userKey ? PROVIDERS[String(body.base || '').replace(/\/+$/, '')] : PROVIDERS['https://open.bigmodel.cn/api/paas/v4'];
    if (!provider) { sendJson(res, 400, { error: '暂不支持该模型服务地址。' }); return; }
    const model = userKey ? String(body.model || provider.model) : String(process.env.GEIST_MODEL || provider.model);
    if (!/^[a-zA-Z0-9._:-]{1,100}$/.test(model)) { sendJson(res, 400, { error: '模型名称无效。' }); return; }
    const payload = {
      model,
      messages,
      temperature: 0.85,
      max_tokens: 700
    };
    try {
      const up = await callUpstream(provider, payload, key);
      if (up.status === 200) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(up.body);
      } else {
        console.warn('[geist] upstream returned status', up.status);
        sendJson(res, 502, { error: '模型服务暂时不可用。' });
      }
    } catch (e) {
      console.warn('[geist] upstream request failed:', e && e.message || 'unknown error');
      sendJson(res, 502, { error: '无法连接模型服务，请稍后再试。' });
    }
    return;
  }

  if (req.method === 'GET' && p === '/api/stats') {
    const remote = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (!['127.0.0.1', '::1'].includes(remote)) { sendJson(res, 403, { error: 'forbidden' }); return; }
    const s = statsSummary();
    const rows = s.recent.map(h => `<tr><td>${h.label}</td><td>${h.ip}</td><td>${h.path === '/api/chat' ? '聊天 1 条' : '打开页面'}</td></tr>`).join('');
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Geist 访问统计</title><meta http-equiv="refresh" content="30"><style>body{font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;background:#fff;color:#1e1e1e;margin:0;padding:32px 20px}.wrap{max-width:640px;margin:0 auto}h1{font-size:20px;font-weight:600;margin-bottom:4px}.sub{color:#9a9aa0;font-size:13px;margin-bottom:24px}.cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:28px}.card{flex:1;min-width:110px;border:1px solid #ebebee;border-radius:14px;padding:16px;text-align:center}.num{font-size:26px;font-weight:600}.lbl{font-size:12px;color:#9a9aa0;margin-top:4px}table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:8px 10px;border-bottom:1px solid #f0f0f2;text-align:left}th{color:#9a9aa0;font-weight:500;font-size:12px}.foot{color:#b5b5ba;font-size:12px;margin-top:24px}</style></head><body><div class="wrap"><h1>Geist 访问统计</h1><div class="sub">只记录次数与 IP，不记录任何聊天内容 · 每 30 秒自动刷新</div><div class="cards"><div class="card"><div class="num">${s.total}</div><div class="lbl">累计访问</div></div><div class="card"><div class="num">${s.todayCount}</div><div class="lbl">今日访问</div></div><div class="card"><div class="num">${s.pages}</div><div class="lbl">打开页面</div></div><div class="card"><div class="num">${s.chats}</div><div class="lbl">聊天条数</div></div><div class="card"><div class="num">${s.uniqIps}</div><div class="lbl">独立访客</div></div></div><table><tr><th>时间</th><th>IP</th><th>行为</th></tr>${rows || '<tr><td colspan="3" style="color:#b5b5ba">还没有访问记录</td></tr>'}</table><div class="foot">数据保存在本机 stats.json，随服务保存</div></div></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Geist 代理服务已启动');
  console.log('  本机访问：http://127.0.0.1:' + PORT);
  console.log('  key 状态：' + (readKey() ? '已配置' : '未配置，请在网页偏好中填写个人 API key'));
  console.log('  安全提示：服务仅监听本机，不要通过公网隧道暴露');
  console.log('  访问统计面板：http://127.0.0.1:' + PORT + '/api/stats');
  console.log('  关闭服务请按 Ctrl+C');
});
