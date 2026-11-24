// Vercel serverless function: stores the whole family calendar as one JSON value in Redis.
// Connection (set automatically when the Redis store is connected to the project):
//   REDIS_URL                                   -> standard Redis connection (node-redis)
//   or KV_REST_API_URL + KV_REST_API_TOKEN      -> Upstash REST (also UPSTASH_REDIS_REST_URL/TOKEN)
// Optional: set FAMCAL_PASSCODE in Vercel to require a passcode (sent as the x-passcode header).
const crypto = require('crypto');

const REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = 'famcal:data';

let client; // reused across invocations while the function instance is warm
async function tcp() {
  if (client && client.isOpen) return client;
  const { createClient } = require('redis');
  client = createClient({ url: process.env.REDIS_URL, socket: { connectTimeout: 8000 } });
  client.on('error', () => {});
  await client.connect();
  return client;
}

async function redisGet() {
  if (REST_URL && REST_TOKEN) {
    const r = await fetch(REST_URL, { method: 'POST', headers: { Authorization: `Bearer ${REST_TOKEN}` }, body: JSON.stringify(['GET', KEY]) });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || `Redis HTTP ${r.status}`);
    return j.result;
  }
  return (await tcp()).get(KEY);
}

async function redisSet(value) {
  if (REST_URL && REST_TOKEN) {
    const r = await fetch(REST_URL, { method: 'POST', headers: { Authorization: `Bearer ${REST_TOKEN}` }, body: JSON.stringify(['SET', KEY, value]) });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || `Redis HTTP ${r.status}`);
    return;
  }
  await (await tcp()).set(KEY, value);
}

function passcodeOk(req) {
  const want = process.env.FAMCAL_PASSCODE;
  if (!want) return true;
  const got = String(req.headers['x-passcode'] || '');
  const a = Buffer.from(got), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.REDIS_URL && !(REST_URL && REST_TOKEN)) {
    return res.status(500).json({ error: 'Redis environment variables are missing' });
  }
  if (!passcodeOk(req)) return res.status(401).json({ error: 'Passcode required' });

  try {
    if (req.method === 'GET') {
      const raw = await redisGet();
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
      await redisSet(json);
      return res.status(200).json(data);
    }
    res.setHeader('Allow', 'GET, PUT, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('calendar api error:', e && e.message);
    return res.status(500).json({ error: 'Server error' });
  }
};
