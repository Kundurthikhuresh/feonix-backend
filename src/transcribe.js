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
const { requireAuthLive } = require('./auth');
const { openai } = require('./openai-client');
const quota = require('./quota');
const { technicalTerms } = require('./modes');
const { rateLimit } = require('./rateLimit');

const MODEL = process.env.TRANSCRIBE_MODEL || 'whisper-1';
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

// Concise prompt primes Whisper for technical software dialogue without the heavy
// 50-word vocabulary burden that caused 5+ second latency and YouTube outro hallucinations.
// Kept to this one line: a longer hint (language, accent, "interview") was
// borrowed word for word into invented sentences on near-silent clips. The
// wrong-script problem is handled by the whisper-1 retry instead.
const CORE_TECH_VOCABULARY = 'Technical software engineering interview dialogue.';

const TRANSCRIBE_PROMPT = CORE_TECH_VOCABULARY;

const VOCAB_LIMIT = 5;

function vocabularyFrom(session) {
  if (!session) return '';
  const source = [session.company, session.role, session.job_description, session.context]
    .filter(Boolean).join(' ');
  return technicalTerms(source, VOCAB_LIMIT).join(', ');
}

function promptFor(session) {
  const vocab = vocabularyFrom(session);
  return vocab ? `${CORE_TECH_VOCABULARY} Topics: ${vocab}.` : `${CORE_TECH_VOCABULARY}.`;
}

function repairTechnicalAcoustics(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/\b(object|class|interface|inheritance|polymorphism|encapsulation|abstraction|methods?|constructors?|packages?|variables?|arrays?|strings?|pointers?|threads?|garbage collection|generics?)\s+in\s+(a\s+)?job\s+inter?views?\b/gi, '$1 in Java')
    .replace(/\b(in|with|using)\s+job\s+inter?views?\s+(programming|language|code|oop|framework|application)\b/gi, '$1 Java $2')
    .replace(/\bwhat\s+is\s+(an?\s+)?object\s+in\s+job\s+inter?views?\b/gi, 'what is an object in Java')
    .replace(/\bhow\s+to\s+use\s+(an?\s+)?object\s+in\s+job\s+inter?views?\b/gi, 'how to use an object in Java')
    .replace(/\b(in|for)\s+job\s+interview\s+(class|object|interface)\b/gi, '$1 Java $2')
    .replace(/\b(c\s+sharp|see\s+sharp)\b/gi, 'C#')
    .replace(/\b(c\s+plus\s+plus|see\s+plus\s+plus)\b/gi, 'C++')
    .replace(/\b(node\s+j\s*s|node\s+js)\b/gi, 'Node.js')
    .replace(/\b(react\s+j\s*s|react\s+js)\b/gi, 'React')
    .replace(/\bjason\s+(object|payload|response|data|format|string)\b/gi, 'JSON $1');
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
    if (wordsetCache.size > 50) wordsetCache.clear();
    wordsetCache.set(key, sets);
  }
  return sets;
}

function isPromptEcho(sentence, wordsets) {
  const w = words(sentence);
  if (!w.length) return !sentence.trim();
  // One to three words, all taken from the hint ("dialogue..", "interview
  // dialogue"): a fragment of the hint, not speech.
  if (w.length <= 3 && w.every((x) => wordsets.some((set) => set.has(x)))) return true;
  return wordsets.some((set) => {
    const shared = w.filter((x) => set.has(x)).length;
    return shared / w.length >= 0.88 && shared / set.size >= 0.8;
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
  'transcription by', 'amara.org', 'cuáles son', 'cuales son',
  'muchas gracias por ver', 'hangi zarzı', 'hangi zarzi',
  'useless', 'go download them all', "i'm out", "i don't know", "that's all",
  'thank you so much', 'have a great day', 'have a good day', 'have a nice day',
  'have a wonderful day', 'have a pleasant day', 'good day', 'good bye', 'goodbye',
  'if you liked this video', 'if you enjoyed this video', 'i have more videos',
  'more videos', 'check out my channel', 'see you next time', 'see you later',
  'see you soon', 'have a good one', 'have a nice one',
  'good night', 'goodnight', 'good night everyone',
];

const HALLUCINATION_REGEXES = [
  /transcrib(ed|tion|ing)\s+by/i,
  /subtitles?\s+by/i,
  /captions?\s+by/i,
  /closed\s+captions/i,
  /amara\.org/i,
  /otter\.ai/i,
  /https?:\/\//i,
  /www\./i,
  /\bopenai\b/i,
  // gpt-4o-mini-transcribe echoes its prompt with extra words ("Context: ###
  // Technical software engineering interview dialogue. This...") that the
  // word-overlap echo check misses.
  /technical\s+software\s+engineering\s+interview\s+dialogue/i,
  /^context\s*:\s*#/i,
  // On near-silent clips gpt-4o-mini-transcribe writes chatbot lines, often
  // borrowing words from its hint ("Hello, I am ChatGPT, your AI assistant",
  // "I am here for the technical software engineering interview"). Nobody in
  // a real interview says these, and each was being answered as a question.
  /\bchat\s*gpt\b/i,
  /\b(your|an?)\s+ai\s+assistant\b/i,
  /\bhow\s+(can|may)\s+i\s+(help|assist)\s+you\b/i,
  /\btechnical\s+software\s+engineering\s+interview\b/i,
  /\bindian[-\s]accented\b/i,
  /\bwritten\s+in\s+english\s+letters\b/i,
  // Stock video narration the model invents over background noise.
  /\bshare\s+(the|this)\s+video\b/i,
  /\b(the|this)\s+video\s+is\s+(limited|about|sponsored)\b/i,
  /\bsocial\s+networks?\b.*\bvideo\b|\bvideo\b.*\bsocial\s+networks?\b/i,
  /\b(door|doors)\s+(opening|closing)\b.*\b(opening|closing)\b/i,
  /^\s*(vocabulary|dialogue)[.\s]*$/i,
  /thank(s|\s+you)\s+for\s+(watching|listening)/i,
  /like\s+and\s+subscribe/i,
  /subscribe\s+to\s+(my\s+)?channel/i,
  /see\s+you\s+(in\s+the\s+next|next\s+time|later|soon)/i,
  /bye\s*bye/i,
  /\bhave\s+a\s+(good|great|nice|wonderful|pleasant)\s+(day|weekend|evening|night|one)\b/i,
  /\bif\s+you\s+(liked|enjoyed)\s+this\s+video\b/i,
  /\bi\s+have\s+more\s+videos\b/i,
  /\bplease\s+subscribe\b/i,
  /\b(leave\s+a\s+comment|smash\s+the\s+like|don't\s+forget\s+to\s+subscribe)\b/i,
  /^(useless|go download them all|i'm out|i don't know|that's all|thank you so much|have a great day|have a good day|have a nice day|have a good one)[\.\?!]?$/i,
  /^\[.*\]$/,
  /^\(.*\)$/,
  /[♪♫]/,
];

const CJK_REGEX = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f\uac00-\ud7af]/;
const CYRILLIC_REGEX = /[\u0400-\u04ff]/;
const ARABIC_REGEX = /[\u0600-\u06ff]/;
// Arabic/Urdu, Devanagari, Telugu, Tamil, Cyrillic or CJK letters in what
// should be English: the words were written in the wrong script.
const NON_LATIN_SCRIPT_REGEX = /[\u0600-\u06ff\u0750-\u077f\u0900-\u097f\u0c00-\u0c7f\u0b80-\u0bff\u0400-\u04ff\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/;
const FALLBACK_MODEL = 'whisper-1';
const CLIP_TIMEOUT_MS = Number(process.env.TRANSCRIBE_TIMEOUT_MS || 4000);
const TINY_CLIP_BYTES = 8000;
const RETRY_EMPTY_MIN_BYTES = 20000;
const GREETING_START = /^(hello|hi|hey|good\s+(morning|afternoon|evening|night))\b/i;
// Spanish/Portuguese/French letters. gpt-4o-mini-transcribe sometimes switches
// an accented English question into Spanish ("functional decentralization"
// came back as "descentralización funcional"), which the Latin-only script
// check above cannot see. Two or more such letters, outside the few accented
// words English speakers use, means the clip is redone in English.
const FOREIGN_LATIN_REGEX = /[ñáíóúüàèìòùâêîôûãõçœ¿¡]/gi;
const ENGLISH_ACCENTED_WORDS = /\b(r[ée]sum[ée]s?|caf[ée]s?|na[ïi]ve|clich[ée]|fa[çc]ade|d[ée]j[àa]|pi[ñn]ata|jalape[ñn]o)\b/gi;
function looksForeignLatin(text) {
  const plain = String(text || '').replace(ENGLISH_ACCENTED_WORDS, '');
  const hits = plain.match(FOREIGN_LATIN_REGEX);
  return /[¿¡ñäöß]/i.test(plain)
    || (hits ? hits.length : 0) >= 2
    || /[a-z](ción|ciones|ção|ções|sión|siones)\b/i.test(plain)
    || /(^|\s)(qué|cómo|cuál|cuáles|está|también|después|más|así)(?=[\s.,?!]|$)/i.test(plain);
}

const MULTILINGUAL_HALLUCINATIONS = [
  '他に何かご質問はありますか', 'ご視聴ありがとうございました', 'チャンネル登録',
  '哇真是加速', '请不吝点赞', '谢谢大家', '谢谢观看',
];

function isHallucination(sentence, sessionLang = 'en') {
  const trimmed = String(sentence || '').trim();
  if (!trimmed) return true;

  for (const regex of HALLUCINATION_REGEXES) {
    if (regex.test(trimmed)) return true;
  }

  const lang = String(sessionLang || 'en').toLowerCase();

  // If the user's session is in English (or Latin-based languages):
  // Any sentence with CJK (Japanese, Chinese, Korean), Cyrillic, or Arabic script is an obvious silence hallucination.
  if (lang === 'en' || lang === 'english') {
    if (CJK_REGEX.test(trimmed)) return true;
    if (CYRILLIC_REGEX.test(trimmed) || ARABIC_REGEX.test(trimmed)) return true;
    if (trimmed.startsWith('¿') || trimmed.startsWith('¡')) return true;
  }

  // Known multilingual silence phrases that should always be dropped
  if (MULTILINGUAL_HALLUCINATIONS.some((h) => trimmed.includes(h))) {
    return true;
  }

  const n = trimmed.toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();
  if (!n) return true;
  return HALLUCINATIONS.some((h) => n === h.replace(/[^a-z0-9 ]+/g, '').trim());
}

function deduplicateSentences(text) {
  if (!text || typeof text !== 'string') return '';
  const parts = text.split(/(?<=[?.!])\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) return text.trim();

  const unique = [];
  for (const part of parts) {
    const norm = part.toLowerCase().replace(/[^a-z0-9]/g, '');
    const lastNorm = unique.length ? unique[unique.length - 1].toLowerCase().replace(/[^a-z0-9]/g, '') : '';
    if (norm && norm !== lastNorm) {
      unique.push(part);
    }
  }
  return unique.join(' ');
}

function stripPromptEcho(text, prompt, sessionLang = 'en') {
  // Falls back to the base prompt so any caller that does not pass one keeps
  // the original protection rather than losing it.
  const wordsets = promptWordsets(prompt || TRANSCRIBE_PROMPT);
  const sentences = String(text || '')
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => {
      const norm = sentence.trim().toLowerCase().replace(/\s+/g, ' ');
      if (!norm) return false;
      if (isHallucination(sentence, sessionLang)) return false;
      return !isPromptEcho(sentence, wordsets);
    });

  const rawCleaned = sentences.join(' ').trim();
  const cleaned = deduplicateSentences(rawCleaned);
  // Nothing but the echo, or a bare fragment left behind — treat as silence.
  return cleaned.length < 2 ? '' : cleaned;
}

async function transcribeAudio(buffer, filename, contentType, session, customKey) {
  const file = await toFile(buffer, filename, { type: contentType || 'audio/webm' });
  const promptUsed = promptFor(session);
  const sessionLang = String((session && session.language) || '').toLowerCase();
  const langCode = LANGUAGE_CODES[sessionLang] || 'en';
  // A clip normally comes back in about a second. Some requests hung for
  // 17-26s, so the question arrived long after it was asked and the browser
  // had already given up and re-sent the same clip. A stuck request is now
  // abandoned after a few seconds and tried once more straight away.
  let result = await openai(customKey).audio.transcriptions.create({
    model: MODEL,
    file,
    prompt: promptUsed,
    language: langCode,
  }, { timeout: CLIP_TIMEOUT_MS, maxRetries: 1 });

  /* With Indian-accented English, gpt-4o-mini-transcribe sometimes ignores
   * language=en and writes the words in Arabic/Urdu script ("loops in Python"
   * came back as لوغز إن بايثون). The filter rightly drops that as noise, so the
   * question was lost. whisper-1 follows the language setting strictly, so
   * only those chunks are redone with it. */
  const isEnglish = langCode === 'en';
  const wrongScript = isEnglish && (
    NON_LATIN_SCRIPT_REGEX.test(String(result.text || '')) || looksForeignLatin(result.text)
  );
  /* About a third of the longer clips (2.5s+ of audio) came back completely
   * empty from gpt-4o-mini-transcribe, and spoken questions were among them —
   * the "voice not detected" reports. A clip that long is redone with
   * whisper-1 when it yields nothing usable; short clips are mostly silence
   * and are not worth the extra second. */
  const missedSpeech = buffer.length >= RETRY_EMPTY_MIN_BYTES
    && !stripPromptEcho(result.text, promptUsed, sessionLang || 'en');
  let retried = null;
  if (wrongScript || missedSpeech) {
    retried = wrongScript ? 'script' : 'empty';
    try {
      const retryFile = await toFile(buffer, filename, { type: contentType || 'audio/webm' });
      // No hint for whisper-1: given one, it answered silence with the hint's
      // own words ("dialogue..", "vocabulary"), which then reached the copilot.
      result = await openai(customKey).audio.transcriptions.create({
        model: FALLBACK_MODEL,
        file: retryFile,
        language: isEnglish ? 'en' : langCode,
      }, { timeout: CLIP_TIMEOUT_MS, maxRetries: 0 });
    } catch (err) {
      console.warn(`[TRANSCRIBE] ${FALLBACK_MODEL} retry failed: ${err.message}`);
    }
  }

  // Still not English after the retry: better heard as nothing than answered
  // as a question nobody asked.
  if (isEnglish && looksForeignLatin(result.text)) result = { ...result, text: '' };
  const rawCleaned = stripPromptEcho(result.text, promptUsed, sessionLang || 'en');
  let cleaned = repairTechnicalAcoustics(rawCleaned);
  // A clip this small is under a second of near-silence. Every greeting such a
  // clip produced in the logs was invented ("Hello, can you hear me?"); real
  // greetings arrived in clips two or more times this size.
  if (buffer.length < TINY_CLIP_BYTES && GREETING_START.test(cleaned)) cleaned = '';
  return {
    text: cleaned,
    rawText: result.text,
    retried,
    usage: result.usage || null,
  };
}

const router = express.Router();

// Development-only trace of what each chunk transcribed to, so "the copilot
// doesn't hear me" can be diagnosed from a file instead of the console.
// Contains spoken content: never enabled in production, capped at ~1 MB.
const fs = require('fs');
const path = require('path');
const DEBUG_LOG = path.join(__dirname, '..', 'logs', 'transcribe-debug.log');
function debugLog(line) {
  if (process.env.NODE_ENV === 'production') return;
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });
    try { if (fs.statSync(DEBUG_LOG).size > 1024 * 1024) fs.writeFileSync(DEBUG_LOG, ''); } catch { /* new file */ }
    fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${line}\n`);
  } catch { /* diagnostics must never break transcription */ }
}

// Headroom for continuous 1-second chunk recording plus retries
const transcribeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  keyFn: (req) => `transcribe:${req.user.id}`,
});

router.post(
  '/',
  requireAuthLive,
  transcribeLimiter,
  express.raw({ type: () => true, limit: MAX_CHUNK_BYTES }),
  async (req, res, next) => {
    if (!Buffer.isBuffer(req.body) || req.body.length < 400) {
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

    const { getSessionLive: getSession } = require('./sessions');
    const requestedSessionId = req.get('X-Session-Id');

    const [used, session] = await Promise.all([
      tokensUsedThisMonth(req.user.id),
      requestedSessionId ? getSession(req.user.id, requestedSessionId) : Promise.resolve(null),
    ]);

    const gate = quota.check(req.user, used, RESERVE_TOKENS);
    if (gate.blocked) {
      return res.status(429).json({
        error: 'quota_exhausted',
        message: 'Monthly token safety limit reached. Transcription stopped.',
        tokens_remaining: gate.remaining,
      });
    }

    const sessionId = session ? session.id : null;
    const usagePromise = reserveUsage(req.user.id, MODEL, 0, RESERVE_TOKENS, sessionId);
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      const contentType = req.get('Content-Type') || 'audio/webm';
      const customKey = req.get('x-openai-api-key') || req.get('X-OpenAI-Key') || (req.headers['authorization']?.startsWith('Bearer ') && req.headers['authorization'].slice(7).startsWith('sk-') ? req.headers['authorization'].slice(7) : null);
      const t0 = Date.now();
      const result = await transcribeAudio(req.body, filename, contentType, session, customKey);
      debugLog(`session=${sessionId || '-'} bytes=${req.body.length} ms=${Date.now() - t0}${result.retried ? ` retried=${result.retried}` : ''} raw=${JSON.stringify(result.rawText || '')} clean=${JSON.stringify(result.text || '')}`);

      if (result.usage) {
        inputTokens = result.usage.input_tokens || 0;
        outputTokens = result.usage.output_tokens || 0;
      } else {
        // whisper-1 and friends report nothing; keep the reservation so the
        // call is never silently free.
        outputTokens = RESERVE_TOKENS;
      }

      console.log(`[TRANSCRIBE] chunk=${req.body.length}b raw="${result.rawText || ''}" clean="${result.text || ''}"`);
      if (!result.text && result.rawText && result.rawText.trim()) {
        console.log(
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
      console.warn(`[TRANSCRIBE CHUNK ERROR] ${err.name}: ${err.message}`);
      // If it's a timeout or network blip, recover cleanly with empty text rather than crashing the client chunk pipeline
      if (/timed?\s*out|timeout|abort/i.test(err.message || '')) {
        return res.json({ text: '' });
      }
      return next(err);
    } finally {
      await settleUsage(await usagePromise, inputTokens, outputTokens);
    }
  }
);

module.exports = {
  router,
  transcribeAudio,
  stripPromptEcho,
  transcribeLimiter,
  MODEL,
  RESERVE_TOKENS,
  ALLOWED_EXTENSIONS
};

