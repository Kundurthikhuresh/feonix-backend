const express = require('express');
const { col, nextId, nowSql, publicDoc } = require('./db');
const { requireAuth, optionalAuth } = require('./auth');
const { CURRENCIES, resolveCurrency, planPrice } = require('./pricing');

const router = express.Router();

/**
 * Determine dynamic status of a promotion given the current time
 */
function getPromotionStatus(promo) {
  if (promo.status === 'inactive') return 'inactive';
  const now = new Date();
  if (promo.start_date && new Date(promo.start_date) > now) return 'scheduled';
  if (promo.expiry_date && new Date(promo.expiry_date) < now) return 'expired';
  if (promo.max_redemptions > 0 && (promo.redemption_count || 0) >= promo.max_redemptions) {
    return 'exhausted';
  }
  return 'active';
}

/**
 * Core validation & calculation engine for promotions.
 * Used by /validate, /create-order, and payment verification.
 */
async function evaluatePromotion(promoCode, { userId, userEmail, plan, amountPaise, currency = 'INR' }) {
  // Fixed discounts and minimum purchase are set in rupees; for a USD or GBP
  // order they are converted into that currency.
  const cur = CURRENCIES[currency] ? currency : 'INR';
  const fromRupees = (rupees) => Number(rupees) / CURRENCIES[cur].inrRate;
  if (!promoCode || typeof promoCode !== 'string') {
    return { valid: false, error: 'invalid_code', message: 'Please enter a promotion code.' };
  }

  const cleanCode = promoCode.trim().toUpperCase();
  let promo = await col('promotions').findOne({ code: cleanCode });
  if (!promo) {
    // Built-in promotional and referral codes
    const BUILTIN_CODES = {
      'FEONIX50': { name: 'Feonix 50% Off Special', offer_type: 'percentage_discount', discount_percent: 50 },
      'WELCOME20': { name: 'Welcome 20% Discount', offer_type: 'percentage_discount', discount_percent: 20 },
      'FEONIX20': { name: 'Feonix 20% Discount', offer_type: 'percentage_discount', discount_percent: 20 },
      'REFERRAL20': { name: 'Referral 20% Discount', offer_type: 'percentage_discount', discount_percent: 20 },
      'REF20': { name: 'Referral 20% Discount', offer_type: 'percentage_discount', discount_percent: 20 },
      'DISCOUNT10': { name: 'Promo 10% Discount', offer_type: 'percentage_discount', discount_percent: 10 },
      'FEONIX10': { name: 'Feonix 10% Discount', offer_type: 'percentage_discount', discount_percent: 10 },
    };
    if (BUILTIN_CODES[cleanCode]) {
      promo = {
        id: `builtin_${cleanCode.toLowerCase()}`,
        code: cleanCode,
        status: 'active',
        eligible_products: ['all'],
        per_user_limit: 10,
        ...BUILTIN_CODES[cleanCode],
      };
    } else if (cleanCode.startsWith('REF') || cleanCode.startsWith('REF-')) {
      // Automatic support for user referral codes (e.g. REF123, REF-USER)
      promo = {
        id: `ref_${cleanCode.toLowerCase()}`,
        name: `Referral Discount (${cleanCode})`,
        code: cleanCode,
        status: 'active',
        offer_type: 'percentage_discount',
        discount_percent: 20,
        eligible_products: ['all'],
        per_user_limit: 10,
      };
    }
  }

  if (!promo) {
    return { valid: false, error: 'not_found', message: 'Promotion or referral code does not exist.' };
  }

  const currentStatus = getPromotionStatus(promo);
  if (currentStatus === 'inactive') {
    return { valid: false, error: 'inactive', message: 'This promotion is currently inactive.' };
  }
  if (currentStatus === 'scheduled') {
    return { valid: false, error: 'scheduled', message: `This promotion starts on ${new Date(promo.start_date).toLocaleDateString()}.` };
  }
  if (currentStatus === 'expired') {
    return { valid: false, error: 'expired', message: 'This promotion code has expired.' };
  }
  if (currentStatus === 'exhausted') {
    return { valid: false, error: 'exhausted', message: 'This promotion has reached its maximum redemption limit.' };
  }

  // Check per-user redemption limit
  const perUserLimit = Number(promo.per_user_limit) || 1;
  if (userId) {
    const userRedemptions = await col('promotion_redemptions').countDocuments({
      promotion_id: promo.id,
      user_id: Number(userId),
    });
    if (userRedemptions >= perUserLimit) {
      return {
        valid: false,
        error: 'user_limit_reached',
        message: `You have already redeemed this promotion code (limit: ${perUserLimit} per user).`,
      };
    }
  }

  // Check product / plan eligibility
  const eligible = Array.isArray(promo.eligible_products) ? promo.eligible_products : ['all'];
  if (!eligible.includes('all')) {
    const isSubscription = plan && plan.startsWith('sub_');
    const isCreditPack = plan && plan.startsWith('pack_');

    const matchesDirect = eligible.includes(plan);
    const matchesCategory =
      (isSubscription && eligible.includes('subscriptions')) ||
      (isCreditPack && eligible.includes('credit_packs'));

    if (!matchesDirect && !matchesCategory) {
      return {
        valid: false,
        error: 'ineligible_product',
        message: 'This coupon code is not applicable to the selected plan or credit pack.',
      };
    }
  }

  // Check minimum purchase amount
  const basePaise = Number(amountPaise) || 0;
  const minPurchase = Number(promo.min_purchase_amount) || 0;
  if (minPurchase > 0 && basePaise / 100 < fromRupees(minPurchase)) {
    const shown = cur === 'INR' ? minPurchase : fromRupees(minPurchase).toFixed(2);
    return {
      valid: false,
      error: 'min_purchase_unmet',
      message: `Minimum purchase of ${CURRENCIES[cur].symbol}${shown} is required to use this coupon.`,
    };
  }

  // Calculate discount
  let discountPaise = 0;
  let bonusCredits = Number(promo.bonus_credits) || 0;

  switch (promo.offer_type) {
    case 'percentage_discount': {
      const pct = Math.min(100, Math.max(0, Number(promo.discount_percent) || 0));
      discountPaise = Math.round(basePaise * (pct / 100));
      break;
    }
    case 'fixed_discount': {
      const fixedRupees = Math.max(0, Number(promo.discount_amount) || 0);
      discountPaise = Math.min(basePaise, Math.round(fromRupees(fixedRupees) * 100));
      break;
    }
    case 'plan_discount':
    case 'pack_discount': {
      if (promo.discount_percent > 0) {
        const pct = Math.min(100, Math.max(0, Number(promo.discount_percent)));
        discountPaise = Math.round(basePaise * (pct / 100));
      } else if (promo.discount_amount > 0) {
        discountPaise = Math.min(basePaise, Math.round(fromRupees(promo.discount_amount) * 100));
      }
      break;
    }
    case 'bonus_credits': {
      discountPaise = 0;
      // bonus_credits are awarded upon payment completion
      break;
    }
    case 'limited_time': {
      if (promo.discount_percent > 0) {
        const pct = Math.min(100, Math.max(0, Number(promo.discount_percent)));
        discountPaise = Math.round(basePaise * (pct / 100));
      } else if (promo.discount_amount > 0) {
        discountPaise = Math.min(basePaise, Math.round(fromRupees(promo.discount_amount) * 100));
      }
      break;
    }
    default:
      discountPaise = 0;
  }

  // Ensure minimum payable amount for online gateway (₹1 / 100 paise)
  let finalPaise = Math.max(0, basePaise - discountPaise);
  if (finalPaise > 0 && finalPaise < 100) {
    finalPaise = 100;
    discountPaise = Math.max(0, basePaise - finalPaise);
  }

  return {
    valid: true,
    promotion: {
      id: promo.id,
      name: promo.name,
      code: promo.code,
      offer_type: promo.offer_type,
      discount_percent: promo.discount_percent || 0,
      discount_amount: promo.discount_amount || 0,
      bonus_credits: bonusCredits,
      eligible_products: promo.eligible_products || ['all'],
      expiry_date: promo.expiry_date || null,
    },
    original_amount_paise: basePaise,
    discount_amount_paise: discountPaise,
    final_amount_paise: finalPaise,
    original_amount: basePaise / 100,
    discount_amount: discountPaise / 100,
    final_amount: finalPaise / 100,
    currency: cur,
    bonus_credits: bonusCredits,
  };
}

/**
 * GET /api/promotions/active
 * Publicly visible active offers & credit pack deals (inspired by ParakeetAI)
 */
router.get('/active', async (req, res, next) => {
  try {
    const now = new Date();
    const rows = await col('promotions')
      .find({
        status: { $ne: 'inactive' },
        is_public: { $ne: false },
      })
      .sort({ created_at: -1 })
      .toArray();

    const activeList = rows
      .filter((p) => {
        const status = getPromotionStatus(p);
        return status === 'active';
      })
      .map((p) => ({
        id: p.id,
        name: p.name,
        code: p.code,
        description: p.description || '',
        offer_type: p.offer_type,
        discount_percent: p.discount_percent || 0,
        discount_amount: p.discount_amount || 0,
        bonus_credits: p.bonus_credits || 0,
        eligible_products: p.eligible_products || ['all'],
        min_purchase_amount: p.min_purchase_amount || 0,
        expiry_date: p.expiry_date || null,
        attachment: p.attachment || null,
      }));

    res.json({ promotions: activeList });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/promotions/validate
 * Validate coupon code against a chosen plan (works for both guests and authenticated users)
 */
router.post('/validate', optionalAuth, async (req, res, next) => {
  try {
    const { code, plan, amountPaise, currency: wantedCurrency } = req.body || {};
    if (!code) {
      return res.status(400).json({ error: 'code_required', message: 'Promotion code is required.' });
    }

    const { PLAN_CONFIG } = require('./razorpay');
    const config = plan ? PLAN_CONFIG[plan] : null;
    const price = config
      ? planPrice(plan, resolveCurrency(req, wantedCurrency), config.amountPaise)
      : { currency: 'INR', amount: Number(amountPaise) || 0 };

    const result = await evaluatePromotion(code, {
      userId: req.user ? req.user.id : null,
      userEmail: req.user ? req.user.email : null,
      plan,
      amountPaise: price.amount,
      currency: price.currency,
    });

    if (!result.valid) {
      return res.status(400).json({
        error: result.error,
        message: result.message,
      });
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = {
  router,
  getPromotionStatus,
  evaluatePromotion,
};

