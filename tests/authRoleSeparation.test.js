// Comprehensive Test Suite for User and Admin Authentication Flow Separation
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = ''; // Use fast, reliable in-memory fallback store
process.env.SESSION_SECRET = 'test-secret-key-12345678901234567890';
process.env.ADMIN_EMAIL = 'admin@feonixai.com';
process.env.SMTP_HOST = ''; // Disable network SMTP during test

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { PassThrough } = require('stream');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');

const { connect, col, nextId, nowSql } = require('../src/db');
const MongoSessionStore = require('../src/session-store');
const { router: authRouter, isDesignatedAdmin } = require('../src/auth');
const adminRouter = require('../src/admin');

let app;

function doRequest(method, url, { body, cookie } = {}) {
  return new Promise((resolve) => {
    const socket = new PassThrough();
    const req = new http.IncomingMessage(socket);
    req.method = method.toUpperCase();
    req.url = url;
    req.headers = { host: 'localhost' };
    if (cookie) {
      req.headers['cookie'] = cookie;
    }

    let responseData = '';
    const res = new http.ServerResponse(req);
    res.assignSocket(socket);

    res.write = function (chunk) {
      if (chunk) responseData += Buffer.isBuffer(chunk) ? chunk.toString() : chunk;
      return true;
    };

    res.end = function (chunk) {
      if (chunk) responseData += Buffer.isBuffer(chunk) ? chunk.toString() : chunk;
      let json = null;
      try {
        json = JSON.parse(responseData);
      } catch {}
      const setCookie = res.getHeader('set-cookie');
      let cookieHeader = null;
      if (Array.isArray(setCookie)) {
        cookieHeader = setCookie[0].split(';')[0];
      } else if (typeof setCookie === 'string') {
        cookieHeader = setCookie.split(';')[0];
      }

      resolve({
        status: res.statusCode,
        headers: res.getHeaders(),
        cookie: cookieHeader,
        json,
        data: responseData,
      });
    };

    if (body) {
      const payload = typeof body === 'object' ? JSON.stringify(body) : String(body);
      req.headers['content-type'] = 'application/json';
      req.headers['content-length'] = Buffer.byteLength(payload);
      app.handle(req, res);
      req.push(payload);
      req.push(null);
    } else {
      app.handle(req, res);
      req.push(null);
    }
  });
}

before(async () => {
  await connect();

  app = express();
  app.use(express.json());
  app.use(
    session({
      name: 'sid',
      secret: process.env.SESSION_SECRET,
      store: new MongoSessionStore({ pruneIntervalMs: 24 * 3600 * 1000 }),
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: false,
        maxAge: 86400000,
      },
    })
  );

  app.use('/api/auth', authRouter);
  app.use('/api/admin', adminRouter);
});

test('1. New user registration creates a USER (member) account only', async () => {
  const email = `testuser_${Date.now()}@example.com`;
  const res = await doRequest('POST', '/api/auth/register', {
    body: { email, password: 'UserPassword123!' },
  });

  assert.equal(res.status, 201);
  assert.ok(res.json?.user);
  assert.equal(res.json.user.email, email);
  assert.equal(res.json.user.role, 'member', 'Role must strictly be member');
  assert.equal(res.json.user.is_admin, false, 'is_admin must strictly be false');

  // Verify in database
  const dbUser = await col('users').findOne({ email });
  assert.ok(dbUser);
  assert.equal(dbUser.role, 'member');
  assert.equal(dbUser.disabled, 0);
  assert.ok(dbUser.password_hash !== 'UserPassword123!', 'Password must be securely hashed');
});

test('2. Public registration cannot escalate privileges to ADMIN (Escalation Prevention)', async () => {
  const email = `attacker_${Date.now()}@example.com`;
  const res = await doRequest('POST', '/api/auth/register', {
    body: {
      email,
      password: 'AttackerPassword123!',
      role: 'admin',
      is_admin: true,
      admin_code: 'feonixadmin',
      admin_key: 'feonixadmin',
    },
  });

  assert.equal(res.status, 201);
  assert.equal(res.json?.user?.role, 'member', 'Requested admin role must be ignored');
  assert.equal(res.json?.user?.is_admin, false, 'Requested is_admin must be false');

  const dbUser = await col('users').findOne({ email });
  assert.equal(dbUser.role, 'member');
});

test('3. User login authenticates normal user and validates USER role', async () => {
  const email = `candidate_${Date.now()}@example.com`;
  const password = 'CandidatePass123!';
  await doRequest('POST', '/api/auth/register', {
    body: { email, password },
  });

  // Login as user
  const res = await doRequest('POST', '/api/auth/login', {
    body: { email, password, role: 'user' },
  });

  assert.equal(res.status, 200);
  assert.ok(res.cookie, 'HttpOnly session cookie must be set');
  assert.equal(res.json.user.email, email);
  assert.equal(res.json.user.role, 'member');
  assert.equal(res.json.user.is_admin, false);
});

test('4. Incorrect credentials are appropriately rejected with HTTP 401', async () => {
  const res = await doRequest('POST', '/api/auth/login', {
    body: { email: 'nonexistent@example.com', password: 'WrongPassword' },
  });

  assert.equal(res.status, 401);
  assert.equal(res.json.error, 'invalid_credentials');
});

test('5. Non-admin user cannot use Admin Login (HTTP 403 Forbidden)', async () => {
  const email = `regular_${Date.now()}@example.com`;
  const password = 'RegularPassword123!';
  await doRequest('POST', '/api/auth/register', {
    body: { email, password },
  });

  // Attempt Admin Login with regular user credentials
  const res = await doRequest('POST', '/api/auth/login', {
    body: { email, password, role: 'admin' },
  });

  assert.equal(res.status, 403);
  assert.equal(res.json.error, 'not_an_admin');
});

test('6. Normal USER session cannot access Admin APIs (HTTP 403 Forbidden)', async () => {
  const email = `user_guarded_${Date.now()}@example.com`;
  const password = 'GuardedPass123!';
  const regRes = await doRequest('POST', '/api/auth/register', {
    body: { email, password },
  });
  const cookie = regRes.cookie;

  const adminEndpoints = [
    '/api/admin/overview',
    '/api/admin/users',
    '/api/admin/sessions',
    '/api/admin/settings',
    '/api/admin/subscriptions',
  ];

  for (const ep of adminEndpoints) {
    const res = await doRequest('GET', ep, { cookie });
    assert.equal(res.status, 403, `Normal user must receive 403 Forbidden on ${ep}`);
    assert.equal(res.json?.error, 'forbidden');
  }
});

test('7. Unauthenticated request to Admin APIs returns HTTP 401 Unauthenticated', async () => {
  const res = await doRequest('GET', '/api/admin/overview');
  assert.equal(res.status, 401);
  assert.equal(res.json?.error, 'unauthenticated');
});

test('8. Provisioned ADMIN can login via Admin Login and access Admin APIs', async () => {
  const adminEmail = 'admin@feonixai.com';
  const adminPassword = 'SuperSecretAdmin123!';
  const passwordHash = await bcrypt.hash(adminPassword, 12);

  // Securely provision admin in collection
  const id = await nextId('users');
  await col('users').insertOne({
    id,
    email: adminEmail,
    password_hash: passwordHash,
    role: 'owner',
    token_quota: 100000,
    disabled: 0,
    created_at: nowSql(),
  });

  // Admin logs in via Admin Login
  const loginRes = await doRequest('POST', '/api/auth/login', {
    body: { email: adminEmail, password: adminPassword, role: 'admin' },
  });

  assert.equal(loginRes.status, 200);
  assert.equal(loginRes.json.user.role, 'owner');
  assert.equal(loginRes.json.user.is_admin, true);

  const adminCookie = loginRes.cookie;

  // Admin calls admin APIs
  const overviewRes = await doRequest('GET', '/api/admin/overview', { cookie: adminCookie });
  assert.equal(overviewRes.status, 200, 'Admin can access overview');
  assert.ok(overviewRes.json?.kpis);
});

test('9. Session preservation and invalidation on logout', async () => {
  const email = `session_user_${Date.now()}@example.com`;
  const password = 'SessionUserPass1!';
  const regRes = await doRequest('POST', '/api/auth/register', {
    body: { email, password },
  });
  const cookie = regRes.cookie;

  // Validate active session
  const meRes = await doRequest('GET', '/api/auth/me', { cookie });
  assert.equal(meRes.status, 200);
  assert.equal(meRes.json.user.email, email);

  // Logout
  const logoutRes = await doRequest('POST', '/api/auth/logout', { cookie });
  assert.equal(logoutRes.status, 204);

  // Subsequent check is rejected with 401
  const afterLogout = await doRequest('GET', '/api/auth/me', { cookie });
  assert.equal(afterLogout.status, 401);
});

test('10. Secure server-side admin provisioning verifies hash and credentials', async () => {
  const provisionedEmail = `ops_admin_${Date.now()}@feonixai.com`;
  const plainPassword = 'OpsAdminSecret2026!';
  const usersCollection = col('users');

  // Simulate server-side provisioning
  const passwordHash = await bcrypt.hash(plainPassword, 12);
  const id = await nextId('users');
  await usersCollection.insertOne({
    id,
    email: provisionedEmail,
    password_hash: passwordHash,
    role: 'owner',
    token_quota: 100000,
    disabled: 0,
    created_at: nowSql(),
  });

  const savedUser = await usersCollection.findOne({ email: provisionedEmail });
  assert.ok(savedUser);
  assert.equal(savedUser.role, 'owner');
  assert.notEqual(savedUser.password_hash, plainPassword, 'Plaintext passwords must never be stored');
  const validHash = await bcrypt.compare(plainPassword, savedUser.password_hash);
  assert.equal(validHash, true);

  // Authenticate provisioned admin via Admin Login
  const loginRes = await doRequest('POST', '/api/auth/login', {
    body: { email: provisionedEmail, password: plainPassword, role: 'admin' },
  });
  assert.equal(loginRes.status, 200);
  assert.equal(loginRes.json.user.role, 'owner');
  assert.equal(loginRes.json.user.is_admin, true);
});

test('11. Direct API access without session cookie is completely rejected', async () => {
  const protectedEndpoints = [
    { method: 'GET', url: '/api/auth/me' },
    { method: 'GET', url: '/api/admin/overview' },
    { method: 'GET', url: '/api/admin/users' },
    { method: 'GET', url: '/api/admin/sessions' },
  ];

  for (const ep of protectedEndpoints) {
    const res = await doRequest(ep.method, ep.url);
    assert.equal(res.status, 401, `Direct access to ${ep.url} without session must return 401`);
  }
});
