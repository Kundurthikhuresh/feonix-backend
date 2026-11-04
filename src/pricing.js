/**
 * Plan prices per currency, in the currency's smallest unit (paise, cents,
 * pence). This is what Razorpay charges. The pricing page shows the same
 * numbers from feonix-frontend/src/lib/pricing.js — change both together.
 *
 * India pays in INR, the UK in GBP, everyone else in USD. Charging USD or GBP
 * needs International Payments enabled on the Razorpay account.
 */

const CURRENCIES = {
  INR: { symbol: '₹', inrRate: 1 },
  USD: { symbol: '$', inrRate: Number(process.env.USD_INR_RATE) || 84 },
  GBP: { symbol: '£', inrRate: Number(process.env.GBP_INR_RATE) || 107 },
};

const PLAN_PRICES = {
  sub_weekly:  { INR: 498000,  USD: 3900,  GBP: 3200 },
  sub_monthly: { INR: 947000,  USD: 7495,  GBP: 5995 },
  sub_yearly:  { INR: 3790000, USD: 29995, GBP: 23995 },
  pack_1:      { INR: 237000,  USD: 1900,  GBP: 1500 },
  pack_3:      { INR: 369000,  USD: 2950,  GBP: 2350 },
  pack_6:      { INR: 738000,  USD: 5900,  GBP: 4700 },
  pack_9:      { INR: 1107000, USD: 8850,  GBP: 7050 },
};

function currencyForCountry(country) {
  const cc = String(country || '').toUpperCase();
  if (cc === 'IN') return 'INR';
  if (cc === 'GB' || cc === 'UK') return 'GBP';
  return 'USD';
}

/* The visitor's country from the CDN in front of the app, when there is one.
 * It wins over what the browser asks for, so a visitor cannot pick a cheaper
 * region's prices. Without such a header (local dev) the browser's choice is
 * used. */
function resolveCurrency(req, requested) {
  const geo = req.headers['cf-ipcountry']
    || req.headers['x-vercel-ip-country']
    || req.headers['cloudfront-viewer-country'];
  if (geo && geo !== 'XX' && geo !== 'T1') return currencyForCountry(geo);
  const wanted = String(requested || '').toUpperCase();
  return CURRENCIES[wanted] ? wanted : 'USD';
}

/* Price of a plan in a currency. Plans without a price in that currency
 * (the legacy pro/premium plans) are charged in INR. */
function planPrice(plan, currency, fallbackInrMinor) {
  const row = PLAN_PRICES[plan];
  if (row && row[currency] != null) return { currency, amount: row[currency] };
  return { currency: 'INR', amount: row ? row.INR : fallbackInrMinor };
}

// Minor units of any supported currency → rupees, for admin revenue totals.
function toInr(amountMinor, currency) {
  const c = CURRENCIES[currency] || CURRENCIES.INR;
  return ((Number(amountMinor) || 0) / 100) * c.inrRate;
}

module.exports = { CURRENCIES, PLAN_PRICES, currencyForCountry, resolveCurrency, planPrice, toInr };
