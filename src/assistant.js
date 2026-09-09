const express = require('express');
const { openai } = require('./openai-client');

const router = express.Router();

const SYSTEM_PROMPT = `You are "Feonix Assistant", the AI copilot for Feonix AI (https://feonixai.com).
Your purpose is to assist software engineers, tech professionals, and interviewees in acing technical interviews, system design rounds, live coding challenges, and career growth.

Voice & Demeanor:
- You speak naturally, warmly, confidently, and like an articulate, world-class technical mentor.
- Keep your answers concise, direct, engaging, and clear (ideal for being spoken aloud naturally by text-to-speech).
- When explaining complex ideas, structure them with crisp bullet points or short paragraphs.
- Be encouraging and enthusiastic about engineering and interview success.

Always provide high-value, actionable, technically precise guidance. If you don't know something, say so rather than guessing.`;

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

router.post('/chat', async (req, res) => {
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
      max_completion_tokens: 350,
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
