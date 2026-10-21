/* ============================================================
   Geist 健康检查（腾讯云开发 CloudBase 云函数）
   前端 GET https://<环境ID>.service.tcloudbase.com/health
   返回 { ok, keyConfigured }，页面据此判断国内线路是否可用
   ============================================================ */

exports.main = async (event) => {
  const method = String(event.httpMethod || event.method || 'GET').toUpperCase();

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

  const key = String(process.env.GEIST_API_KEY || '').trim();
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify({ ok: true, keyConfigured: !!key })
  };
};