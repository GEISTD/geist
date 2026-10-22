const test = require('node:test');
const assert = require('node:assert/strict');

const cloudChat = require('../cloudbase/chat/index.js');
const vercelChat = require('../api/chat.js');

const allowedOrigin = 'https://geistd.github.io';

function withNoServerKey(fn) {
  const previous = process.env.GEIST_API_KEY;
  const previousEnabled = process.env.GEIST_ENABLE_SHARED_KEY;
  delete process.env.GEIST_API_KEY;
  delete process.env.GEIST_ENABLE_SHARED_KEY;
  return Promise.resolve().then(fn).finally(() => {
    if (previous === undefined) delete process.env.GEIST_API_KEY;
    else process.env.GEIST_API_KEY = previous;
    if (previousEnabled === undefined) delete process.env.GEIST_ENABLE_SHARED_KEY;
    else process.env.GEIST_ENABLE_SHARED_KEY = previousEnabled;
  });
}

function mockResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(body = '') { this.body = body; }
  };
}

test('CloudBase only grants CORS to configured origins', async () => {
  const allowed = await cloudChat.main({
    httpMethod: 'OPTIONS',
    headers: { origin: allowedOrigin }
  });
  assert.equal(allowed.statusCode, 204);
  assert.equal(allowed.headers['Access-Control-Allow-Origin'], allowedOrigin);

  const denied = await cloudChat.main({
    httpMethod: 'OPTIONS',
    headers: { origin: 'https://untrusted.example' }
  });
  assert.equal(denied.statusCode, 403);
});

test('CloudBase rejects missing keys and unsupported proxy destinations', async () => {
  await withNoServerKey(async () => {
    const missingKey = await cloudChat.main({
      httpMethod: 'POST',
      headers: { origin: allowedOrigin, 'x-forwarded-for': '192.0.2.1' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] })
    });
    assert.equal(missingKey.statusCode, 503);

    const unsupported = await cloudChat.main({
      httpMethod: 'POST',
      headers: { origin: allowedOrigin, 'x-forwarded-for': '192.0.2.2' },
      body: JSON.stringify({
        apiKey: 'test-key-not-secret',
        base: 'https://untrusted.example/v1',
        model: 'test-model',
        messages: [{ role: 'user', content: 'hello' }]
      })
    });
    assert.equal(unsupported.statusCode, 400);
  });
});

test('shared server keys stay disabled unless explicitly enabled', async () => {
  const previous = process.env.GEIST_API_KEY;
  const previousEnabled = process.env.GEIST_ENABLE_SHARED_KEY;
  process.env.GEIST_API_KEY = 'test-key-not-secret';
  delete process.env.GEIST_ENABLE_SHARED_KEY;
  try {
    const result = await cloudChat.main({
      httpMethod: 'POST',
      headers: { origin: allowedOrigin, 'x-forwarded-for': '192.0.2.4' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] })
    });
    assert.equal(result.statusCode, 503);
  } finally {
    if (previous === undefined) delete process.env.GEIST_API_KEY;
    else process.env.GEIST_API_KEY = previous;
    if (previousEnabled === undefined) delete process.env.GEIST_ENABLE_SHARED_KEY;
    else process.env.GEIST_ENABLE_SHARED_KEY = previousEnabled;
  }
});

test('Vercel proxy rejects unapproved origins and requires a configured key', async () => {
  await withNoServerKey(async () => {
    const deniedResponse = mockResponse();
    await vercelChat({ method: 'POST', headers: { origin: 'https://untrusted.example' }, body: {} }, deniedResponse);
    assert.equal(deniedResponse.statusCode, 403);

    const missingKeyResponse = mockResponse();
    await vercelChat({
      method: 'POST',
      headers: { origin: allowedOrigin, 'content-length': '70', 'x-forwarded-for': '192.0.2.3' },
      body: { messages: [{ role: 'user', content: 'hello' }] }
    }, missingKeyResponse);
    assert.equal(missingKeyResponse.statusCode, 503);
  });
});
