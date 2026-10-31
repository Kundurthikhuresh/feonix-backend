// The login-session read cache must never outlive a logout or a forced sign-out.
// Runs against the backend's in-memory database fallback, not Atlas.
process.env.MONGODB_URI = '';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { connect } = require('../src/db');
const MongoSessionStore = require('../src/session-store');
const { destroyUserSessions } = require('../src/session-store');

const call = (fn, ...args) => new Promise((resolve, reject) => fn(...args, (err, val) => (err ? reject(err) : resolve(val))));
const future = () => ({ cookie: { expires: new Date(Date.now() + 3600 * 1000).toISOString() } });

let store;
before(async () => {
  await connect();
  store = new MongoSessionStore({ pruneIntervalMs: 24 * 3600 * 1000 });
});

test('a saved login is read back', async () => {
  await call(store.set.bind(store), 'sid-1', { ...future(), userId: 7 });
  const sess = await call(store.get.bind(store), 'sid-1');
  assert.equal(sess.userId, 7);
});

test('logout (destroy) takes effect immediately despite the cache', async () => {
  await call(store.set.bind(store), 'sid-2', { ...future(), userId: 8 });
  await call(store.get.bind(store), 'sid-2');
  await call(store.destroy.bind(store), 'sid-2');
  assert.equal(await call(store.get.bind(store), 'sid-2'), null);
});

test('forced sign-out of a user (destroyUserSessions) clears cached logins', async () => {
  await call(store.set.bind(store), 'sid-3', { ...future(), userId: 9 });
  await call(store.get.bind(store), 'sid-3');
  await destroyUserSessions(9);
  assert.equal(await call(store.get.bind(store), 'sid-3'), null);
});

test('an updated session is returned, not a stale cached copy', async () => {
  await call(store.set.bind(store), 'sid-4', { ...future(), userId: 10 });
  await call(store.get.bind(store), 'sid-4');
  await call(store.set.bind(store), 'sid-4', { ...future(), userId: 11 });
  assert.equal((await call(store.get.bind(store), 'sid-4')).userId, 11);
});

test('an expired session is not served from the cache', async () => {
  await call(store.set.bind(store), 'sid-5', { cookie: { expires: new Date(Date.now() - 1000).toISOString() }, userId: 12 });
  assert.equal(await call(store.get.bind(store), 'sid-5'), null);
});
