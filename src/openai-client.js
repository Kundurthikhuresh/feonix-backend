// One shared client. Built lazily so the server still boots (and serves the
// login page) when no key is configured yet — the failure shows up on the
// routes that actually need it, not at startup.

const OpenAI = require('openai');

let client = null;

function openai() {
  if (!client) {
    if (!process.env.OPENAI_API_KEY) {
      const err = new Error('OPENAI_API_KEY is not set');
      err.status = 503;
      err.code = 'not_configured';
      throw err;
    }
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      // Lets the app be pointed at a compatible proxy or a local stub.
      baseURL: process.env.OPENAI_BASE_URL || undefined,
      timeout: Number(process.env.OPENAI_TIMEOUT_MS || 30000),
      maxRetries: 1, // a live interview would rather fail fast than retry
    });
  }
  return client;
}

module.exports = { openai };
