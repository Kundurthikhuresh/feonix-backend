const session = require('express-session');
const { col } = require('./db');

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function expiryOf(sess) {
  const cookieExpires = sess && sess.cookie && sess.cookie.expires;
  if (cookieExpires) return new Date(cookieExpires).getTime();
  return Date.now() + DEFAULT_TTL_MS;
}

// Every API request loads the login session before anything else runs, and on
// Atlas that is a ~80ms (up to ~270ms) round trip — paid twice per live
// question (transcription + answer). Reads are served from memory for a short
// window; every write/destroy below updates the cache, so logout and login
// changes still take effect immediately in this (single) process.
const READ_CACHE_MS = 30 * 1000;
const sessionCache = new Map();

class MongoSessionStore extends session.Store {
  constructor({ pruneIntervalMs = 60 * 60 * 1000 } = {}) {
    super();
    this.pruneTimer = setInterval(() => this.prune(), pruneIntervalMs);
    if (this.pruneTimer.unref) this.pruneTimer.unref();
    this.prune();
  }

  async prune() {
    try {
      await col('sessions').deleteMany({ expires: { $lte: Date.now() } });
    } catch (err) {
      // A background maintenance sweep must never be able to take the whole
      // server down. This used to emit('error', err) for anything other
      // than the DB-not-yet-connected-at-startup case — and since nothing
      // anywhere registers an 'error' listener on this store, Node's default
      // EventEmitter behavior for an unheard 'error' event is to throw it as
      // an uncaught exception and kill the process. A transient DNS/network
      // blip during this hourly sweep (e.g. MongoServerSelectionError /
      // ENOTFOUND) should just skip this cycle and retry next time, not
      // disconnect every active session on the server.
      console.error('[session-store] prune failed, will retry next cycle:', err.message);
    }
  }

  get(sid, cb) {
    const hit = sessionCache.get(sid);
    // Destroyed here moments ago, with the database delete still in flight.
    if (hit && hit.destroyed) return cb(null, null);
    if (hit && Date.now() - hit.at < READ_CACHE_MS && hit.expires > Date.now()) {
      return cb(null, JSON.parse(hit.data));
    }
    col('sessions')
      .findOne({ sid })
      .then((row) => {
        if (!row) {
          sessionCache.delete(sid);
          return cb(null, null);
        }
        if (row.expires <= Date.now()) {
          sessionCache.delete(sid);
          return col('sessions').deleteOne({ sid }).then(() => cb(null, null));
        }
        try {
          const parsed = JSON.parse(row.data);
          sessionCache.set(sid, { data: row.data, expires: row.expires, at: Date.now() });
          return cb(null, parsed);
        } catch {
          return cb(null, null);
        }
      })
      .catch(() => cb(null, null));
  }

  set(sid, sess, cb) {
    const data = JSON.stringify(sess);
    sessionCache.set(sid, { data, expires: expiryOf(sess), at: Date.now() });
    col('sessions')
      .updateOne(
        { sid },
        { $set: { sid, expires: expiryOf(sess), data } },
        { upsert: true }
      )
      .then(() => cb(null))
      .catch((err) => cb(err));
  }

  touch(sid, sess, cb) {
    const hit = sessionCache.get(sid);
    if (hit) hit.expires = expiryOf(sess);
    col('sessions')
      .updateOne({ sid }, { $set: { expires: expiryOf(sess) } })
      .then(() => cb(null))
      .catch((err) => cb(err));
  }

  // Every sign-in and signup destroys the previous session (regenerate), and
  // waiting on that delete added a full Atlas round trip to both. The session
  // is refused at once through the cache marker; the row is deleted behind
  // the reply, with one retry.
  destroy(sid, cb) {
    sessionCache.set(sid, { destroyed: true, at: Date.now() });
    const remove = () => col('sessions').deleteOne({ sid });
    remove()
      .catch(() => remove())
      .then(() => sessionCache.delete(sid))
      .catch((err) => console.error('[session-store] destroy failed:', err.message));
    cb(null);
  }

  clear(cb) {
    sessionCache.clear();
    col('sessions')
      .deleteMany({})
      .then(() => cb(null))
      .catch((err) => cb(err));
  }

  length(cb) {
    col('sessions')
      .countDocuments({ expires: { $gt: Date.now() } })
      .then((n) => cb(null, n))
      .catch((err) => cb(err));
  }
}

async function destroyUserSessions(userId) {
  const rows = await col('sessions').find({}).toArray();
  let n = 0;
  for (const row of rows) {
    try {
      const data = JSON.parse(row.data);
      if (Number(data.userId) === Number(userId)) {
        sessionCache.delete(row.sid);
        await col('sessions').deleteOne({ sid: row.sid });
        n += 1;
      }
    } catch { /* skip */ }
  }
  return n;
}

module.exports = MongoSessionStore;
module.exports.destroyUserSessions = destroyUserSessions;
