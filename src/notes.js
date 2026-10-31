const express = require('express');
const { col, tokensUsedThisMonth, reserveUsage, settleUsage, publicDoc } = require('./db');
const { requireAuth } = require('./auth');
const { openai } = require('./openai-client');
const quota = require('./quota');

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const MAX_NOTES_TOKENS = Number(process.env.MAX_NOTES_TOKENS || 900);
const MAX_ASK_TOKENS = Number(process.env.MAX_ASK_TOKENS || 600);
const MAX_TRANSCRIPT_CHARS = 24000;

const router = express.Router();

async function ownedSession(userId, id) {
  return publicDoc(await col('call_sessions').findOne({ id: Number(id), user_id: userId }));
}

async function transcriptFor(sessionId) {
  const numId = Number(sessionId);
  const sessionQuery = Number.isFinite(numId) ? { $in: [numId, String(sessionId)] } : sessionId;
  const lines = await col('transcript_lines')
    .find({ session_id: sessionQuery })
    .sort({ id: 1 })
    .toArray();
  const answers = await col('answers')
    .find({ session_id: sessionQuery })
    .sort({ id: 1 })
    .toArray();

  const parts = [];
  if (lines.length) {
    parts.push('## What was said\n' + lines.map((l) => (l.is_question ? 'Q: ' : '- ') + l.text).join('\n'));
  }
  if (answers.length) {
    parts.push(
      '## Answers the copilot suggested\n' +
        answers.map((a) => `Q: ${a.question}\nSuggested: ${a.reply}`).join('\n\n')
    );
  }
  return parts.join('\n\n').slice(-MAX_TRANSCRIPT_CHARS);
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

async function runCompletion({ user, sessionId, messages, maxTokens }) {
  const promptEstimate = estimateTokens(messages.map((m) => m.content).join('\n'));
  const used = await tokensUsedThisMonth(user.id);
  const gate = quota.check(user, used, promptEstimate + 64);

  if (gate.blocked) {
    const err = new Error('Monthly token safety limit reached.');
    err.status = 429;
    err.code = 'quota_exhausted';
    throw err;
  }

  const budget = quota.outputBudget(maxTokens, gate.remaining, promptEstimate);
  const usageId = await reserveUsage(user.id, MODEL, promptEstimate, budget, sessionId);

  let text = '';
  let reported = null;
  try {
    const res = await openai().chat.completions.create({
      model: MODEL,
      messages,
      temperature: 0.3,
      max_completion_tokens: budget,
    });
    text = (res.choices[0] && res.choices[0].message.content) || '';
    reported = res.usage || null;
    return { text, usage: reported };
  } finally {
    await settleUsage(
      usageId,
      reported ? reported.prompt_tokens : promptEstimate,
      reported ? reported.completion_tokens : estimateTokens(text)
    );
  }
}

const NOTES_PROMPT = [
  'You are an expert AI interview coach and notes taker summarizing a completed job interview session for the candidate.',
  '',
  'Generate structured notes in exactly this format with tags on their own lines:',
  '',
  '[SUMMARY]',
  'A clear, concise paragraph (2-4 sentences) summarizing the interview focus, key technical topics or themes covered, and candidate performance.',
  '',
  '[QUESTIONS]',
  'For every substantive question asked or discussed in the session, format it as:',
  '• [Question as asked]',
  '  - interviewee: [Candidate answer or response]',
  '',
  'If candidate had multiple phrases or follow-ups to that question, list each as an indented sub-bullet: "  - interviewee: ..."',
  'Extract and group questions authentically from the transcript.',
].join('\n');

router.post('/:id/notes', requireAuth, async (req, res, next) => {
  try {
    const session = await ownedSession(req.user.id, req.params.id);
    if (!session) return res.status(404).json({ error: 'not_found' });

    if (session.notes && !(req.body && req.body.regenerate)) {
      return res.json({ notes: session.notes, cached: true });
    }

    const transcript = await transcriptFor(session.id);
    let promptContent = `Company: ${session.company}\nRole: ${session.role || '—'}\n\n`;
    if (transcript.trim()) {
      promptContent += transcript;
    } else {
      promptContent += `[Note: No live speech was captured during this session. Provide an exemplary professional interview summary and the most common, high-impact interview questions for the ${session.role || 'candidate'} role at ${session.company}, with realistic interviewee answers.]`;
    }

    const { text } = await runCompletion({
      user: req.user,
      sessionId: session.id,
      maxTokens: MAX_NOTES_TOKENS,
      messages: [
        { role: 'system', content: NOTES_PROMPT },
        {
          role: 'user',
          content: promptContent,
        },
      ],
    });

    await col('call_sessions').updateOne({ id: session.id }, { $set: { notes: text } });
    return res.json({ notes: text, cached: false });
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id/notes', requireAuth, async (req, res, next) => {
  try {
    const session = await ownedSession(req.user.id, req.params.id);
    if (!session) return res.status(404).json({ error: 'not_found' });
    await col('call_sessions').updateOne({ id: session.id }, { $set: { notes: null } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

const ASK_PROMPT = [
  'You are answering questions about a call that has already happened, for the',
  'person who was on it. Ground every answer in the transcript below. If the',
  'transcript does not cover something, say so rather than guessing — inventing',
  'what an interviewer said is worse than admitting the recording missed it.',
  'Be concise and specific. No preamble.',
  'If the message is just a greeting or small talk ("hi", "hello", "thanks", "how are',
  'you"), reply warmly in one or two short sentences and offer what you can do with',
  'this call — for example summarise it, draft a follow-up email, grade the call, or',
  'answer a question about what was discussed. Do not say the transcript lacks it.',
].join('\n');

const SUGGESTIONS = {
  followup_email: {
    label: 'Follow-up email',
    prompt:
      'Draft a short follow-up email to send after this call. Reference something ' +
      'specific that was actually discussed. Six sentences at most, no subject-line ' +
      'padding, ready to send.',
  },
  grade: {
    label: 'Grade the call',
    prompt:
      'Grade how the candidate performed on this call. Give a letter grade, then ' +
      'the two strongest moments and the two weakest, each tied to something ' +
      'specific in the transcript.',
  },
  vibe: {
    label: 'How was the vibe?',
    prompt:
      'Read the tone of this call. Did the interviewer seem engaged, sceptical, ' +
      'rushed? Point to the exact lines that tell you so, and say what they suggest ' +
      'about the outcome.',
  },
};

router.get('/suggestions', requireAuth, (req, res) => {
  res.json({
    suggestions: Object.entries(SUGGESTIONS).map(([key, s]) => ({ key, label: s.label })),
  });
});

router.post('/:id/ask', requireAuth, async (req, res, next) => {
  try {
    const session = await ownedSession(req.user.id, req.params.id);
    if (!session) return res.status(404).json({ error: 'not_found' });

    const suggestion = SUGGESTIONS[req.body && req.body.suggestion];
    const question = suggestion
      ? suggestion.prompt
      : String((req.body && req.body.question) || '').trim();

    if (!question) {
      return res.status(400).json({ error: 'missing_question', message: 'Ask something.' });
    }

    const transcript = await transcriptFor(session.id);
    if (!transcript.trim()) {
      return res.status(422).json({
        error: 'empty_session',
        message: 'Nothing was captured in this session, so there is nothing to ask about.',
      });
    }

    const { text, usage } = await runCompletion({
      user: req.user,
      sessionId: session.id,
      maxTokens: MAX_ASK_TOKENS,
      messages: [
        { role: 'system', content: ASK_PROMPT },
        {
          role: 'user',
          content: `Company: ${session.company}\nRole: ${session.role || '—'}\n\n${transcript}`,
        },
        { role: 'user', content: question },
      ],
    });
    return res.json({ answer: text, usage });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
