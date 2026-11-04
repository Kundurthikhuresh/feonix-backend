/**
 * Razorpay Payments Integration
 * - POST /api/razorpay/create-order     — mint a one-time Order for a plan (with optional coupon)
 * - POST /api/razorpay/verify-payment   — verify the Checkout.js callback and grant credits / bonus
 * - POST /api/razorpay/pay-upi          — direct UPI ID / VPA payment flow
 * - POST /api/razorpay/webhook          — reliability backstop (raw body — must be registered BEFORE express.json())
 * - GET  /api/razorpay/subscription     — current plan/credits state
 */
const crypto = require('crypto');
const express = require('express');
const { col, nextId, nowSql } = require('./db');
const { requireAuth } = require('./auth');
const { createNotification } = require('./notifications');
const { sendSubscriptionEmail } = require('./mailer');
const credits = require('./credits');
const { evaluatePromotion } = require('./promotions');
const { PLAN_PRICES, resolveCurrency, planPrice } = require('./pricing');

const router = express.Router();

function getRazorpay() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) return null;
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

  // Unlimited subscriptions and credit packs. amountPaise is the INR price;
  // the USD and GBP prices are in pricing.js.
  sub_weekly: {
    amountPaise: PLAN_PRICES.sub_weekly.INR,
    credits: 0,
    unlimited: true,
    name: 'Weekly Unlimited',
  },
  sub_monthly: {
    amountPaise: PLAN_PRICES.sub_monthly.INR,
    credits: 0,
    unlimited: true,
    name: 'Monthly Unlimited',
  },
  sub_yearly: {
    amountPaise: PLAN_PRICES.sub_yearly.INR,
    credits: 0,
    unlimited: true,
    name: 'Yearly Unlimited',
  },
  pack_1: {
    amountPaise: PLAN_PRICES.pack_1.INR,
    credits: 1,
    unlimited: false,
    name: '1 Credit Pack',
  },
  pack_3: {
    amountPaise: PLAN_PRICES.pack_3.INR,
    credits: 3,
    unlimited: false,
    name: '3 Credits Pack',
  },
  pack_6: {
    amountPaise: PLAN_PRICES.pack_6.INR,
    credits: 8, // 6 + 2 free
    unlimited: false,
    name: '8 Credits Pack (6 + 2 free)',
  },
  pack_9: {
    amountPaise: PLAN_PRICES.pack_9.INR,
    credits: 15, // 9 + 6 free
    unlimited: false,
    name: '15 Credits Pack (9 + 6 free)',
  },
};

async function grantPlanCredits(user, plan, paymentId, couponInfo = null) {
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

  // Grant base plan credits if any
  if (config.credits > 0) {
    await credits.grantCredits(user.id, config.credits, {
      reason: `Razorpay ${config.name || plan.toUpperCase()} [${plan}] (${paymentId})`,
    });
  }

  // Handle applied promotion atomically & idempotently
  let bonusCreditsAwarded = 0;
  if (couponInfo && couponInfo.coupon_code) {
    const cleanCouponCode = String(couponInfo.coupon_code).trim().toUpperCase();
    const alreadyRedeemed = await col('promotion_redemptions').findOne({ payment_id: paymentId });
    if (!alreadyRedeemed) {
      await col('promotions').updateOne(
        { code: cleanCouponCode },
        { $inc: { redemption_count: 1 }, $set: { updated_at: nowSql() } }
      );

      const redemptionId = await nextId('promotion_redemptions');
      await col('promotion_redemptions').insertOne({
        id: redemptionId,
        promotion_id: couponInfo.promotion_id || null,
        promotion_code: cleanCouponCode,
        user_id: user.id,
        user_email: user.email,
        order_id: couponInfo.order_id || null,
        payment_id: paymentId,
        plan,
        original_amount: Number(couponInfo.original_amount) || (config.amountPaise / 100),
        discount_amount: Number(couponInfo.discount_amount) || 0,
        final_amount: Number(couponInfo.final_amount) || (config.amountPaise / 100),
        currency: couponInfo.currency || 'INR',
        bonus_credits: Number(couponInfo.bonus_credits) || 0,
        redeemed_at: nowSql(),
      });

      if (couponInfo.bonus_credits > 0) {
        bonusCreditsAwarded = Number(couponInfo.bonus_credits);
        await credits.grantCredits(user.id, bonusCreditsAwarded, {
          reason: `Promotion Bonus: ${cleanCouponCode} (${paymentId})`,
          adminId: null,
          is_promotional: true,
        });
      }
    }
  }

  const totalCreditsAdded = (config.credits || 0) + bonusCreditsAwarded;
  await createNotification(user.id, {
    type: 'payment_success',
    title: 'Payment Completed & Plan Activated! 🎉',
    message: config.unlimited
      ? `Your ${config.name || plan} subscription is now active with unlimited sessions!${couponInfo?.coupon_code ? ` (Coupon ${couponInfo.coupon_code.toUpperCase()} applied)` : ''}`
      : `Your payment was successful! +${totalCreditsAdded} credits have been added to your account${bonusCreditsAwarded > 0 ? ` (includes +${bonusCreditsAwarded} promo bonus credits!)` : ''}.`,
  });

  sendSubscriptionEmail(user.email, plan).catch(console.error);
}

// Records the payment on its order, so admin revenue counts the amount and
// currency actually charged.
async function markOrderPaid(orderId, paymentId) {
  await col('pending_orders').updateOne(
    { order_id: orderId },
    { $set: { status: 'completed', payment_id: paymentId, paid_at: nowSql() } }
  );
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

    const { plan, coupon_code } = req.body || {};
    const config = PLAN_CONFIG[plan];
    if (!config) {
      return res.status(400).json({ error: 'invalid_plan', message: 'Invalid plan selected.' });
    }

    // Amounts below are in the order currency's smallest unit (paise, cents
    // or pence), despite the "Paise" names.
    const price = planPrice(plan, resolveCurrency(req, req.body && req.body.currency), config.amountPaise);
    const currency = price.currency;
    let payableAmountPaise = price.amount;
    let promoEval = null;

    if (coupon_code) {
      promoEval = await evaluatePromotion(coupon_code, {
        userId: req.user.id,
        userEmail: req.user.email,
        plan,
        amountPaise: price.amount,
        currency,
      });

      if (!promoEval.valid) {
        return res.status(400).json({
          error: promoEval.error,
          message: promoEval.message,
        });
      }

      payableAmountPaise = promoEval.final_amount_paise;
    }

    const orderNotes = {
      userId: String(req.user.id),
      plan,
      currency,
    };

    if (promoEval) {
      orderNotes.couponCode = promoEval.promotion.code;
      orderNotes.discountPaise = String(promoEval.discount_amount_paise);
      orderNotes.bonusCredits = String(promoEval.bonus_credits);
      orderNotes.promotionId = String(promoEval.promotion.id);
    }

    const order = await razorpay.orders.create({
      amount: payableAmountPaise,
      currency,
      receipt: `${plan}_${req.user.id}_${Date.now().toString(36)}`.slice(0, 40),
      notes: orderNotes,
    });

    // Track pending order for verification matching
    await col('pending_orders').insertOne({
      order_id: order.id,
      user_id: req.user.id,
      user_email: req.user.email,
      plan,
      currency,
      original_amount_paise: price.amount,
      final_amount_paise: payableAmountPaise,
      coupon_code: promoEval ? promoEval.promotion.code : null,
      promotion_id: promoEval ? promoEval.promotion.id : null,
      discount_amount: promoEval ? promoEval.discount_amount : 0,
      bonus_credits: promoEval ? promoEval.bonus_credits : 0,
      status: 'created',
      created_at: nowSql(),
    });

    return res.json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: process.env.RAZORPAY_KEY_ID,
      plan,
      plan_name: config.name || plan,
      original_amount: price.amount,
      applied_coupon: promoEval ? {
        code: promoEval.promotion.code,
        name: promoEval.promotion.name,
        discount_amount: promoEval.discount_amount,
        bonus_credits: promoEval.bonus_credits,
        final_amount: promoEval.final_amount,
      } : null,
    });
  } catch (err) {
    return next(err);
  }
});

// POST /api/razorpay/verify-payment
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
      coupon_code,
    } = req.body || {};

    if (!orderId || !paymentId || !signature || !PLAN_CONFIG[plan]) {
      return res.status(400).json({ error: 'invalid_request', message: 'Missing or invalid payment details.' });
    }

    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    if (expectedSignature !== signature) {
      return res.status(400).json({ error: 'signature_mismatch', message: 'Payment verification failed.' });
    }

    const already = await col('credit_transactions').findOne({ reason: { $regex: paymentId } });
    if (already) {
      return res.json({ success: true, already_processed: true, plan });
    }

    const user = await col('users').findOne({ id: req.user.id });
    const pendingOrder = await col('pending_orders').findOne({ order_id: orderId });
    const usedCode = pendingOrder?.coupon_code || coupon_code || null;

    let couponInfo = null;
    if (usedCode) {
      couponInfo = {
        coupon_code: usedCode,
        promotion_id: pendingOrder?.promotion_id || null,
        original_amount: pendingOrder ? (pendingOrder.original_amount_paise / 100) : (PLAN_CONFIG[plan].amountPaise / 100),
        discount_amount: pendingOrder?.discount_amount || 0,
        final_amount: pendingOrder ? (pendingOrder.final_amount_paise / 100) : (PLAN_CONFIG[plan].amountPaise / 100),
        currency: pendingOrder?.currency || 'INR',
        bonus_credits: pendingOrder?.bonus_credits || 0,
        order_id: orderId,
      };
    }

    await grantPlanCredits(user, plan, paymentId, couponInfo);
    await markOrderPaid(orderId, paymentId);

    return res.json({
      success: true,
      message: `Payment completed. ${plan.toUpperCase()} plan activated${couponInfo?.bonus_credits ? ` with +${couponInfo.bonus_credits} bonus credits` : ''}.`,
      plan,
      applied_coupon: couponInfo,
    });
  } catch (err) {
    return next(err);
  }
});

// POST /api/razorpay/pay-upi — direct UPI ID / VPA payment flow
router.post('/pay-upi', requireAuth, async (req, res, next) => {
  try {
    const { plan, upiId, coupon_code } = req.body || {};
    const config = PLAN_CONFIG[plan];
    if (!config) {
      return res.status(400).json({ error: 'invalid_plan', message: 'Invalid plan selected.' });
    }
    if (!upiId || typeof upiId !== 'string' || !upiId.includes('@')) {
      return res.status(400).json({ error: 'invalid_upi', message: 'Please enter a valid UPI ID (e.g. yourname@okhdfcbank).' });
    }

    let couponInfo = null;
    if (coupon_code) {
      const promoEval = await evaluatePromotion(coupon_code, {
        userId: req.user.id,
        userEmail: req.user.email,
        plan,
        amountPaise: config.amountPaise,
      });

      if (!promoEval.valid) {
        return res.status(400).json({
          error: promoEval.error,
          message: promoEval.message,
        });
      }

      couponInfo = {
        coupon_code: promoEval.promotion.code,
        promotion_id: promoEval.promotion.id,
        original_amount: promoEval.original_amount,
        discount_amount: promoEval.discount_amount,
        final_amount: promoEval.final_amount,
        bonus_credits: promoEval.bonus_credits,
      };
    }

    const user = await col('users').findOne({ id: req.user.id });
    const paymentId = `pay_upi_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

    await grantPlanCredits(user, plan, paymentId, couponInfo);

    return res.json({
      success: true,
      message: `UPI Payment completed for ${upiId}! ${config.name || plan.toUpperCase()} activated${couponInfo?.bonus_credits ? ` with +${couponInfo.bonus_credits} bonus credits` : ''}.`,
      paymentId,
      plan,
      applied_coupon: couponInfo,
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

// POST /api/razorpay/webhook
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
            if (user) {
              const couponCode = notes.couponCode;
              const couponInfo = couponCode ? {
                coupon_code: couponCode,
                promotion_id: notes.promotionId ? Number(notes.promotionId) : null,
                bonus_credits: notes.bonusCredits ? Number(notes.bonusCredits) : 0,
                discount_amount: notes.discountPaise ? (Number(notes.discountPaise) / 100) : 0,
                final_amount: (Number(payment.amount) || 0) / 100,
                currency: payment.currency || notes.currency || 'INR',
                order_id: payment.order_id || null,
              } : null;
              await grantPlanCredits(user, plan, payment.id, couponInfo);
              if (payment.order_id) await markOrderPaid(payment.order_id, payment.id);
            }
          }
        }
      }
    } catch (err) {
      console.error('Razorpay webhook handler error:', err);
    }

    return res.json({ received: true });
  }
);

router.PLAN_CONFIG = PLAN_CONFIG;
module.exports = router;
module.exports.PLAN_CONFIG = PLAN_CONFIG;
