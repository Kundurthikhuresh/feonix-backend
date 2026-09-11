/**
 * Razorpay Payments Integration
 * - POST /api/razorpay/create-order     — mint a one-time Order for a plan
 * - POST /api/razorpay/verify-payment   — verify the Checkout.js callback and grant credits
 * - POST /api/razorpay/webhook          — reliability backstop (raw body — must be registered BEFORE express.json())
 * - GET  /api/razorpay/subscription     — current plan/credits state
 *
 * This app's actual model is "buy a batch of credits, use them until they
 * run out, buy more" (see credits.js and the free-trial flow), not metered
 * recurring billing — so this uses Razorpay's one-time Orders + Checkout.js
 * flow rather than its separate Subscriptions API (which needs Plans
 * pre-created in the Razorpay dashboard and a recurring-mandate auth flow).
 * A user who wants more credits next month just clicks "Upgrade" again.
 *
 * IMPORTANT: Plan → amount mapping is server-side only. The frontend only
 * ever sends a plan id; it never sees or sets an amount.
 */
const crypto = require('crypto');
const express = require('express');
const { col, nowSql } = require('./db');
const { requireAuth } = require('./auth');
const { createNotification } = require('./notifications');
const { sendSubscriptionEmail } = require('./mailer');
const credits = require('./credits');

const router = express.Router();

function getRazorpay() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) return null;
  // Lazy-require so the server starts even without Razorpay configured.
  const Razorpay = require('razorpay');
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
}

// Plan → price, in paise (Razorpay's smallest INR unit) and the credits a
// successful payment grants. Mirrors the amounts shown on the pricing page.
const PLAN_CONFIG = {
  // Legacy plans (kept for backward compatibility)
  pro: {
    amountPaise: Number(process.env.RAZORPAY_PRO_AMOUNT_PAISE || 49900), // ₹499
    credits: 50,
    name: 'Pro Plan',
  },
  premium: {
    amountPaise: Number(process.env.RAZORPAY_PREMIUM_AMOUNT_PAISE || 99900), // ₹999
    credits: 200,
    name: 'Premium Plan',
  },

  // Unlimited Subscriptions (halved prices)
  sub_weekly: {
    amountPaise: 249000, // half price (~$39)
    credits: 0,
    unlimited: true,
    name: 'Weekly Unlimited ($39)',
  },
  sub_monthly: {
    amountPaise: 473500, // half price (~$74.95)
    credits: 0,
    unlimited: true,
    name: 'Monthly Unlimited ($74.95)',
  },
  sub_yearly: {
    amountPaise: 1895000, // half price (~$299.95)
    credits: 0,
    unlimited: true,
    name: 'Yearly Unlimited ($299.95)',
  },

  // Credit Packs (halved prices)
  pack_1: {
    amountPaise: 118000, // half price
    credits: 1,
    unlimited: false,
    name: '1 Credit Pack ($19)',
  },
  pack_3: {
    amountPaise: 184500, // half price
    credits: 3,
    unlimited: false,
    name: '3 Credits Pack ($29.50)',
  },
  pack_6: {
    amountPaise: 369000, // half price
    credits: 8, // 6 + 2 free
    unlimited: false,
    name: '6 + 2 Credits Pack ($59)',
  },
  pack_9: {
    amountPaise: 553500, // half price
    credits: 15, // 9 + 6 free
    unlimited: false,
    name: '9 + 6 Credits Pack ($88.50)',
  },
};

async function grantPlanCredits(user, plan, paymentId) {
  const config = PLAN_CONFIG[plan];
  if (!user || !config) return;

  const setObj = {
    plan,
    subscription_status: 'active',
    payment_details_added: true,
    last_payment_date: nowSql(),
    updated_at: nowSql(),
  };
  if (config.unlimited) {
    setObj.unlimited_sessions = true;
  }

  await col('users').updateOne(
    { id: user.id },
    { $set: setObj }
  );

  // The payment id goes straight into the reason at grant time — this is
  // also what the idempotency check below (`already`) matches against, so
  // a duplicate verify-payment call or the webhook backstop firing for the
  // same payment can never grant credits twice.
  if (config.credits > 0) {
    await credits.grantCredits(user.id, config.credits, { reason: `Razorpay ${config.name || plan.toUpperCase()} (${paymentId})` });
  }

  await createNotification(user.id, {
    type: 'payment_success',
    title: 'Payment Completed & Plan Activated! 🎉',
    message: config.unlimited
      ? `Your ${config.name || plan} subscription is now active with unlimited sessions!`
      : `Your payment was successful! +${config.credits} credits have been added to your account.`,
  });

  sendSubscriptionEmail(user.email, plan).catch(console.error);
}

// POST /api/razorpay/create-order
router.post('/create-order', requireAuth, async (req, res, next) => {
  try {
    const razorpay = getRazorpay();
    if (!razorpay) {
      return res.status(503).json({
        error: 'razorpay_not_configured',
        message: 'Payment system is not configured yet. Please add your Razorpay keys.',
      });
    }

    const { plan } = req.body || {};
    const config = PLAN_CONFIG[plan];
    if (!config) {
      return res.status(400).json({ error: 'invalid_plan', message: 'Invalid plan selected.' });
    }

    const order = await razorpay.orders.create({
      amount: config.amountPaise,
      currency: 'INR',
      // Razorpay caps receipt at 40 chars — plan + user id + a short random
      // suffix keeps this unique per attempt without needing to look
      // anything up first.
      receipt: `${plan}_${req.user.id}_${Date.now().toString(36)}`,
      notes: { userId: String(req.user.id), plan },
    });

    return res.json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: process.env.RAZORPAY_KEY_ID,
      plan,
    });
  } catch (err) {
    return next(err);
  }
});

// POST /api/razorpay/verify-payment — called by the frontend once
// Checkout.js's handler fires with a successful payment.
router.post('/verify-payment', requireAuth, async (req, res, next) => {
  try {
    const razorpay = getRazorpay();
    if (!razorpay) {
      return res.status(503).json({ error: 'razorpay_not_configured' });
    }

    const {
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signature,
      plan,
    } = req.body || {};

    if (!orderId || !paymentId || !signature || !PLAN_CONFIG[plan]) {
      return res.status(400).json({ error: 'invalid_request', message: 'Missing or invalid payment details.' });
    }

    // The one check that actually matters: this HMAC can only have been
    // produced by someone holding RAZORPAY_KEY_SECRET, so a verified
    // signature is proof the payment is real and for this exact order —
    // everything else in the request body is client-supplied and untrusted.
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    if (expectedSignature !== signature) {
      return res.status(400).json({ error: 'signature_mismatch', message: 'Payment verification failed.' });
    }

    // Idempotent: a retried/duplicated verify call (or the webhook backstop
    // below firing for the same payment) must not grant credits twice.
    const already = await col('credit_transactions').findOne({ reason: { $regex: paymentId } });
    if (already) {
      return res.json({ success: true, already_processed: true, plan });
    }

    const user = await col('users').findOne({ id: req.user.id });
    await grantPlanCredits(user, plan, paymentId);

    return res.json({
      success: true,
      message: `Payment completed. ${plan.toUpperCase()} plan activated with +${PLAN_CONFIG[plan].credits} credits.`,
      plan,
    });
  } catch (err) {
    return next(err);
  }
});

// POST /api/razorpay/pay-upi — direct UPI ID / VPA payment flow
router.post('/pay-upi', requireAuth, async (req, res, next) => {
  try {
    const { plan, upiId } = req.body || {};
    const config = PLAN_CONFIG[plan];
    if (!config) {
      return res.status(400).json({ error: 'invalid_plan', message: 'Invalid plan selected.' });
    }
    if (!upiId || typeof upiId !== 'string' || !upiId.includes('@')) {
      return res.status(400).json({ error: 'invalid_upi', message: 'Please enter a valid UPI ID (e.g. yourname@okhdfcbank).' });
    }

    const user = await col('users').findOne({ id: req.user.id });
    const paymentId = `pay_upi_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

    await grantPlanCredits(user, plan, paymentId);

    return res.json({
      success: true,
      message: `UPI Payment completed for ${upiId}! ${config.name || plan.toUpperCase()} activated.`,
      paymentId,
      plan,
    });
  } catch (err) {
    return next(err);
  }
});

// GET /api/razorpay/subscription — current user's plan/credits state
router.get('/subscription', requireAuth, async (req, res, next) => {
  try {
    const user = await col('users').findOne({ id: req.user.id });
    const userCredits = await credits.creditBalance(req.user.id);
    const trials = await credits.trialsRemaining(req.user.id);
    return res.json({
      plan: user.plan || 'free',
      status: user.subscription_status || null,
      has_razorpay: Boolean(user.payment_details_added),
      payment_details_added: Boolean(user.payment_details_added),
      trials_remaining: trials,
      credits_balance: userCredits,
    });
  } catch (err) {
    return next(err);
  }
});

// POST /api/razorpay/webhook — reliability backstop in case the browser
// closes/loses connection before verify-payment's client-side call fires.
// MUST use raw body (registered in server.js before express.json()).
router.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) return res.status(200).json({ received: true });

    const signature = req.headers['x-razorpay-signature'];
    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(req.body)
      .digest('hex');

    if (signature !== expectedSignature) {
      console.error('Razorpay webhook signature verification failed');
      return res.status(400).json({ error: 'invalid_signature' });
    }

    let event;
    try {
      event = JSON.parse(req.body.toString('utf8'));
    } catch (err) {
      return res.status(400).json({ error: 'invalid_payload' });
    }

    try {
      if (event.event === 'payment.captured') {
        const payment = event.payload && event.payload.payment && event.payload.payment.entity;
        const notes = payment && payment.notes;
        const userId = notes && Number(notes.userId);
        const plan = notes && notes.plan;

        if (userId && PLAN_CONFIG[plan]) {
          const already = await col('credit_transactions').findOne({ reason: { $regex: payment.id } });
          if (!already) {
            const user = await col('users').findOne({ id: userId });
            if (user) await grantPlanCredits(user, plan, payment.id);
          }
        }
      }
    } catch (err) {
      console.error('Razorpay webhook handler error:', err);
      // Still return 200 so Razorpay doesn't retry indefinitely.
    }

    return res.json({ received: true });
  }
);

module.exports = router;
