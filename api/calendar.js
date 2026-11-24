// Vercel serverless function: stores the whole family calendar as one JSON value in Redis.
// Connection (set automatically when the Redis store is connected to the project):
//   REDIS_URL                                   -> standard Redis connection (node-redis)
//   or KV_REST_API_URL + KV_REST_API_TOKEN      -> Upstash REST (also UPSTASH_REDIS_REST_URL/TOKEN)
// Optional: set FAMCAL_PASSCODE in Vercel to require a passcode (sent as the x-passcode header).
// Wrong passcodes are rate-limited per IP address: MAX_FAILS wrong guesses -> locked out for LOCK_SECONDS.
const crypto = require('crypto');

const REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = 'famcal:data';
const MAX_FAILS = 5;
const LOCK_SECONDS = 15 * 60;

let client; // reused across invocations while the function instance is warm
async function tcp() {
  if (client && client.isOpen) return client;
  const { createClient } = require('redis');
  client = createClient({ url: process.env.REDIS_URL, socket: { connectTimeout: 8000 } });
  client.on('error', () => {});
  await client.connect();
  return client;
}

// Run one Redis command, e.g. redisCmd(['GET', 'key']).
async function redisCmd(args) {
  if (REST_URL && REST_TOKEN) {
    const r = await fetch(REST_URL, { method: 'POST', headers: { Authorization: `Bearer ${REST_TOKEN}` }, body: JSON.stringify(args) });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || `Redis HTTP ${r.status}`);
    return j.result;
  }
  return (await tcp()).sendCommand(args.map(String));
}

function clientIp(req) {
  const h = req.headers;
  const raw = h['x-real-ip'] || h['x-vercel-forwarded-for'] || (h['x-forwarded-for'] || '').split(',')[0] || (req.socket && req.socket.remoteAddress) || 'unknown';
  return String(raw).trim().slice(0, 64);
}

function passcodeOk(got) {
  const want = process.env.FAMCAL_PASSCODE;
  if (!want) return true;
  const a = crypto.createHash('sha256').update(String(got || '')).digest();
  const b = crypto.createHash('sha256').update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

// Sign-ins last 24 hours from the moment the passcode was entered. The token is "<expiry-ms>.<hmac>",
// signed with a key derived from the passcode, so changing the passcode also signs everyone out.
const SESSION_MS = 24 * 60 * 60 * 1000;
const signKey = () => crypto.createHash('sha256')
  .update(`famcal-session|${process.env.FAMCAL_PASSCODE}|${process.env.REDIS_URL || REST_TOKEN || ''}`).digest();
const sign = (exp) => crypto.createHmac('sha256', signKey()).update(String(exp)).digest('hex');
function makeSession() { const exp = Date.now() + SESSION_MS; return `${exp}.${sign(exp)}`; }
function sessionOk(token) {
  const [exp, sig] = String(token || '').split('.');
  if (!/^\d{10,16}$/.test(exp || '') || !sig || Number(exp) < Date.now()) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.REDIS_URL && !(REST_URL && REST_TOKEN)) {
    return res.status(500).json({ error: 'Redis environment variables are missing' });
  }

  if (process.env.FAMCAL_PASSCODE && !sessionOk(req.headers['x-session'])) {
    const failKey = `famcal:fails:${clientIp(req)}`;
    const pass = String(req.headers['x-passcode'] || '');
    // 1) locked out already?
    try {
      const fails = Number(await redisCmd(['GET', failKey])) || 0;
      if (fails >= MAX_FAILS) {
        const ttl = Number(await redisCmd(['TTL', failKey])) || LOCK_SECONDS;
        res.setHeader('Retry-After', String(Math.max(ttl, 1)));
        return res.status(429).json({ error: 'Too many wrong passcodes. Try again later.', retryAfter: Math.max(ttl, 1) });
      }
    } catch (e) { /* if the limiter can't reach Redis, fall through; the passcode check below still applies */ }

    // 2) no valid sign-in: accept the passcode (and hand back a 24-hour sign-in), or refuse.
    //    Only a wrong, non-empty passcode counts as a failed guess (an expired sign-in or a first visit does not).
    if (pass && passcodeOk(pass)) {
      res.setHeader('X-Session', makeSession());
    } else {
      if (pass) {
        try {
          const n = Number(await redisCmd(['INCR', failKey]));
          if (n === 1 || n >= MAX_FAILS) await redisCmd(['EXPIRE', failKey, LOCK_SECONDS]);
        } catch (e) { /* ignore limiter errors */ }
      }
      return res.status(401).json({ error: 'Passcode required' });
    }
  }

  try {
    if (req.method === 'GET') {
      const raw = await redisCmd(['GET', KEY]);
      if (!raw) return res.status(200).json({ members: [], events: [], updatedAt: 0 });
      return res.status(200).json(JSON.parse(raw));
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      if (!body || !Array.isArray(body.members) || !Array.isArray(body.events)) {
        return res.status(400).json({ error: 'Expected { members: [], events: [] }' });
      }
      const data = { members: body.members, events: body.events, updatedAt: Date.now() };
      const json = JSON.stringify(data);
      if (json.length > 900000) return res.status(413).json({ error: 'Calendar is too large' });
      await redisCmd(['SET', KEY, json]);
      return res.status(200).json(data);
    }
    res.setHeader('Allow', 'GET, PUT, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('calendar api error:', e && e.message);
    return res.status(500).json({ error: 'Server error' });
  }
};
