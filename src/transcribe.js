// POST /api/transcribe — an audio chunk in, text out.
//
// The browser records the meeting in short chunks and posts them here one at a
// time, so the transcript builds up live instead of arriving after the call.
//
// Billing note: gpt-4o-mini-transcribe reports real token usage, so audio draws
// down the same per-user quota as answers and needs no separate meter. whisper-1
// does NOT report usage — it's billed per audio minute — so pointing
// TRANSCRIBE_MODEL at it silently makes transcription free as far as the quota
// is concerned. Don't, unless you also add a duration-based meter.

const express = require('express');
const { toFile } = require('openai');
const { tokensUsedThisMonth, reserveUsage, settleUsage } = require('./db');
const { requireAuth } = require('./auth');
const { openai } = require('./openai-client');
const quota = require('./quota');
const { technicalTerms } = require('./modes');

const MODEL = process.env.TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';
const MAX_CHUNK_BYTES = 10 * 1024 * 1024;

// Held against the quota while a chunk is in flight, then replaced by the real
// figure. A ~10s chunk of speech lands near 100 tokens; this leaves room for a
// long one without letting a burst of chunks race past the quota check.
const RESERVE_TOKENS = Number(process.env.TRANSCRIBE_RESERVE_TOKENS || 500);

// Session language is stored as a display name; Whisper wants ISO-639-1.
// Unknown values simply omit the parameter and let it auto-detect.
const LANGUAGE_CODES = {
  english: 'en', spanish: 'es', french: 'fr', german: 'de', italian: 'it',
  portuguese: 'pt', dutch: 'nl', hindi: 'hi', telugu: 'te', tamil: 'ta',
  arabic: 'ar', chinese: 'zh', japanese: 'ja', korean: 'ko', russian: 'ru',
};

const ALLOWED_EXTENSIONS = ['webm', 'ogg', 'mp3', 'mp4', 'm4a', 'wav', 'mpga', 'mpeg'];

// Nudges the model toward interview vocabulary and away from hallucinating
// filler into silence.
const TRANSCRIBE_PROMPT =
  'This is audio from a job interview. Transcribe the questions accurately.';

/**
 * Whisper's `prompt` biases decoding toward the vocabulary it contains. A fixed
 * generic sentence gives it nothing to go on, so role-specific terms come back
 * as whatever ordinary English sounds closest — "EPMS" as "EPM as", "SCADA" as
 * "scatter" — and a strong accent makes that worse, because the model leans
 * harder on its language prior exactly when the acoustics are ambiguous.
 *
 * Feeding it the words this call is actually about is the cheapest accuracy win
 * available: the company, the role, and the unusual terms already written into
 * the session's job description and instructions.
 *
 * Deliberately capped and comma-separated. It stays well inside Whisper's
 * 224-token prompt limit, and a bare term list gives stripPromptEcho() no
 * sentence to mistake for real speech.
 */
const VOCAB_LIMIT = 40;

function vocabularyFrom(session) {
  if (!session) return '';
  const source = [session.company, session.role, session.job_description, session.context]
    .filter(Boolean).join(' ');
  // Same extractor the answer prompt grounds against, so the words Whisper is
  // primed to hear and the words the answer is checked against stay identical.
  return technicalTerms(source, VOCAB_LIMIT).join(', ');
}

function promptFor(session) {
  const vocab = vocabularyFrom(session);
  return vocab ? `${TRANSCRIBE_PROMPT} Terms used: ${vocab}.` : TRANSCRIBE_PROMPT;
}

/**
 * Whisper-family models echo their own `prompt` back as the transcription when
 * the chunk is silent or near-silent. That echo was reaching the transcript as
 * if the interviewer had said it, and then being sent to /api/answer as the
 * question — which is why answers drifted away from what was actually asked.
 *
 * Strip any echo of the prompt (in whole or by sentence) and treat a chunk that
 * contains nothing else as silence.
 */
const words = (t) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);

/**
 * Word sets for the prompt that was actually sent.
 *
 * These used to be module constants built from TRANSCRIBE_PROMPT alone, while
 * the request sent promptFor(session) — the base prompt PLUS a "Terms used:"
 * vocabulary line. So when Whisper echoed its prompt back (which it does on a
 * chunk it cannot decode) the vocabulary sentence was not recognised as echo
 * and landed in the transcript as though the interviewer had said it.
 *
 * Derived per prompt instead, and memoised because the prompt only changes
 * when the session does.
 */
const wordsetCache = new Map();

function promptWordsets(prompt) {
  const key = String(prompt || '');
  let sets = wordsetCache.get(key);
  if (!sets) {
    sets = key
      .split(/(?<=\.)\s+/)
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean)
      .map((x) => new Set(words(x)));
    // Bounded: one entry per distinct session prompt, not per request.
    if (wordsetCache.size > 50) wordsetCache.clear();
    wordsetCache.set(key, sets);
  }
  return sets;
}

/**
 * Fuzzy, not exact. The model paraphrases its own prompt when it echoes it —
 * observed live: "This is the audio from a job interview." against a prompt of
 * "This is audio from a job interview." A substring test misses that single
 * inserted word, the echo reaches the transcript as a question, and the model
 * then answers it ("I think there might be a misunderstanding..."). Compare by
 * word overlap instead.
 */
function isPromptEcho(sentence, wordsets) {
  const w = words(sentence);
  if (!w.length) return true;
  return wordsets.some((set) => {
    const shared = w.filter((x) => set.has(x)).length;
    // Most of the sentence is prompt vocabulary, and it covers most of a
    // prompt sentence — i.e. it is that sentence, however reworded.
    return shared / w.length >= 0.8 && shared / set.size >= 0.7;
  });
}

/**
 * Phrases Whisper-family models emit when handed silence or noise. They are
 * training-data artifacts (subtitle credits, stock filler), not speech. Left
 * in, each one becomes a "question" and replaces the answer on screen.
 */
const HALLUCINATIONS = [
  'thank you for watching', 'thanks for watching', 'please subscribe',
  'like and subscribe', 'subscribe to my channel', 'thanks for listening',
  'thank you', 'you', 'bye', 'okay', 'ok', 'mm-hmm', 'uh', 'um',
  'silence', '[silence]', '[music]', '[applause]', 'music playing',
  'transcription by', 'amara.org',
];

function isHallucination(sentence) {
  const n = sentence.trim().toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();
  if (!n) return true;
  return HALLUCINATIONS.some((h) => n === h.replace(/[^a-z0-9 ]+/g, '').trim());
}

function stripPromptEcho(text, prompt) {
  // Falls back to the base prompt so any caller that does not pass one keeps
  // the original protection rather than losing it.
  const wordsets = promptWordsets(prompt || TRANSCRIBE_PROMPT);
  const sentences = String(text || '')
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => {
      const norm = sentence.trim().toLowerCase().replace(/\s+/g, ' ');
      if (!norm) return false;
      if (isHallucination(sentence)) return false;
      return !isPromptEcho(sentence, wordsets);
    });

  const cleaned = sentences.join(' ').trim();
  // Nothing but the echo, or a bare fragment left behind — treat as silence.
  return cleaned.length < 2 ? '' : cleaned;
}

async function transcribeAudio(buffer, filename, contentType, session) {
  const file = await toFile(buffer, filename, { type: contentType || 'audio/webm' });
  const promptUsed = promptFor(session);
  const result = await openai().audio.transcriptions.create({
    model: MODEL,
    file,
    prompt: promptUsed,
    ...(LANGUAGE_CODES[String((session && session.language) || '').toLowerCase()]
      ? { language: LANGUAGE_CODES[String(session.language).toLowerCase()] }
      : {}),
  });

  const cleaned = stripPromptEcho(result.text, promptUsed);
  return {
    text: cleaned,
    rawText: result.text,
    usage: result.usage || null,
  };
}

const router = express.Router();

router.post(
  '/',
  requireAuth,
  express.raw({ type: () => true, limit: MAX_CHUNK_BYTES }),
  async (req, res, next) => {
    if (!Buffer.isBuffer(req.body) || req.body.length < 3000) {
      return res.json({ text: '' });
    }

    const filename = String(req.get('X-Filename') || 'chunk.webm');
    const ext = filename.toLowerCase().split('.').pop();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return res.status(415).json({
        error: 'unsupported_audio',
        message: `Unsupported audio format .${ext}`,
      });
    }

    const { sessionExists, getSession } = require('./sessions');
    const used = await tokensUsedThisMonth(req.user.id);
    const gate = quota.check(req.user, used, RESERVE_TOKENS);
    if (gate.blocked) {
      return res.status(429).json({
        error: 'quota_exhausted',
        message: 'Monthly token safety limit reached. Transcription stopped.',
        tokens_remaining: gate.remaining,
      });
    }

    const sessionId = await sessionExists(req.user.id, req.get('X-Session-Id'));
    const usageId = await reserveUsage(req.user.id, MODEL, 0, RESERVE_TOKENS, sessionId);
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      const session = sessionId ? await getSession(req.user.id, sessionId) : null;
      const contentType = req.get('Content-Type') || 'audio/webm';
      const result = await transcribeAudio(req.body, filename, contentType, session);

      if (result.usage) {
        inputTokens = result.usage.input_tokens || 0;
        outputTokens = result.usage.output_tokens || 0;
      } else {
        // whisper-1 and friends report nothing; keep the reservation so the
        // call is never silently free.
        outputTokens = RESERVE_TOKENS;
      }

      if (!result.text && result.rawText && result.rawText.trim()) {
        // Whisper returned words but every sentence was prompt echo or a known
        // hallucination. Logged rather than dropped in silence: during a live
        // interview this is indistinguishable from "nobody spoke".
        console.debug(
          `[TRANSCRIPT DROP] reason=filtered t=${new Date().toISOString()} ` +
          `session=${sessionId || '-'} rawLen=${result.rawText.trim().length} ` +
          `raw="${result.rawText.trim().slice(0, 80).replace(/\s+/g, ' ')}"`
        );
      }
      return res.json({ text: result.text });
    } catch (err) {
      // Nothing was transcribed, so release the whole reservation.
      inputTokens = 0;
      outputTokens = 0;
      return next(err);
    } finally {
      await settleUsage(usageId, inputTokens, outputTokens);
    }
  }
);

module.exports = {
  router,
  transcribeAudio,
  MODEL,
  RESERVE_TOKENS,
  ALLOWED_EXTENSIONS
};

