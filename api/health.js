/* ============================================================
   Geist 云端健康检查（Vercel Serverless 函数）
   前端用 GET /api/health 探测：这条云端线路在不在、有没有配密钥
   ============================================================ */

module.exports = async function handler(req, res) {
  const key = String(process.env.GEIST_API_KEY || '').trim();
  res.status(200).json({ ok: true, keyConfigured: !!key });
};