const express = require('express');
const { openai } = require('./openai-client');
const { requireAuth } = require('./auth');
const { rateLimit } = require('./rateLimit');

const router = express.Router();

// Same shape as every other AI-cost route (answerLimiter in answer.js,
// visionLimiter in vision.js) — this route was previously reachable with no
// auth and no limiter at all, spending the server's OpenAI key on every call.
const assistantLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyFn: (req) => `assistant:${req.user.id}`,
});

const SYSTEM_PROMPT = `You are Feonix Copilot, an elite real-time interview co-pilot.
CRITICAL TONE & 90% HUMAN THINKING RULES:
1. 90% HUMAN THINKING, UNDER 10% AI: Your replies must sound 90% like an articulate, thoughtful senior engineer speaking candidly in an interview, and under 10% AI generated. Strictly avoid robotic AI transitions ("furthermore", "in conclusion", "it is vital to understand", "as an AI"). Speak with genuine conversational cadence, confidence, and authority.
2. MORE SENTENCES & DEEP TECHNICAL SUBSTANCE: Provide rich, comprehensive answers with plenty of depth (8 to 14+ substantive sentences, or complete working code with deep algorithmic analysis). Explain how concepts work under the hood, real-world architectural design, production considerations, performance tuning, and practical trade-offs. Never provide brief, shallow summaries.
3. VARIED NATURAL FIRST-PERSON DELIVERY: Speak naturally as the engineer who designed, built, and owns the systems in production. Use varied, organic phrasing ("In our architecture, we...", "Under the hood, this handles...", "When evaluating the trade-offs...", "One production issue we ran into was..."). NEVER repeat robotic templates like starting every line with "I used" or "I did".
4. RELEVANT QUESTION RESOLUTION: When a question is brief, fragmented, or contextual, deduce the true technical topic from conversation context and answer it thoroughly and accurately.
5. ANSWER LIKE AN OWNER, NOT A BOT: Speak directly with technical ownership. NEVER say "As an AI", "Here is what you should say", or sound like a third-person spectator.`;

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

router.post('/chat', requireAuth, assistantLimiter, async (req, res) => {
  const { message, history = [] } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message_required', message: 'A message string is required.' });
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.slice(-6).map((h) => ({
      role: h.role === 'user' ? 'user' : 'assistant',
      content: String(h.content || ''),
    })),
    { role: 'user', content: message },
  ];

  try {
    const completion = await openai().chat.completions.create({
      model: MODEL,
      messages,
      max_completion_tokens: 3500,
      temperature: 0.7,
    });

    const answer = completion.choices?.[0]?.message?.content;
    if (!answer) {
      return res.status(502).json({ error: 'empty_response', message: 'The AI returned an empty response. Please try again.' });
    }

    return res.json({ answer, model: MODEL, usage: completion.usage });
  } catch (err) {
    console.error('Assistant chat error:', err.message);
    const status = err.status || 502;
    return res.status(status).json({
      error: err.code || 'ai_unavailable',
      message: status === 503
        ? 'The AI assistant is not configured on this server.'
        : 'The AI assistant is temporarily unavailable. Please try again.',
    });
  }
});

module.exports = router;
