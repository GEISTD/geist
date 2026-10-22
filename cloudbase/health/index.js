/* ============================================================
   Geist 健康检查（腾讯云开发 CloudBase 云函数）
   前端 GET https://<环境ID>.service.tcloudbase.com/health
   返回 { ok, keyConfigured }，页面据此判断国内线路是否可用
   ============================================================ */

const ORIGINS = new Set([
  'https://geistd.github.io',
  'https://geist-pied.vercel.app',
  'https://geist-0-d6g5tr5x0ec1493bc-1512601249.tcloudbaseapp.com',
  ...(process.env.GEIST_ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean)
]);

function header(event, name) {
  const headers = event.headers || {};
  const key = Object.keys(headers).find(item => item.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : '';
}

exports.main = async event => {
  const origin = String(header(event, 'origin') || '').replace(/\/$/, '');
  const cors = ORIGINS.has(origin) ? {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600'
  } : {};
  const method = String(event.httpMethod || event.method || 'GET').toUpperCase();

  if (method === 'OPTIONS') {
    if (!ORIGINS.has(origin)) return { statusCode: 403, headers: { 'Cache-Control': 'no-store' }, body: '' };
    return {
      statusCode: 204,
      headers: cors,
      body: ''
    };
  }
  if (origin && !ORIGINS.has(origin)) return { statusCode: 403, headers: { 'Cache-Control': 'no-store' }, body: '' };

  const key = process.env.GEIST_ENABLE_SHARED_KEY === 'true' && String(process.env.GEIST_API_KEY || '').trim();
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...cors,
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify({ ok: true, keyConfigured: !!key })
  };
};
