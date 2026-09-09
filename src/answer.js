// POST /api/answer — the endpoint that costs money.
//
// Every call goes out on the server's OpenAI key, so the flow is:
//   1. build the prompt from the user's own resume / job description
//   2. work out how many tokens are left in this month's quota
//   3. RESERVE the worst case against the quota before calling OpenAI
//   4. cap max_completion_tokens so the worst case is actually bounded
//   5. stream the answer back as SSE
//   6. settle the reservation with the real usage the API reports
//
// Step 3 is what makes the quota real under concurrency: a live interview
// fires questions back-to-back, and without a reservation two in-flight calls
// both read the same "tokens used" figure and both decide they fit.

const express = require('express');
const { col, nowSql, isExpired, addMinutesFromNow, loadDocContent, tokensUsedThisMonth, reserveUsage, settleUsage } = require('./db');
const { requireAuth } = require('./auth');
const { openai } = require('./openai-client');
const { rateLimit } = require('./rateLimit');
const {
  SESSION_TYPES, ACTIONS, DEFAULT_TYPE, DEFAULT_ACTION, systemPromptFor, catalogue,
  groundingBlock, classifyQuestion,
} = require('./modes');
const { saveAnswer } = require('./history');
const credits = require('./credits');
const quota = require('./quota');

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

/**
 * Models a session may choose. Only models this backend can actually reach are
 * listed — an unknown value falls back to the default rather than failing the
 * answer. `recommended` drives the label in the picker.
 */
const AGENTS = [
  { id: 'gpt-4o-mini', label: 'GPT-4o mini', recommended: true,
    hint: 'Fastest and cheapest. Best for live interviews.' },
  { id: 'gpt-4o', label: 'GPT-4o', recommended: false,
    hint: 'Stronger reasoning, slower and ~16x the cost.' },
];

function modelFor(session) {
  const wanted = session && session.agent;
  return AGENTS.some((a) => a.id === wanted) ? wanted : MODEL;
}
// One spoken answer plus the short [TYPE]/[POINTS] preamble. Sized with
// headroom above the default length rules in modes.js (now 9-14 spoken lines
// per answer) so a longer explicit request ("answer in 20 lines") or a
// [ANSWER] deepen still has room instead of hitting the truncation backstop.
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS || 1600);

// A call that can't afford at least this much output isn't worth starting.
const MIN_USEFUL_OUTPUT_TOKENS = 64;

const MAX_QUESTION_CHARS = 2000;
const MAX_TRANSCRIPT_CHARS = 6000;
// Each is already downscaled/compressed client-side (see
// frontend/src/services/screenshotService.js), so this is a sanity cap
// against an oversized or malformed request rather than a real-world limit
// anyone taking screenshots by hand would ever hit.
const MAX_IMAGES = 8;
const MAX_DOC_CHARS = 8000;

const router = express.Router();

// A live interview asks questions minutes apart, not several per second —
// this is a backstop against a runaway client or a compromised renderer
// hammering the paid endpoint, not a throttle on real use. Regenerate/
// Shorten/Expand share the same bucket, so someone clicking through all
// three on one answer still comfortably fits inside a minute.
const answerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyFn: (req) => `answer:${req.user.id}`,
});

// ~4 characters per token. Only used for the pre-flight estimate and as a
// fallback if a stream dies before reporting usage — the reservation covers
// the gap either way, and settle overwrites it with the real numbers.
const CHARS_PER_TOKEN = 4;

function tokensFromChars(chars) {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function estimateTokens(text) {
  return tokensFromChars(String(text || '').length);
}

// The library can hold several resumes; the one marked active is the one
// answers are written from. Newest is only the fallback, for rows that predate
// the active flag.
//
// Prepared lazily, not at module load: `is_active` is added by a migration in
// documents.js, which server.js requires after this file. Preparing eagerly
// binds this module to that require order and crashes the server if it changes.
function loadDoc(userId, kind) {
  return loadDocContent(userId, kind, MAX_DOC_CHARS);
}

/**
 * Message order here is load-bearing, not stylistic.
 *
 * The resume and job description are ~2,600 tokens and identical on every call
 * of a session; the transcript and question change every time. OpenAI caches
 * repeated prompt PREFIXES, so as long as the unchanging documents sit ahead of
 * anything volatile, the second and later answers of a session re-use that
 * cached prefix — cheaper per call and noticeably faster to first token.
 *
 * Interleaving them (documents, then transcript, then question, in one blob)
 * changes the prefix on every request and gives up the cache entirely.
 */
function buildMessages({
  question, transcript, resume, experience, jobDescription, company,
  sessionJobDescription, mode, action, language, images, answerStyle,
  sessionCompany, sessionRole, sessionContext,
}) {
  const stable = [];
  if (resume) stable.push(`## Candidate resume\n${resume}`);
  /* Real incidents the resume does not contain. The resume lists duties only,
   * so without this a behavioural question had nothing true to draw on and the
   * model either invented a story or declined to tell one the candidate
   * actually has. Sits in the cacheable prefix with the other documents. */
  if (experience) stable.push(`## Trusted candidate experience\n${experience}`);
  const jd = (sessionJobDescription && sessionJobDescription.trim()) || jobDescription;
  if (jd) stable.push(`## Target job description\n${jd}`);
  if (company) stable.push(`## About the company\n${company}`);
  if (!resume) {
    stable.push(
      '## Note\nNo resume is on file for this user. Answer generically and do not ' +
        'attribute any specific experience to the candidate.'
    );
  }

  // Who the interview is actually with, straight off the session record.
  if (sessionCompany || sessionRole) {
    stable.push(`## This interview\n${[
      sessionCompany && `Company: ${sessionCompany}`,
      sessionRole && `Role: ${sessionRole}`,
    ].filter(Boolean).join('\n')}`);
  }

  const volatile = [];
  if (transcript) volatile.push(`## Recent conversation\n${transcript}`);

  /* When the candidate has already spoken, say so right next to the question.
   * The same instruction lives in the shared rules, but by the time the model
   * reaches the question it has read a lot of prompt — and the QA run showed one
   * clause ("which was a significant achievement given the tight deadlines")
   * recycled verbatim across four consecutive follow-ups. Restating it here,
   * against this specific question, is what makes it bind. */
  if (/^Candidate:/m.test(String(transcript || ''))) {
    volatile.push(
      '## Already said\nThe lines above marked "Candidate:" are answers you have\n' +
      'already given out loud. Do not reuse their sentences or phrases. This\n' +
      'question is asking for something you have not said yet — give that, and\n' +
      'assume the interviewer remembers the rest.'
    );
  }

  /* A question asking for a specific past episode is the one place the model
   * reliably invents. Stated only in the system prompt the constraint did not
   * bind — four independent runs each produced a different UPS failure that is
   * nowhere in the resume. Put against the question itself, it holds. */
  /* Follow-ups probe the episode the previous answer was about. They are not
   * classified BEHAVIORAL, so they skipped this check — and after an answer that
   * honestly declined to invent a UPS failure, "what was your contribution?"
   * promptly invented one. The probe itself, and any turn following a decline,
   * needs the same constraint. */
  const isEpisodeProbe = /^(what (was|were) (your|the)|how did you|what did you do|who else|when did (that|this)|what would you do differently)\b/i
    .test(String(question || '').trim());
  /* Matches however the decline was actually phrased. The model is told to word
   * it differently each time, so pinning this to one form ("rather not invent")
   * missed "rather not overstate" and re-injected the caveat on every turn. */
  const declinedAlready = /Candidate:[^\n]*(rather not|prefer not|not going to|don'?t want to|can'?t point to|cannot point to)[^\n]*(invent|overstate|make (that|one|it) up|fabricate|specific (case|example|incident))/i
    .test(String(transcript || ''));

  if (declinedAlready) {
    /* The caveat has been said. Repeating it on every follow-up is its own
     * problem — a candidate who declines three times running sounds evasive,
     * and the identical sentence three times sounds read. Hold the constraint,
     * drop the preamble. */
    volatile.push(
      '## Already covered\n' +
      'You have already told this interviewer you are not going to invent a\n' +
      'specific case. Do not say it again — saying it once is honest, saying it\n' +
      'every time sounds evasive and rehearsed. Answer this follow-up straight,\n' +
      'about the work itself: what you actually do, look at, and escalate. Still\n' +
      'no invented incident, deadline, vendor conversation, metric or outcome.'
    );
  } else if (isEpisodeProbe) {
    /* A follow-up about a story that has already been told. It must stay on the
     * same incident and answer the new angle. Without its own branch it fell
     * through to the evidence check below, whose no-episode wording made it
     * decline to give specifics it had just given — "I don't want to overstate
     * a specific case" arriving immediately after a real story. */
    volatile.push(
      '## Same incident\n' +
      'This follows up on what you just described. Stay on that same incident and\n' +
      'answer the specific angle asked — your own part in it, the hardest part,\n' +
      'how you knew it worked, what you would change. Use only facts listed under\n' +
      'KNOWN in the trusted experience; if the answer needs a detail listed as\n' +
      'MISSING, say that is not something you would state precisely from memory.\n' +
      'Do not re-tell the story, and do not decline to be specific — you have the\n' +
      'story, so answer from it.'
    );
  } else if (classifyQuestion(question) === 'BEHAVIORAL') {
    volatile.push(
      '## Evidence check\n' +
      'This asks for a specific thing that happened. Look in "Trusted candidate\n' +
      'experience" and the resume above for an actual episode that fits — a real\n' +
      'incident, failure, improvement, or a result with a number attached. If one\n' +
      'is there, TELL IT. That is what it is for, and an honest specific story is\n' +
      'the strongest answer available.\n\n' +
      'The episode has to be about what was actually asked. An alarm story is not\n' +
      'a story about disagreeing with a manager; a UPS failure is not a story\n' +
      'about missing a deadline. If nothing under KNOWN matches the SUBJECT of\n' +
      'this question, you do not have a story for it — do not substitute a\n' +
      'different incident because it is the closest one available.\n\n' +
      'Use only what is written under KNOWN. Anything under MISSING is not known:\n' +
      'never supply it, not even as a natural-sounding closing sentence. "I made\n' +
      'changes to our protocols afterwards" is exactly the kind of plausible\n' +
      'ending that is listed as MISSING and must not be said. If the interviewer\n' +
      'asks for a MISSING detail, say it is not something you would state\n' +
      'precisely from memory and offer to follow up.\n\n' +
      'A list of duties is not an episode. "Supports UPS systems" means the\n' +
      'candidate does that work; it does not mean any particular UPS failed, that\n' +
      'a vendor was called, or that anything was restored in any timeframe. If\n' +
      'the only thing you can find is a responsibility, then you do not have a\n' +
      'story and you must not build one.\n\n' +
      'Only if there is genuinely no matching episode anywhere above: talk affirmatively\n' +
      'and concretely about how you approach this work — the systems, best practices,\n' +
      'troubleshooting methodology, and execution steps. Concrete about the work and\n' +
      'principles, without inventing fictional company names or dates.\n' +
      'Phrase that opening naturally yourself. Do not reuse a set formula.\n' +
      'Focus on delivering high-value, competent answers that showcase your expertise.'
    );
  }

  let styleInstruction = '';
  if (answerStyle === 'star') {
    styleInstruction = '\n## Required Format: STAR Method\nStructure answer clearly with Situation, Task, Action, and Measurable Result.';
  } else if (answerStyle === 'code') {
    styleInstruction = '\n## Required Format: Optimal Code Solution\nProvide clean, production-ready code with step-by-step logic, followed by Time Complexity and Space Complexity analysis.';
  } else if (answerStyle === 'teleprompter') {
    styleInstruction = '\n## Required Format: Stealth Teleprompter Hints\nProvide 3-4 concise, high-impact bullet points designed for a candidate to glance at and say out loud naturally.';
  } else if (answerStyle === 'quiz') {
    styleInstruction = '\n## Required Format: Multiple Choice Solver\nState the correct Option/Letter first in bold, followed by a concise 2-sentence rationale.';
  }

  volatile.push((ACTIONS[action] || ACTIONS[DEFAULT_ACTION]).instruction(question) + styleInstruction);

  let userVolatileContent;
  if (images && images.length) {
    const promptText = volatile.join('\n\n') || (
      images.length > 1
        ? `Analyze the question across these ${images.length} screenshots and provide the optimal solution/answer.`
        : 'Analyze the question in this screenshot and provide the optimal solution/answer.'
    );
    userVolatileContent = [
      { type: 'text', text: promptText },
      ...images.map((img) => ({
        type: 'image_url',
        image_url: { url: img.startsWith('data:') ? img : `data:image/png;base64,${img}` },
      })),
    ];
  } else {
    userVolatileContent = volatile.join('\n\n');
  }

  return [
    {
      role: 'system',
      content: systemPromptFor(
        mode, action, language, sessionContext, question, groundingBlock(resume, jd)
      ),
    },
    { role: 'user', content: stable.join('\n\n') },   // cacheable prefix ends here
    { role: 'user', content: userVolatileContent },
  ];
}

function sse(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

// Lets the client render the persona and action lists without hardcoding them.
router.get('/catalogue', requireAuth, (req, res) => res.json({ ...catalogue(), agents: AGENTS }));

router.post('/', requireAuth, answerLimiter, async (req, res, next) => {
  const question = String((req.body && req.body.question) || '').trim();
  const rawImages = (req.body && req.body.images) || (req.body && req.body.image ? [req.body.image] : []);
  const images = Array.isArray(rawImages) ? rawImages.filter(Boolean).slice(0, MAX_IMAGES) : [];
  const answerStyle = req.body && req.body.answerStyle;
  const action = ACTIONS[req.body && req.body.action] ? req.body.action : DEFAULT_ACTION;

  // Unknown or someone else's session id attributes to nothing rather than
  // failing the call — a bad id shouldn't cost the user their answer.
  const { getSession } = require('./sessions');
  const session = await getSession(req.user.id, req.body && req.body.session_id);
  const sessionId = session ? session.id : null;

  // The session's own settings win over the request body: the call was
  // configured up front, and the live surface shouldn't be able to drift from it.
  const mode = session && SESSION_TYPES[session.mode]
    ? session.mode
    : (SESSION_TYPES[req.body && req.body.mode] ? req.body.mode : DEFAULT_TYPE);
  const language = (session && session.language) || 'English';

  /* ---- session lifecycle gate ---------------------------------------
   *
   * Nothing here used to check whether the session was still alive, which is
   * why answers kept being generated after a trial ran out: the client stopped
   * its countdown, but the API happily served anything that asked. The session
   * row is the authority — an ended session or a passed expires_at is refused
   * before a single token is bought.
   */
  if (session) {
    if (session.status === 'ended') {
      return res.status(409).json({ error: 'session_ended', message: 'This session has ended.' });
    }
    if (session.expires_at && isExpired(session.expires_at)) {
      await col('call_sessions').updateOne(
        { id: session.id },
        { $set: { status: 'ended', ended_at: session.ended_at || nowSql() } }
      );
      const fresh = await col('call_sessions').findOne({ id: session.id });
      await credits.settleSession(fresh);
      return res.status(409).json({ error: 'session_expired', message: 'Session time has run out.' });
    }
  }

  // Recap and follow-ups work off the transcript alone — there is no question
  // to answer, and demanding one would make the buttons unusable mid-call.
  const needsQuestion = action === 'answer' || action === 'shorten' || action === 'deepen';
  if (needsQuestion && !question) {
    return res.status(400).json({ error: 'missing_question', message: 'question is required.' });
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return res.status(413).json({
      error: 'question_too_long',
      message: `Question must be under ${MAX_QUESTION_CHARS} characters.`,
    });
  }

  // Keep the tail — the newest turns are the ones that matter, and an
  // unbounded transcript is the easiest way to burn a quota by accident.
  const transcript = String((req.body && req.body.transcript) || '').slice(-MAX_TRANSCRIPT_CHARS);

  const messages = buildMessages({
    question,
    transcript,
    resume: await loadDoc(req.user.id, 'resume'),
    experience: await loadDoc(req.user.id, 'experience'),
    jobDescription: await loadDoc(req.user.id, 'job_description'),
    company: await loadDoc(req.user.id, 'company'),
    // A job description written for THIS call beats the one filed globally.
    sessionJobDescription: session && session.job_description,
    sessionCompany: session && session.company,
    sessionRole: session && session.role,
    sessionContext: session && session.context,
    images,
    answerStyle,
    mode,
    action,
    language,
  });

  /* ---- token safety-rail (credits are the real entitlement) --------- */

  // Multimodal message content is an array of parts (text + one image_url
  // per attached screenshot), not a string — joining it directly used to
  // stringify each part as "[object Object]", silently estimating ~0 real
  // tokens for however many images were attached. That under-count let a
  // multi-screenshot request slip past the quota gate below almost for
  // free. ~1100 tokens/image is a conservative estimate for how OpenAI
  // actually tokenizes an image in this size range — good enough for a
  // safety rail, not meant to match billed usage exactly.
  const TOKENS_PER_IMAGE_ESTIMATE = 1100;
  const textContent = messages
    .map((m) => (typeof m.content === 'string' ? m.content : (m.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n')))
    .join('\n');
  const promptEstimate = estimateTokens(textContent) + images.length * TOKENS_PER_IMAGE_ESTIMATE;
  const used = await tokensUsedThisMonth(req.user.id);
  const gate = quota.check(req.user, used, promptEstimate + MIN_USEFUL_OUTPUT_TOKENS);

  if (gate.blocked) {
    return res.status(429).json({
      error: 'quota_exhausted',
      message: 'Monthly token safety limit reached. Ask the owner to raise it.',
      token_quota: req.user.token_quota,
      tokens_used_this_month: used,
    });
  }

  const maxOutputTokens = quota.outputBudget(MAX_OUTPUT_TOKENS, gate.remaining, promptEstimate);

  // Charged now, corrected in the finally block below.
  const chosenModel = modelFor(session);
  const usageId = await reserveUsage(req.user.id, chosenModel, promptEstimate, maxOutputTokens, sessionId);

  /* ---- stream ----------------------------------------------------- */

  const controller = new AbortController();
  let replyText = '';
  let answerChars = 0;
  let reportedUsage = null;
  let truncated = false;
  let headersSent = false;
  let fatalError = null;

  // If the browser goes away mid-answer, stop paying for the rest of it.
  res.on('close', () => controller.abort());

  try {
    const stream = await openai().chat.completions.create(
      {
        model: chosenModel,
        messages,
        temperature: 0.3,
        max_completion_tokens: maxOutputTokens,
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal: controller.signal }
    );

    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // don't let a reverse proxy buffer the stream
    });
    res.flushHeaders();
    headersSent = true;

    for await (const chunk of stream) {
      if (chunk.usage) reportedUsage = chunk.usage;

      const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
      const text = delta && delta.content;
      if (!text) continue;

      answerChars += text.length;
      replyText += text;
      sse(res, 'token', { text });

      // Backstop for max_completion_tokens: if the model somehow overruns the
      // cap, cut the connection rather than keep billing.
      if (tokensFromChars(answerChars) > maxOutputTokens * 1.5) {
        truncated = true;
        controller.abort();
        break;
      }
    }
  } catch (err) {
    const aborted = controller.signal.aborted || err.name === 'AbortError';
    if (!aborted) {
      // Before headers go out this is still a normal JSON error response;
      // after them the only channel left is an SSE error event.
      if (!headersSent) fatalError = err;
      else {
        sse(res, 'error', {
          error: err.code === 'not_configured' ? 'not_configured' : 'upstream_error',
          message: 'The answer stopped early. Try again.',
        });
      }
    }
  } finally {
    // headersSent is only true once OpenAI has accepted the request and
    // started streaming. If it's false and nothing was reported, the call
    // never reached the model — release the whole reservation rather than
    // charging the user for a request that cost nothing.
    const startedUpstream = headersSent || reportedUsage !== null;
    let promptTokens = 0;
    let outputTokens = 0;
    if (reportedUsage) {
      promptTokens = reportedUsage.prompt_tokens;
      outputTokens = reportedUsage.completion_tokens;
    } else if (startedUpstream) {
      // Stream died before the usage chunk: prompt tokens were spent for sure.
      promptTokens = promptEstimate;
      outputTokens = tokensFromChars(answerChars);
    }
    await settleUsage(usageId, promptTokens, outputTokens);

    await saveAnswer({
      userId: req.user.id,
      question: question || `(${action})`,
      reply: replyText,
      mode,
      action,
      sessionId,
    });

    if (headersSent && !res.writableEnded) {
      const total = promptTokens + outputTokens;
      const cached =
        (reportedUsage &&
          reportedUsage.prompt_tokens_details &&
          reportedUsage.prompt_tokens_details.cached_tokens) || 0;
      sse(res, 'done', {
        truncated,
        usage: {
          prompt_tokens: promptTokens,
          output_tokens: outputTokens,
          cached_tokens: cached,
          model: chosenModel,
        },
        tokens_remaining: Math.max(0, req.user.token_quota - used - total),   // reported, not enforced
      });
      res.end();
    }
  }

  if (fatalError) return next(fatalError);
  return undefined;
});

module.exports = {
  router,
  buildMessages,
  classifyQuestion,
  modelFor,
  estimateTokens,
  answerLimiter,
};
