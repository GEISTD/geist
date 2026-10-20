/* ============================================================
   Geist 云端代理（Vercel Serverless 函数）
   作用：替代本机 server.js 的 /api/chat，跑在 Vercel 云端。
   - 密钥存放在 Vercel 项目设置 → Environment Variables → GEIST_API_KEY
     （服务端环境变量，访客和仓库都接触不到）
   - 与 Geist.html 同源部署，前端打开时会自动探测并启用这条线路
   - 没有密钥时返回 503，前端会自动退回免密钥线路
   ============================================================ */

const https = require('https');

const UPSTREAM_HOST = 'open.bigmodel.cn';
const UPSTREAM_PATH = '/api/paas/v4/chat/completions';

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
      timeout: 55000
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

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: '只支持 POST' }); return; }

  const key = String(process.env.GEIST_API_KEY || '').trim();
  if (!key) {
    res.status(503).json({ error: '云端还没有配置 GEIST_API_KEY 环境变量' });
    return;
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    res.status(400).json({ error: '请求体无效' });
    return;
  }

  const messages = Array.isArray(body && body.messages) ? body.messages.slice(0, 50) : null;
  if (!messages || !messages.length) {
    res.status(400).json({ error: '缺少 messages' });
    return;
  }

  const payload = {
    model: typeof body.model === 'string' && body.model ? body.model : 'glm-4-flash',
    messages,
    temperature: typeof body.temperature === 'number' ? body.temperature : 0.85,
    max_tokens: 700
  };

  try {
    const up = await callUpstream(payload, key);
    if (up.status === 200) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.status(200).send(up.body);
    } else {
      res.status(502).json({ error: 'upstream ' + up.status + ': ' + up.body.slice(0, 200) });
    }
  } catch (e) {
    res.status(502).json({ error: '无法连接智谱：' + e.message });
  }
};