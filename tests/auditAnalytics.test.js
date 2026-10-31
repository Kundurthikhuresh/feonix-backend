process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = ''; // Fast in-memory database
process.env.SESSION_SECRET = 'audit-test-secret-12345678901234567890';
process.env.ADMIN_EMAIL = 'admin@feonixai.com';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { PassThrough } = require('stream');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');

const { connect, col, nextId, nowSql } = require('../src/db');
const MongoSessionStore = require('../src/session-store');
const { router: authRouter } = require('../src/auth');
const adminRouter = require('../src/admin');
const { router: promotionsRouter } = require('../src/promotions');

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
        json,
        body: responseData,
        cookie: cookieHeader,
      });
    };

    if (body) {
      const payload = JSON.stringify(body);
      req.headers['content-type'] = 'application/json';
      req.headers['content-length'] = Buffer.byteLength(payload);
      app(req, res);
      req.emit('data', Buffer.from(payload));
      req.emit('end');
    } else {
      app(req, res);
      req.emit('end');
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
      store: new MongoSessionStore(),
      resave: false,
      saveUninitialized: false,
    })
  );

  app.use('/api/auth', authRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/promotions', promotionsRouter);
});

test('Audit Analytics & Financial Ledger Integration Suite', async (t) => {
  let adminCookie;
  let userCookie;
  let normalUserId;

  await t.test('1. Setup accounts (admin & customer)', async () => {
    const adminPwHash = await bcrypt.hash('AdminSecret123!', 10);
    const userPwHash = await bcrypt.hash('UserSecret123!', 10);

    const adminId = await nextId('users');
    await col('users').insertOne({
      id: adminId,
      email: 'admin@feonixai.com',
      password_hash: adminPwHash,
      role: 'admin',
      is_admin: true,
      created_at: nowSql(),
    });

    normalUserId = await nextId('users');
    await col('users').insertOne({
      id: normalUserId,
      email: 'customer@feonixai.com',
      password_hash: userPwHash,
      role: 'member',
      is_admin: false,
      created_at: nowSql(),
    });

    // Seed test data:
    // 1. Paid payment transaction
    await col('promotion_redemptions').insertOne({
      id: 1,
      user_id: normalUserId,
      user_email: 'customer@feonixai.com',
      promotion_code: 'TEST50',
      final_amount: 499,
      discount_amount: 500,
      plan: 'pro',
      redeemed_at: nowSql(),
    });

    // 2. AI token usage
    await col('usage').insertOne({
      id: 1,
      user_id: normalUserId,
      model: 'gpt-4o-mini',
      prompt_tokens: 10000,
      output_tokens: 2000,
      created_at: nowSql(),
    });

    // 3. Copilot session
    await col('call_sessions').insertOne({
      id: 1,
      user_id: normalUserId,
      company: 'Google',
      role: 'Full Stack Engineer',
      status: 'ended',
      billing_kind: 'paid',
      started_at: nowSql(),
      created_at: nowSql(),
    });

    // Login admin
    const adminLogin = await doRequest('POST', '/api/auth/login', {
      body: { email: 'admin@feonixai.com', password: 'AdminSecret123!' },
    });
    assert.equal(adminLogin.status, 200);
    adminCookie = adminLogin.cookie;

    // Login customer
    const userLogin = await doRequest('POST', '/api/auth/login', {
      body: { email: 'customer@feonixai.com', password: 'UserSecret123!' },
    });
    assert.equal(userLogin.status, 200);
    userCookie = userLogin.cookie;
  });

  await t.test('2. Authorization: Non-admin users cannot access audit analytics', async () => {
    // Unauthenticated
    const unauth = await doRequest('GET', '/api/admin/audit-analytics');
    assert.equal(unauth.status, 401);

    // Normal User
    const userAttempt = await doRequest('GET', '/api/admin/audit-analytics', { cookie: userCookie });
    assert.equal(userAttempt.status, 403);
  });

  await t.test('3. Admin can retrieve financial summary with 5 KPI metrics', async () => {
    const res = await doRequest('GET', '/api/admin/audit-analytics?range=all', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const d = res.json;

    assert.ok(d.summary, 'Summary object present');
    assert.equal(d.summary.total_revenue, 499, 'Total revenue matches redemption payment');
    assert.ok(d.summary.original_cost > 0, 'Original cost calculated from token usage');
    assert.ok(d.summary.profit > 0, 'Profit is positive');
    assert.equal(d.summary.loss, 0, 'No loss incurred');
    assert.ok(d.summary.net_earnings > 0, 'Net earnings positive');
    assert.equal(d.summary.currency, 'INR');
    assert.equal(d.summary.currency_symbol, '₹');

    // Check user-level audit ledger
    assert.ok(Array.isArray(d.users));
    const customerRow = d.users.find((u) => u.email === 'customer@feonixai.com');
    assert.ok(customerRow, 'Customer found in ledger');
    assert.equal(customerRow.paid_amount, 499);
    assert.ok(customerRow.ai_provider_cost > 0);
    assert.ok(customerRow.net_profit_loss > 0);
    assert.equal(customerRow.total_sessions, 1);
  });

  await t.test('4. Date range filters (7d, 30d, 90d, custom) function properly', async () => {
    for (const range of ['7d', '30d', '90d', 'all']) {
      const res = await doRequest('GET', `/api/admin/audit-analytics?range=${range}`, { cookie: adminCookie });
      assert.equal(res.status, 200);
      assert.equal(res.json.filter.range, range);
    }
  });

  await t.test('5. Admin can retrieve granular audit event stream', async () => {
    const res = await doRequest('GET', '/api/admin/audit-events?category=ALL&limit=10', { cookie: adminCookie });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.events));
    assert.ok(res.json.events.length > 0, 'Events stream populated');

    const firstEvt = res.json.events[0];
    assert.ok(firstEvt.timestamp);
    assert.ok(firstEvt.event_type);
    assert.ok(firstEvt.category);
    assert.ok(firstEvt.outcome);
  });
});
