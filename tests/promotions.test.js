process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = ''; // Use fast, reliable in-memory fallback store
process.env.SESSION_SECRET = 'test-secret-key-12345678901234567890';
process.env.ADMIN_EMAIL = 'admin@feonixai.com';
process.env.SMTP_HOST = '';

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
const razorpayRouter = require('../src/razorpay');
const { router: promotionsRouter } = require('../src/promotions');
const credits = require('../src/credits');

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
        body: json || responseData,
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
  app.use('/api/razorpay', razorpayRouter);
  app.use('/api/promotions', promotionsRouter);
});

test('Promotions System Integration Suite', async (t) => {
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
      email: 'customer@example.com',
      password_hash: userPwHash,
      role: 'member',
      is_admin: false,
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
      body: { email: 'customer@example.com', password: 'UserSecret123!' },
    });
    assert.equal(userLogin.status, 200);
    userCookie = userLogin.cookie;
  });

  await t.test('2. Authorization: Normal user cannot access /api/admin/promotions', async () => {
    const forbiddenRes = await doRequest('GET', '/api/admin/promotions', { cookie: userCookie });
    assert.equal(forbiddenRes.status, 403);
  });

  let promo50Id;
  await t.test('3. Admin can create, view, and list promotions (KPIs included)', async () => {
    // Create percentage promo
    const createRes = await doRequest('POST', '/api/admin/promotions', {
      cookie: adminCookie,
      body: {
        name: 'Halfoff Special',
        code: 'FEONIX50',
        description: '50% off all plans',
        offer_type: 'percentage_discount',
        discount_percent: 50,
        per_user_limit: 1,
        eligible_products: ['all'],
        is_public: true,
        status: 'active',
      },
    });
    assert.equal(createRes.status, 201);
    assert.equal(createRes.body.promotion.code, 'FEONIX50');
    promo50Id = createRes.body.promotion.id;

    // Create bonus credit bundle promo
    const bonusRes = await doRequest('POST', '/api/admin/promotions', {
      cookie: adminCookie,
      body: {
        name: 'Bonus Credits Deal',
        code: 'BONUS2',
        description: 'Get 2 extra promotional credits on pack_6',
        offer_type: 'bonus_credits',
        bonus_credits: 2,
        eligible_products: ['pack_6'],
        is_public: true,
        status: 'active',
      },
    });
    assert.equal(bonusRes.status, 201);
    assert.equal(bonusRes.body.promotion.code, 'BONUS2');

    // List promotions as admin & verify 5 KPIs
    const listRes = await doRequest('GET', '/api/admin/promotions', { cookie: adminCookie });
    assert.equal(listRes.status, 200);
    assert.ok(listRes.body.kpis);
    assert.equal(listRes.body.kpis.total, 2);
    assert.equal(listRes.body.kpis.active, 2);
    assert.equal(listRes.body.kpis.total_redemptions, 0);
    assert.equal(listRes.body.promotions.length, 2);
  });

  await t.test('4. Public endpoint GET /api/promotions/active lists public active deals', async () => {
    const publicRes = await doRequest('GET', '/api/promotions/active');
    assert.equal(publicRes.status, 200);
    assert.ok(Array.isArray(publicRes.body.promotions));
    const codes = publicRes.body.promotions.map((p) => p.code);
    assert.ok(codes.includes('FEONIX50'));
    assert.ok(codes.includes('BONUS2'));
  });

  await t.test('5. Customer coupon validation rules', async () => {
    // 5.1 Valid percentage coupon
    const valid50 = await doRequest('POST', '/api/promotions/validate', {
      cookie: userCookie,
      body: { code: 'FEONIX50', plan: 'sub_monthly' },
    });
    assert.equal(valid50.status, 200);
    assert.equal(valid50.body.valid, true);
    assert.equal(valid50.body.discount_amount, 2367.5); // 50% of 4735

    // 5.2 Product eligibility check: BONUS2 only valid for pack_6
    const invalidPlan = await doRequest('POST', '/api/promotions/validate', {
      cookie: userCookie,
      body: { code: 'BONUS2', plan: 'pack_1' },
    });
    assert.equal(invalidPlan.status, 400);
    assert.equal(invalidPlan.body.error, 'ineligible_product');

    // 5.3 Non-existent coupon
    const notFound = await doRequest('POST', '/api/promotions/validate', {
      cookie: userCookie,
      body: { code: 'NONEXISTENT', plan: 'sub_monthly' },
    });
    assert.equal(notFound.status, 400);
    assert.equal(notFound.body.error, 'not_found');
  });

  await t.test('6. Payment flow with promotion (Discount + Bonus credits grant)', async () => {
    const initialBal = await credits.creditBalance(normalUserId);
    assert.equal(initialBal, 0);

    // Pay via UPI with BONUS2 on pack_6
    const upiRes = await doRequest('POST', '/api/razorpay/pay-upi', {
      cookie: userCookie,
      body: {
        plan: 'pack_6',
        upiId: 'customer@okhdfcbank',
        coupon_code: 'BONUS2',
      },
    });
    assert.equal(upiRes.status, 200);
    assert.equal(upiRes.body.success, true);

    // pack_6 grants 8 credits base + 2 bonus credits = 10 credits total!
    const updatedBal = await credits.creditBalance(normalUserId);
    assert.equal(updatedBal, 10);

    // Verify redemption record was inserted
    const redemption = await col('promotion_redemptions').findOne({ user_id: normalUserId, promotion_code: 'BONUS2' });
    assert.ok(redemption);
    assert.equal(redemption.bonus_credits, 2);

    // Verify promotion redemption_count incremented
    const updatedPromo = await col('promotions').findOne({ code: 'BONUS2' });
    assert.equal(updatedPromo.redemption_count, 1);
  });

  await t.test('7. Per-user redemption limit enforced on subsequent purchase', async () => {
    // Attempt to redeem BONUS2 again for the same user
    const secondTry = await doRequest('POST', '/api/promotions/validate', {
      cookie: userCookie,
      body: { code: 'BONUS2', plan: 'pack_6' },
    });
    assert.equal(secondTry.status, 400);
    assert.equal(secondTry.body.error, 'user_limit_reached');
  });

  await t.test('8. Admin toggle status and delete promotion', async () => {
    // Toggle active to inactive
    const toggleRes = await doRequest('PATCH', `/api/admin/promotions/${promo50Id}/status`, {
      cookie: adminCookie,
    });
    assert.equal(toggleRes.status, 200);
    assert.equal(toggleRes.body.promotion.status, 'inactive');

    // Inactive promo is now rejected by validation
    const valRes = await doRequest('POST', '/api/promotions/validate', {
      cookie: userCookie,
      body: { code: 'FEONIX50', plan: 'sub_monthly' },
    });
    assert.equal(valRes.status, 400);
    assert.equal(valRes.body.error, 'inactive');

    // Delete promotion
    const delRes = await doRequest('DELETE', `/api/admin/promotions/${promo50Id}`, {
      cookie: adminCookie,
    });
    assert.equal(delRes.status, 200);

    // Verify audit log has PROMOTION_DELETED
    const audit = await col('audit_logs').findOne({ action: 'PROMOTION_DELETED' });
    assert.ok(audit);
  });
});

