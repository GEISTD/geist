/* ============================================================
   Geist 聊天转发（腾讯云开发 CloudBase 云函数）
   作用：国内直连，替访客把请求转给智谱，密钥只在云端环境变量里
   - 环境变量 GEIST_API_KEY：智谱密钥（控制台「环境变量」里配置）
   - 访问地址：https://<环境ID>.service.tcloudbase.com/chat（HTTP 访问服务路由）
   - 入口用 exports.main，返回 { statusCode, headers, body }，由网关直接回给浏览器
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
      timeout: 45000
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

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify(obj)
  };
}

exports.main = async (event) => {
  const method = String(event.httpMethod || event.method || 'POST').toUpperCase();

  if (method === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      },
      body: ''
    };
  }
  if (method !== 'POST') return json(405, { error: '只支持 POST' });

  const key = String(process.env.GEIST_API_KEY || '').trim();
  if (!key) return json(503, { error: '云端还没有配置 GEIST_API_KEY 环境变量' });

  let raw = event.body || '';
  if (event.isBase64Encoded && raw) {
    try { raw = Buffer.from(raw, 'base64').toString('utf-8'); } catch (e) { /* 保持原样 */ }
  }

  let body;
  try {
    body = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    return json(400, { error: '请求体无效' });
  }

  const messages = Array.isArray(body && body.messages) ? body.messages.slice(0, 50) : null;
  if (!messages || !messages.length) return json(400, { error: '缺少 messages' });

  const payload = {
    model: typeof body.model === 'string' && body.model ? body.model : 'glm-4-flash',
    messages,
    temperature: typeof body.temperature === 'number' ? body.temperature : 0.85,
    max_tokens: 700
  };

  try {
    const up = await callUpstream(payload, key);
    if (up.status === 200) {
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        },
        body: up.body
      };
    }
    return json(502, { error: 'upstream ' + up.status + ': ' + up.body.slice(0, 200) });
  } catch (e) {
    return json(502, { error: '无法连接智谱：' + e.message });
  }
};