const dns = require('dns');
const crypto = require('crypto');
const tls = require('tls');
const { MongoClient } = require('mongodb');

// Node on Windows often fails mongodb+srv SRV lookups against the local DNS
// resolver (querySrv ECONNREFUSED). Public resolvers still work.
if (process.platform === 'win32') {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
}

// OpenSSL 3.x (Node 17+) requires secure renegotiation by default, but this
// Atlas cluster's TLS layer still uses legacy renegotiation — the handshake
// dies with "SSL alert number 80" (tlsv1 alert internal error) without this.
const MONGO_SECURE_CONTEXT = tls.createSecureContext({
  secureOptions:
    crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT |
    crypto.constants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION,
});

let client;
let db;

function nowSql() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function startOfMonthSql() {
  const d = new Date();
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0));
  return utc.toISOString().replace('T', ' ').slice(0, 19);
}

function parseSql(value) {
  if (!value) return NaN;
  return Date.parse(String(value).replace(' ', 'T') + 'Z');
}

function isExpired(expiresAt) {
  const t = parseSql(expiresAt);
  return Number.isFinite(t) && Date.now() > t;
}

function addMinutesFromNow(minutes) {
  const d = new Date(Date.now() + Number(minutes) * 60000);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function minutesBetween(a, b) {
  if (!a) return 0;
  const start = parseSql(a);
  const end = parseSql(b);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, (end - start) / 60000);
}

function publicDoc(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return rest;
}

async function connect() {
  if (db) return db;
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is required (MongoDB Atlas connection string).');
    process.exit(1);
  }
  client = new MongoClient(uri, { secureContext: MONGO_SECURE_CONTEXT });
  await client.connect();
  db = client.db(process.env.MONGODB_DB || 'feonixai');
  await ensureIndexes();
  return db;
}

function col(name) {
  if (!db) throw new Error('Database not connected');
  return db.collection(name);
}

async function ensureIndexes() {
  await col('users').createIndex({ email: 1 }, { unique: true });
  await col('users').createIndex({ id: 1 }, { unique: true });
  await col('documents').createIndex({ id: 1 }, { unique: true });
  await col('documents').createIndex({ user_id: 1, kind: 1 });
  await col('usage').createIndex({ id: 1 }, { unique: true });
  await col('usage').createIndex({ user_id: 1, created_at: 1 });
  await col('usage').createIndex({ session_id: 1 });
  await col('call_sessions').createIndex({ id: 1 }, { unique: true });
  await col('call_sessions').createIndex({ user_id: 1, created_at: 1 });
  await col('transcript_lines').createIndex({ id: 1 }, { unique: true });
  await col('transcript_lines').createIndex({ session_id: 1, id: 1 });
  await col('answers').createIndex({ id: 1 }, { unique: true });
  await col('answers').createIndex({ user_id: 1, created_at: 1 });
  await col('answers').createIndex({ session_id: 1 });
  await col('credit_transactions').createIndex({ id: 1 }, { unique: true });
  await col('credit_transactions').createIndex({ user_id: 1, created_at: 1 });
  await col('credit_transactions').createIndex({ session_id: 1 });
  await col('trial_transactions').createIndex({ id: 1 }, { unique: true });
  await col('trial_transactions').createIndex({ user_id: 1 });
  await col('sessions').createIndex({ sid: 1 }, { unique: true });
  await col('sessions').createIndex({ expires: 1 });
  await col('handoff_tokens').createIndex({ token: 1 }, { unique: true });
  await col('handoff_tokens').createIndex({ expires_at: 1 });
}

async function nextId(name) {
  const result = await col('counters').findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  const doc = result && result.seq != null ? result : result && result.value;
  if (!doc || doc.seq == null) throw new Error('failed to allocate id for ' + name);
  return doc.seq;
}

async function tokensUsedThisMonth(userId) {
  const rows = await col('usage').aggregate([
    { $match: { user_id: userId, created_at: { $gte: startOfMonthSql() } } },
    { $group: { _id: null, total: { $sum: { $add: ['$prompt_tokens', '$output_tokens'] } } } },
  ]).toArray();
  return rows[0] ? rows[0].total : 0;
}

async function recordUsage(userId, model, promptTokens, outputTokens) {
  const id = await nextId('usage');
  await col('usage').insertOne({
    id,
    user_id: userId,
    model,
    prompt_tokens: promptTokens || 0,
    output_tokens: outputTokens || 0,
    session_id: null,
    created_at: nowSql(),
  });
  return id;
}

async function reserveUsage(userId, model, promptTokens, maxOutputTokens, sessionId = null) {
  const id = await nextId('usage');
  await col('usage').insertOne({
    id,
    user_id: userId,
    model,
    prompt_tokens: promptTokens || 0,
    output_tokens: maxOutputTokens || 0,
    session_id: sessionId || null,
    created_at: nowSql(),
  });
  return id;
}

async function settleUsage(usageId, promptTokens, outputTokens) {
  await col('usage').updateOne(
    { id: usageId },
    { $set: { prompt_tokens: promptTokens || 0, output_tokens: outputTokens || 0 } }
  );
}

async function loadDocContent(userId, kind, maxChars) {
  const row = await col('documents')
    .find({ user_id: userId, kind })
    .sort({ is_active: -1, id: -1 })
    .limit(1)
    .next();
  return row ? String(row.content).slice(0, maxChars) : '';
}

async function sessionTokensUsed(sessionId) {
  const rows = await col('usage').aggregate([
    { $match: { session_id: sessionId } },
    { $group: { _id: null, total: { $sum: { $add: ['$prompt_tokens', '$output_tokens'] } } } },
  ]).toArray();
  return rows[0] ? rows[0].total : 0;
}

module.exports = {
  connect,
  col,
  nextId,
  nowSql,
  startOfMonthSql,
  parseSql,
  isExpired,
  addMinutesFromNow,
  minutesBetween,
  publicDoc,
  tokensUsedThisMonth,
  recordUsage,
  reserveUsage,
  settleUsage,
  loadDocContent,
  sessionTokensUsed,
};
