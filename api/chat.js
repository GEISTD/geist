/* Vercel proxy for OpenAI-compatible providers. Never log keys or prompts. */
const https = require('https');

const PROVIDERS = {
  'https://open.bigmodel.cn/api/paas/v4': { host: 'open.bigmodel.cn', path: '/api/paas/v4/chat/completions', model: 'glm-4-flash' },
  'https://api.deepseek.com/v1': { host: 'api.deepseek.com', path: '/v1/chat/completions', model: 'deepseek-chat' },
  'https://api.openai.com/v1': { host: 'api.openai.com', path: '/v1/chat/completions', model: 'gpt-4o-mini' },
  'https://dashscope.aliyuncs.com/compatible-mode/v1': { host: 'dashscope.aliyuncs.com', path: '/compatible-mode/v1/chat/completions', model: 'qwen-flash' }
};
const ORIGINS = new Set([
  'https://geistd.github.io',
  'https://geist-pied.vercel.app',
  'https://geist-0-d6g5tr5x0ec1493bc-1512601249.tcloudbaseapp.com',
  ...(process.env.GEIST_ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean)
]);
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 20;
const MAX_BODY_BYTES = 128 * 1024;
const rateBuckets = new Map();

function originOf(req) {
  return String(req.headers.origin || '').replace(/\/$/, '');
}

function headersFor(origin) {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
    ...(ORIGINS.has(origin) ? {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600'
    } : {})
  };
}

function send(res, origin, status, payload) {
  res.writeHead(status, headersFor(origin));
  res.end(JSON.stringify(payload));
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || String(req.socket && req.socket.remoteAddress || 'unknown');
}

function rateLimited(ip) {
  const now = Date.now();
  if (rateBuckets.size > 1000) {
    for (const [address, entry] of rateBuckets) if (now - entry.start >= WINDOW_MS) rateBuckets.delete(address);
  }
  const bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.start >= WINDOW_MS) {
    rateBuckets.set(ip, { start: now, count: 1 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > MAX_REQUESTS;
}

function normalizeMessages(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 25) return null;
  let total = 0;
  const messages = [];
  for (const item of value) {
    if (!item || !['system', 'user', 'assistant'].includes(item.role) || typeof item.content !== 'string') return null;
    total += Buffer.byteLength(item.content, 'utf8');
    if (item.content.length > 12_000 || total > 64 * 1024) return null;
    messages.push({ role: item.role, content: item.content });
  }
  return messages;
}

function upstreamRequest(provider, payload, key) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = https.request({
      hostname: provider.host,
      path: provider.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        Authorization: 'Bearer ' + key
      },
      timeout: 45_000
    }, response => {
      let body = '';
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 1024 * 1024) req.destroy(new Error('upstream response too large'));
      });
      response.on('end', () => resolve({ status: response.statusCode || 502, body }));
    });
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

module.exports = async function handler(req, res) {
  const origin = originOf(req);
  const originAllowed = ORIGINS.has(origin);
  if (req.method === 'OPTIONS') {
    if (!originAllowed) return send(res, origin, 403, { error: 'origin_not_allowed' });
    res.writeHead(204, headersFor(origin));
    return res.end();
  }
  if (!originAllowed) return send(res, origin, 403, { error: 'origin_not_allowed' });
  if (req.method !== 'POST') return send(res, origin, 405, { error: 'method_not_allowed' });
  if (Number(req.headers['content-length'] || 0) > MAX_BODY_BYTES) return send(res, origin, 413, { error: 'request_too_large' });
  if (rateLimited(clientIp(req))) return send(res, origin, 429, { error: 'rate_limited' });

  let body = req.body;
  try {
    if (typeof body === 'string') body = JSON.parse(body);
    if (!body || typeof body !== 'object' || Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_BODY_BYTES) throw new Error();
  } catch (_) {
    return send(res, origin, 400, { error: 'invalid_request' });
  }

  const userKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  const sharedKeyEnabled = process.env.GEIST_ENABLE_SHARED_KEY === 'true';
  const key = userKey || (sharedKeyEnabled ? String(process.env.GEIST_API_KEY || '').trim() : '');
  if (!key || key.length > 512) return send(res, origin, 503, { error: 'model_not_configured' });

  const provider = userKey
    ? PROVIDERS[String(body.base || '').replace(/\/+$/, '')]
    : PROVIDERS['https://open.bigmodel.cn/api/paas/v4'];
  if (!provider) return send(res, origin, 400, { error: 'unsupported_provider' });

  const messages = normalizeMessages(body.messages);
  if (!messages) return send(res, origin, 400, { error: 'invalid_messages' });
  const model = userKey ? String(body.model || provider.model) : String(process.env.GEIST_MODEL || provider.model);
  if (!/^[a-zA-Z0-9._:-]{1,100}$/.test(model)) return send(res, origin, 400, { error: 'invalid_model' });

  try {
    const result = await upstreamRequest(provider, {
      model,
      messages,
      temperature: 0.85,
      max_tokens: 700
    }, key);
    if (result.status !== 200) {
      console.warn('[geist] upstream returned status', result.status);
      return send(res, origin, 502, { error: 'upstream_unavailable' });
    }
    res.writeHead(200, headersFor(origin));
    return res.end(result.body);
  } catch (error) {
    console.warn('[geist] upstream request failed:', error && error.message || 'unknown error');
    return send(res, origin, 502, { error: 'upstream_unavailable' });
  }
};
