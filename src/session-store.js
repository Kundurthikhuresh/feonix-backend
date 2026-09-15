const session = require('express-session');
const { col } = require('./db');

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function expiryOf(sess) {
  const cookieExpires = sess && sess.cookie && sess.cookie.expires;
  if (cookieExpires) return new Date(cookieExpires).getTime();
  return Date.now() + DEFAULT_TTL_MS;
}

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
    col('sessions')
      .findOne({ sid })
      .then((row) => {
        if (!row) return cb(null, null);
        if (row.expires <= Date.now()) {
          return col('sessions').deleteOne({ sid }).then(() => cb(null, null));
        }
        try {
          return cb(null, JSON.parse(row.data));
        } catch {
          return cb(null, null);
        }
      })
      .catch(() => cb(null, null));
  }

  set(sid, sess, cb) {
    col('sessions')
      .updateOne(
        { sid },
        { $set: { sid, expires: expiryOf(sess), data: JSON.stringify(sess) } },
        { upsert: true }
      )
      .then(() => cb(null))
      .catch((err) => cb(err));
  }

  touch(sid, sess, cb) {
    col('sessions')
      .updateOne({ sid }, { $set: { expires: expiryOf(sess) } })
      .then(() => cb(null))
      .catch((err) => cb(err));
  }

  destroy(sid, cb) {
    col('sessions')
      .deleteOne({ sid })
      .then(() => cb(null))
      .catch((err) => cb(err));
  }

  clear(cb) {
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
        await col('sessions').deleteOne({ sid: row.sid });
        n += 1;
      }
    } catch { /* skip */ }
  }
  return n;
}

module.exports = MongoSessionStore;
module.exports.destroyUserSessions = destroyUserSessions;
