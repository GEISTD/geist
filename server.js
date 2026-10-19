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

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    try {
      const html = fs.readFileSync(path.join(DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      sendJson(res, 500, { error: 'index.html 不存在' });
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
  console.log('  关闭服务请按 Ctrl+C');
});