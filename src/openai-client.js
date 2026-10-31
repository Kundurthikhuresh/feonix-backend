// One shared client. Built lazily so the server still boots (and serves the
// login page) when no key is configured yet — the failure shows up on the
// routes that actually need it, not at startup.

const OpenAI = require('openai');

let client = null;

function openai(customKey) {
  const key = customKey || process.env.OPENAI_API_KEY;
  if (!key) {
    const err = new Error('OPENAI_API_KEY is not configured. Please add OPENAI_API_KEY to your feonix-backend/.env file.');
    err.status = 503;
    err.code = 'not_configured';
    throw err;
  }
  if (!client || customKey) {
    const instance = new OpenAI({
      apiKey: key,
      baseURL: process.env.OPENAI_BASE_URL || undefined,
      timeout: Number(process.env.OPENAI_TIMEOUT_MS || 60000),
      maxRetries: 1,
    });
    if (!customKey) client = instance;
    return instance;
  }
  return client;
}

module.exports = { openai };
