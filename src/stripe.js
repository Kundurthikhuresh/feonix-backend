/**
 * Stripe Payments Integration
 * - POST /api/stripe/create-checkout-session
 * - POST /api/stripe/webhook  (raw body — must be registered BEFORE express.json())
 * - POST /api/stripe/create-portal-session
 *
 * IMPORTANT: Plan price mapping is server-side only. Frontend never touches price IDs.
 */
const express = require('express');
const { col, nowSql } = require('./db');
const { requireAuth } = require('./auth');
const { createNotification } = require('./notifications');
const { sendSubscriptionEmail } = require('./mailer');

const router = express.Router();

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  // Lazy-require so the server starts even without Stripe configured
  return require('stripe')(key);
}

// Plan → Stripe Price ID map (server-side only)
function getPriceId(plan) {
  const map = {
    pro: process.env.STRIPE_PRO_PRICE_ID,
    premium: process.env.STRIPE_PREMIUM_PRICE_ID,
  };
  return map[plan] || null;
}

function planFromPriceId(priceId) {
  if (!priceId) return 'free';
  if (priceId === process.env.STRIPE_PRO_PRICE_ID) return 'pro';
  if (priceId === process.env.STRIPE_PREMIUM_PRICE_ID) return 'premium';
  return 'free';
}

const credits = require('./credits');

// Update user subscription state in MongoDB & grant paid credits
async function syncSubscription(stripeCustomerId, subscriptionData) {
  const {
    id: stripeSubscriptionId,
    status,
    items,
    current_period_start,
    current_period_end,
  } = subscriptionData;

  const priceId = items && items.data && items.data[0] && items.data[0].price && items.data[0].price.id;
  const plan = planFromPriceId(priceId);
  const isActive = status === 'active' || status === 'trialing';

  await col('users').updateOne(
    { stripe_customer_id: stripeCustomerId },
    {
      $set: {
        stripe_subscription_id: stripeSubscriptionId,
        stripe_price_id: priceId || null,
        subscription_status: status,
        plan: isActive ? plan : 'free',
        payment_details_added: true,
        last_payment_date: nowSql(),
        subscription_period_start: current_period_start
          ? new Date(current_period_start * 1000).toISOString()
          : null,
        subscription_period_end: current_period_end
          ? new Date(current_period_end * 1000).toISOString()
          : null,
        updated_at: nowSql(),
      },
    }
  );

  const user = await col('users').findOne({ stripe_customer_id: stripeCustomerId });
  if (user && isActive) {
    // Grant credits based on plan (50 credits for Pro, 200 for Premium)
    const creditsToGrant = plan === 'premium' ? 200 : 50;
    try {
      await credits.grantCredits(user.id, creditsToGrant, { reason: `Stripe ${plan.toUpperCase()} Payment` });
    } catch (e) {
      console.warn('Credits grant note:', e.message);
    }

    // In-App Notification
    await createNotification(user.id, {
      type: 'payment_success',
      title: 'Payment Details Added & Plan Activated! 🎉',
      message: `Your 5 free credits period has upgraded! The ${plan.toUpperCase()} plan is now active with +${creditsToGrant} credits.`,
    });

    // Transactional Email
    sendSubscriptionEmail(user.email, plan).catch(console.error);
  }
}

// POST /api/stripe/create-checkout-session
router.post('/create-checkout-session', requireAuth, async (req, res, next) => {
  try {
    const stripe = getStripe();
    if (!stripe) {
      return res.status(503).json({
        error: 'stripe_not_configured',
        message: 'Payment system is not configured yet. Please add your Stripe keys.',
      });
    }

    const { plan } = req.body || {};
    const priceId = getPriceId(plan);
    if (!priceId) {
      return res.status(400).json({ error: 'invalid_plan', message: 'Invalid plan selected.' });
    }

    const user = await col('users').findOne({ id: req.user.id });
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001';

    // Find or create Stripe customer
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { userId: String(req.user.id) },
      });
      customerId = customer.id;
      await col('users').updateOne(
        { id: req.user.id },
        { $set: { stripe_customer_id: customerId, updated_at: nowSql() } }
      );
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appUrl}/billing?payment=success`,
      cancel_url: `${appUrl}/pricing?payment=cancelled`,
      metadata: {
        userId: String(req.user.id),
        plan,
      },
      subscription_data: {
        metadata: { userId: String(req.user.id), plan },
      },
    });

    return res.json({ url: session.url });
  } catch (err) {
    return next(err);
  }
});

// POST /api/stripe/create-portal-session
router.post('/create-portal-session', requireAuth, async (req, res, next) => {
  try {
    const stripe = getStripe();
    if (!stripe) {
      return res.status(503).json({ error: 'stripe_not_configured' });
    }

    const user = await col('users').findOne({ id: req.user.id });
    if (!user || !user.stripe_customer_id) {
      return res.status(400).json({
        error: 'no_subscription',
        message: 'No active subscription found.',
      });
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001';
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${appUrl}/billing`,
    });

    return res.json({ url: portalSession.url });
  } catch (err) {
    return next(err);
  }
});

// POST /api/stripe/activate-plan — complete payment & grant credits
router.post('/activate-plan', requireAuth, async (req, res, next) => {
  try {
    const { plan } = req.body || {};
    const targetPlan = ['pro', 'premium'].includes(plan) ? plan : 'pro';
    const creditsToGrant = targetPlan === 'premium' ? 200 : 50;

    await col('users').updateOne(
      { id: req.user.id },
      {
        $set: {
          plan: targetPlan,
          subscription_status: 'active',
          payment_details_added: true,
          last_payment_date: nowSql(),
          updated_at: nowSql(),
        },
      }
    );

    // Grant paid credits to user
    await credits.grantCredits(req.user.id, creditsToGrant, { reason: `Stripe ${targetPlan.toUpperCase()} Payment Completed` });

    // In-App Notification
    await createNotification(req.user.id, {
      type: 'payment_success',
      title: 'Payment Completed & Plan Activated! 🎉',
      message: `Your 5 free credits period has upgraded! The ${targetPlan.toUpperCase()} plan is now active with +${creditsToGrant} credits.`,
    });

    // Transactional Email
    sendSubscriptionEmail(req.user.email, targetPlan).catch(console.error);

    return res.json({
      success: true,
      message: `Payment completed. ${targetPlan.toUpperCase()} plan activated with +${creditsToGrant} credits.`,
      plan: targetPlan,
    });
  } catch (err) {
    return next(err);
  }
});

// GET /api/stripe/subscription — get current user's subscription state
router.get('/subscription', requireAuth, async (req, res, next) => {
  try {
    const user = await col('users').findOne({ id: req.user.id });
    const userCredits = await credits.creditBalance(req.user.id);
    const trials = await credits.trialsRemaining(req.user.id);
    return res.json({
      plan: user.plan || 'free',
      status: user.subscription_status || null,
      period_end: user.subscription_period_end || null,
      has_stripe: Boolean(user.stripe_customer_id),
      payment_details_added: Boolean(user.payment_details_added),
      trials_remaining: trials,
      credits_balance: userCredits,
    });
  } catch (err) {
    return next(err);
  }
});

// POST /api/stripe/webhook — MUST use raw body (registered in server.js before express.json())
router.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const stripe = getStripe();
    if (!stripe) return res.status(200).json({ received: true });

    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      console.error('Stripe webhook signature verification failed:', err.message);
      return res.status(400).json({ error: `Webhook Error: ${err.message}` });
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;
          if (session.mode === 'subscription' && session.subscription) {
            const subscription = await stripe.subscriptions.retrieve(session.subscription);
            await syncSubscription(session.customer, subscription);
            const userId = Number(session.metadata && session.metadata.userId);
            const plan = (session.metadata && session.metadata.plan) || 'pro';
            if (userId) {
              createNotification(userId, {
                type: 'subscription_activated',
                title: 'Subscription Activated',
                message: `Your ${plan} plan is now active. Enjoy the higher limits!`,
              }).catch(console.error);
            }
          }
          break;
        }

        case 'customer.subscription.created':
        case 'customer.subscription.updated': {
          const sub = event.data.object;
          await syncSubscription(sub.customer, sub);
          break;
        }

        case 'customer.subscription.deleted': {
          const sub = event.data.object;
          await col('users').updateOne(
            { stripe_customer_id: sub.customer },
            {
              $set: {
                plan: 'free',
                subscription_status: 'canceled',
                stripe_subscription_id: null,
                updated_at: nowSql(),
              },
            }
          );
          break;
        }

        case 'invoice.paid': {
          const invoice = event.data.object;
          if (invoice.subscription) {
            const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
            await syncSubscription(invoice.customer, subscription);
          }
          break;
        }

        case 'invoice.payment_failed': {
          const invoice = event.data.object;
          await col('users').updateOne(
            { stripe_customer_id: invoice.customer },
            { $set: { subscription_status: 'past_due', updated_at: nowSql() } }
          );
          const user = await col('users').findOne({ stripe_customer_id: invoice.customer });
          if (user) {
            createNotification(user.id, {
              type: 'payment_failed',
              title: 'Payment Failed',
              message: 'Your subscription payment failed. Please update your payment method.',
            }).catch(console.error);
          }
          break;
        }

        default:
          break;
      }
    } catch (err) {
      console.error('Stripe webhook handler error:', err);
      // Still return 200 to Stripe so it doesn't retry
    }

    return res.json({ received: true });
  }
);

module.exports = router;
