/* CloudBase model proxy: only approved browser origins and provider hosts. */
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
const MAX_BODY_BYTES = 128 * 1024;
const MAX_REQUESTS = 20;
const WINDOW_MS = 60_000;
const rateBuckets = new Map();

function header(event, name) {
  const headers = event.headers || {};
  const key = Object.keys(headers).find(item => item.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : '';
}

function response(statusCode, body, origin) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Vary': 'Origin',
      ...(ORIGINS.has(origin) ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600'
      } : {}),
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(body)
  };
}

function clientIp(event) {
  const forwarded = String(header(event, 'x-forwarded-for') || '').split(',')[0].trim();
  return forwarded || String(event.requestContext && (event.requestContext.sourceIp || event.requestContext.http && event.requestContext.http.sourceIp) || 'unknown');
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

function callUpstream(provider, payload, key) {
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
    }, upstream => {
      let body = '';
      upstream.on('data', chunk => {
        body += chunk;
        if (body.length > 1024 * 1024) req.destroy(new Error('upstream response too large'));
      });
      upstream.on('end', () => resolve({ status: upstream.statusCode || 502, body }));
    });
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

exports.main = async event => {
  const origin = String(header(event, 'origin') || '').replace(/\/$/, '');
  const originAllowed = ORIGINS.has(origin);
  const method = String(event.httpMethod || event.method || 'POST').toUpperCase();
  if (method === 'OPTIONS') return originAllowed
    ? { statusCode: 204, headers: response(204, {}, origin).headers, body: '' }
    : response(403, { error: 'origin_not_allowed' }, origin);
  if (!originAllowed) return response(403, { error: 'origin_not_allowed' }, origin);
  if (method !== 'POST') return response(405, { error: 'method_not_allowed' }, origin);
  if (rateLimited(clientIp(event))) return response(429, { error: 'rate_limited' }, origin);

  let raw = event.body || '';
  if (event.isBase64Encoded && typeof raw === 'string') {
    try { raw = Buffer.from(raw, 'base64').toString('utf8'); } catch (_) { return response(400, { error: 'invalid_request' }, origin); }
  }
  if (typeof raw === 'string' && Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return response(413, { error: 'request_too_large' }, origin);
  let body;
  try {
    body = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!body || typeof body !== 'object' || Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_BODY_BYTES) throw new Error();
  } catch (_) {
    return response(400, { error: 'invalid_request' }, origin);
  }

  const userKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  const sharedKeyEnabled = process.env.GEIST_ENABLE_SHARED_KEY === 'true';
  const key = userKey || (sharedKeyEnabled ? String(process.env.GEIST_API_KEY || '').trim() : '');
  if (!key || key.length > 512) return response(503, { error: 'model_not_configured' }, origin);
  const provider = userKey
    ? PROVIDERS[String(body.base || '').replace(/\/+$/, '')]
    : PROVIDERS['https://open.bigmodel.cn/api/paas/v4'];
  if (!provider) return response(400, { error: 'unsupported_provider' }, origin);

  const messages = normalizeMessages(body.messages);
  if (!messages) return response(400, { error: 'invalid_messages' }, origin);
  const model = userKey ? String(body.model || provider.model) : String(process.env.GEIST_MODEL || provider.model);
  if (!/^[a-zA-Z0-9._:-]{1,100}$/.test(model)) return response(400, { error: 'invalid_model' }, origin);

  try {
    const upstream = await callUpstream(provider, { model, messages, temperature: 0.85, max_tokens: 700 }, key);
    if (upstream.status !== 200) {
      console.warn('[geist] upstream returned status', upstream.status);
      return response(502, { error: 'upstream_unavailable' }, origin);
    }
    return {
      statusCode: 200,
      headers: { ...response(200, {}, origin).headers, 'Content-Type': 'application/json; charset=utf-8' },
      body: upstream.body
    };
  } catch (error) {
    console.warn('[geist] upstream request failed:', error && error.message || 'unknown error');
    return response(502, { error: 'upstream_unavailable' }, origin);
  }
};
