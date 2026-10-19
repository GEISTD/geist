/* ============================================================
   Geist 本机代理服务
   - key 保存在同目录的 key.txt 里（只放在你自己的电脑上，
     不要分享 key.txt，也不要把这个服务挂到公网）。
   - 网页通过 /api/chat 间接调用智谱，前端和访客都接触不到 key。
   启动：node server.js   （访问 http://localhost:8788）
   局域网分享：确保防火墙放行 8788 端口，朋友访问
   http://你的电脑IP:8788 （ipconfig 可查 IPv4 地址）
   ============================================================ */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 8788;
const DIR = __dirname;
const KEY_FILE = path.join(DIR, 'key.txt');
const UPSTREAM_HOST = 'open.bigmodel.cn';
const UPSTREAM_PATH = '/api/paas/v4/chat/completions';

/* ---------- 访问统计：只记录次数与 IP，不记录任何聊天内容 ---------- */
const STATS_FILE = path.join(DIR, 'stats.json');
let hits = [];
try { hits = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')).hits || []; } catch (e) { hits = []; }
let statsDirty = false;

function recordHit(req, p) {
  const counted = p === '/' || p === '/Geist.html' || p === '/index.html' || p === '/api/chat';
  if (!counted) return;
  let ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (ip === '::1' || ip === 'localhost') ip = '127.0.0.1';
  hits.push({ t: new Date().toISOString(), ip, path: p });
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

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(s);
}

function callUpstream(payload, key) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = https.request({
      hostname: UPSTREAM_HOST,
      path: UPSTREAM_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(data),
        Authorization: 'Bearer ' + key
      },
      timeout: 120000
    }, res => {
      let body = '';
      res.on('data', c => { body += c; });
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
    const key = readKey();
    if (!key) {
      sendJson(res, 503, { error: '服务器还没有配置 key（在 server.js 同目录建 key.txt 并粘贴智谱 key）' });
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      sendJson(res, 400, { error: '请求体无效' });
      return;
    }
    const messages = Array.isArray(body.messages) ? body.messages.slice(0, 50) : null;
    if (!messages || !messages.length) {
      sendJson(res, 400, { error: '缺少 messages' });
      return;
    }
    const payload = {
      model: body.model || 'glm-4-flash',
      messages,
      temperature: typeof body.temperature === 'number' ? body.temperature : 0.85,
      max_tokens: 700
    };
    try {
      const up = await callUpstream(payload, key);
      if (up.status === 200) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end(up.body);
      } else {
        sendJson(res, 502, { error: 'upstream ' + up.status + ': ' + up.body.slice(0, 200) });
      }
    } catch (e) {
      sendJson(res, 502, { error: '无法连接智谱：' + e.message });
    }
    return;
  }

  if (req.method === 'GET' && p === '/api/stats') {
    const s = statsSummary();
    const rows = s.recent.map(h => `<tr><td>${h.label}</td><td>${h.ip}</td><td>${h.path === '/api/chat' ? '聊天 1 条' : '打开页面'}</td></tr>`).join('');
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Geist 访问统计</title><meta http-equiv="refresh" content="30"><style>body{font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;background:#fff;color:#1e1e1e;margin:0;padding:32px 20px}.wrap{max-width:640px;margin:0 auto}h1{font-size:20px;font-weight:600;margin-bottom:4px}.sub{color:#9a9aa0;font-size:13px;margin-bottom:24px}.cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:28px}.card{flex:1;min-width:110px;border:1px solid #ebebee;border-radius:14px;padding:16px;text-align:center}.num{font-size:26px;font-weight:600}.lbl{font-size:12px;color:#9a9aa0;margin-top:4px}table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:8px 10px;border-bottom:1px solid #f0f0f2;text-align:left}th{color:#9a9aa0;font-weight:500;font-size:12px}.foot{color:#b5b5ba;font-size:12px;margin-top:24px}</style></head><body><div class="wrap"><h1>Geist 访问统计</h1><div class="sub">只记录次数与 IP，不记录任何聊天内容 · 每 30 秒自动刷新</div><div class="cards"><div class="card"><div class="num">${s.total}</div><div class="lbl">累计访问</div></div><div class="card"><div class="num">${s.todayCount}</div><div class="lbl">今日访问</div></div><div class="card"><div class="num">${s.pages}</div><div class="lbl">打开页面</div></div><div class="card"><div class="num">${s.chats}</div><div class="lbl">聊天条数</div></div><div class="card"><div class="num">${s.uniqIps}</div><div class="lbl">独立访客</div></div></div><table><tr><th>时间</th><th>IP</th><th>行为</th></tr>${rows || '<tr><td colspan="3" style="color:#b5b5ba">还没有访问记录</td></tr>'}</table><div class="foot">数据保存在本机 stats.json，随服务保存</div></div></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Geist 代理服务已启动');
  console.log('  本机访问：http://localhost:' + PORT);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) {
        console.log('  局域网访问：http://' + ni.address + ':' + PORT);
      }
    }
  }
  console.log('  key 状态：' + (readKey() ? '已配置' : '未配置，网页将自动退回免密钥线路'));
  console.log('  访问统计面板：http://localhost:' + PORT + '/api/stats');
  console.log('  关闭服务请按 Ctrl+C');
});