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
const { col, nowSql, isExpired, addMinutesFromNow, loadDocContent, loadAllUserDocs, tokensUsedThisMonth, reserveUsage, settleUsage } = require('./db');
const { requireAuth, requireAuthLive } = require('./auth');
const { openai } = require('./openai-client');
const { rateLimit } = require('./rateLimit');
const {
  SESSION_TYPES, ACTIONS, DEFAULT_TYPE, DEFAULT_ACTION, systemPromptFor, catalogue,
  groundingBlock, classifyQuestion, isCodingQuestion, explicitLengthRule,
} = require('./modes');
const { saveAnswer } = require('./history');
const credits = require('./credits');
const quota = require('./quota');

// Measured first-token latency: gpt-4.1-mini ~0.7-1.0s vs gpt-4o-mini ~1.1-3s.
const MODEL = process.env.ANSWER_MODEL || 'gpt-4.1-mini';

/**
 * Models a session may choose. Only models this backend can actually reach are
 * listed — an unknown value falls back to the default rather than failing the
 * answer. `recommended` drives the label in the picker.
 */
// Live answers (mic, chat, screenshot) must start within about a second, which
// only gpt-4.1-mini manages; gpt-4o took 1.5-3s to its first word plus several
// seconds to finish. So the live copilot offers and uses this one model only.
const AGENTS = [
  { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', recommended: true,
    hint: 'Fastest first word (~1s). Best for live interviews.' },
  { id: 'gpt-4o-mini', label: 'GPT-4o mini',
    hint: 'Low cost. First word in ~1-3s.' },
  { id: 'gpt-4o', label: 'GPT-4o',
    hint: 'Most capable, slowest to start (~2-4s).' },
];
const AGENT_IDS = new Set(AGENTS.map((a) => a.id));

// The agent picked for the session; anything unknown (or none) gets the
// fast default.
function modelFor(session) {
  const picked = String((session && session.agent) || '').trim();
  return AGENT_IDS.has(picked) ? picked : MODEL;
}
// One spoken answer plus the short [TYPE]/[POINTS] preamble. Sized with
// headroom above the default length rules in modes.js (now 9-14 spoken lines
// per answer) so a longer explicit request ("answer in 20 lines") or a
// [ANSWER] deepen still has room instead of hitting the truncation backstop.
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS || 4000);

// A call that can't afford at least this much output isn't worth starting.
const MIN_USEFUL_OUTPUT_TOKENS = 64;

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
// Headroom for continuous live question asking from candidate & interviewer
// throughout the active session time slot.
const answerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 180,
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

const userDocsCache = new Map();
const DOCS_FRESH_MS = 60 * 1000;
// Past DOCS_FRESH_MS the cached documents are still used while a background
// re-read picks up any change, so no answer waits on the document lookup.
const DOCS_STALE_MS = 30 * 60 * 1000;

function refreshUserDocs(userId) {
  return loadAllUserDocs(userId, ['resume', 'experience', 'job_description', 'company'], MAX_DOC_CHARS)
    .then((docs) => {
      userDocsCache.set(userId, { docs, timestamp: Date.now() });
      return docs;
    });
}

async function getCachedUserDocs(userId) {
  const cached = userDocsCache.get(userId);
  const age = cached ? Date.now() - cached.timestamp : Infinity;
  if (age < DOCS_FRESH_MS) return cached.docs;
  if (age < DOCS_STALE_MS) {
    if (!cached.refreshing) {
      cached.refreshing = true;
      refreshUserDocs(userId).catch(() => { cached.refreshing = false; });
    }
    return cached.docs;
  }
  return refreshUserDocs(userId);
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

  const questionType = classifyQuestion(question);
  const isCoding = questionType === 'CODING' || isCodingQuestion(question) || answerStyle === 'code';
  const isBehavioral = questionType === 'BEHAVIORAL';

  const cleanQ = String(question || '').trim();
  /* Small talk gets a short, natural reply. Without this it fell into the
   * "short question = fragment of the earlier topic" rule below and got a long
   * technical answer about whatever was discussed before. */
  const isSmallTalk = SMALL_TALK_QUESTION.test(cleanQ);
  if (isSmallTalk) {
    volatile.push(
      '## Small talk\nThis is a friendly, conversational question, not a technical one. Reply as the\n' +
      'candidate in one or two short, warm, natural sentences (for example, how you are doing\n' +
      'and that you are glad to be here). Ignore the length and depth rules for this reply,\n' +
      'and do not bring up technical topics.'
    );
  }
  const isShortOrFragment = !isSmallTalk && (cleanQ.split(/\s+/).length < 4 || /^(what|why|how|explain|clarify|elaborate|what\?|why\?)\b/i.test(cleanQ));
  if (isShortOrFragment && transcript) {
    volatile.push(
      '## Contextual Question Resolution\n' +
      'Notice: The question text above is brief, a follow-up, or a conversational fragment. ' +
      'Examine the ## Recent conversation transcript above to identify the specific technical topic, statement, or problem being discussed. ' +
      'Deliver a comprehensive, directly relevant technical answer on THAT subject, providing full information and depth. Do not give a generic or disconnected answer.'
    );
  }
  }

  let styleInstruction = '';
  if (isCoding && answerStyle !== 'teleprompter' && answerStyle !== 'quiz') {
    styleInstruction = '\n## Format: Clean Code Solution & Spoken Walkthrough (Under 10% AI, 90% Human Thinking, Owner Voice)\n' +
      '1. Working Code: Provide complete, clean, runnable code inside a standard markdown code block (```<language>\\n...code...\\n```).\n' +
      '2. Owner Walkthrough: Provide 8 to 12 substantive spoken sentences as the owner explaining the algorithmic approach, intuition, step-by-step logic, Big-O Time & Space complexity, and edge case handling with natural conversational flow.\n' +
      '3. TONE & DEPTH: Under 10% AI, 90% human thinking. Answer like the senior owner with deep technical substance, varied natural phrasing, and zero robotic filler.';
  } else if (answerStyle === 'star' && isBehavioral) {
    styleInstruction = '\n## Format: Spoken STAR Method (Under 10% AI, 90% Human Thinking, Owner Voice)\n' +
      'Deliver an authentic, detailed STAR response in 8 to 12 spoken sentences detailing the high-stakes Situation and Task, the technical and architectural Action taken, and the measurable Result with real metrics, trade-offs, and lessons learned. Speak naturally as the owner with varied phrasing and zero robotic AI fluff.';
  } else if (answerStyle === 'code') {
    styleInstruction = '\n## Format: Clean Code Solution & Spoken Walkthrough (Under 10% AI, 90% Human Thinking, Owner Voice)\n' +
      'Provide clean, production-ready code in a markdown block (```<language>\\n...code...\\n```), followed by 8 to 12 substantive spoken sentences explaining the algorithmic approach, Big-O Time/Space complexity, trade-offs, and production edge cases with natural conversational authority.';
  } else if (answerStyle === 'teleprompter') {
    styleInstruction = '\n## Format: Spoken Teleprompter Hints (Under 10% AI, 90% Human Thinking, Owner Voice)\n' +
      'Provide 4-6 substantive speaking beats under [POINTS] and 8 to 12 rich spoken sentences under [ANSWER] packed with technical depth, architecture, and practical lessons in an authentic owner voice.';
  } else if (answerStyle === 'quiz') {
    styleInstruction = '\n## Format: Multiple Choice Answer (Under 10% AI, 90% Human Thinking)\n' +
      'State the correct Option/Letter first in bold, followed by a thorough 4 to 6 sentence technical explanation explaining why it is correct, why the alternative options fail, and practical production considerations.';
  } else {
    styleInstruction = '\n## Format: Spoken Interview Answer (Under 10% AI, 90% Human Thinking, Owner Voice)\n' +
      'Deliver 4 to 6 substantive key speaking beats under [POINTS], and 8 to 14+ authentic, rich spoken sentences under [ANSWER] covering the direct answer, under-the-hood technical mechanics, hands-on architectural experience, and key trade-offs. Speak naturally as the system owner with 90% human thinking, diverse sentence structures, deep technical information, and zero robotic filler.';
  }

  // Whatever the style, the card is laid out the same way.
  const LAYOUT_RULE = '\n## Layout of [ANSWER]\n' +
    'One direct opening sentence with only its key phrase in **bold**, then (after any code block) ' +
    '4 to 6 bullet lines starting with "- ", each with its own key term in **bold**. ' +
    'Put depth inside the bullets; never more than 6 bullets; nothing after the last bullet.';
  styleInstruction += LAYOUT_RULE;

  if (images && images.length) {
    /* The image decides the shape of the answer. A fixed format (the default
     * prompt mentions "problem", which selected the coding format demanding
     * runnable code) made the model invent a problem for an image without one. */
    styleInstruction = '\n## Format for this image\n' +
      'Answer what is actually in the image: for a coding problem give complete, runnable code in a ' +
      'markdown block and a short spoken walkthrough with complexity; for a conceptual, behavioral or ' +
      'multiple-choice question answer it directly (state the correct option first for multiple choice); ' +
      'for an error or stack trace explain the cause and the fix. Never invent a question that is not ' +
      'visible. If there is nothing to answer, say so in one short sentence.' + LAYOUT_RULE;
  }

  if (isSmallTalk && action === 'answer') {
    // Replaces the "8 to 14+ sentences" instruction, which otherwise wins over
    // the small-talk note above and produced 100+ word replies to "How are you?".
    volatile.push(
      `## The question you must answer\n${question}\n\n` +
      '## Reply rules\nThis is small talk. Under [ANSWER], reply in at most two short, natural\n' +
      'sentences (under 30 words total), warm and human, as the candidate. Under [POINTS],\n' +
      'give one short point. Start with the [ANSWER] tag on its own line.'
    );
  } else {
    volatile.push((ACTIONS[action] || ACTIONS[DEFAULT_ACTION]).instruction(question) + styleInstruction);
  }

  let userVolatileContent;
  if (images && images.length) {
    /* A screenshot arrives with little or no typed question, so classifyQuestion()
     * on the (often empty) question text falls through to OPEN_ENDED and the model
     * gets none of the screen-reading guidance the (unused) /api/vision route
     * already has. Prepending it here gives screenshot answers through this
     * endpoint the same quality without a second request path. */
    const visionGuidance =
      'These images are screenshots of a technical task or problem statement. First work out ' +
      'what kind of content this is — a coding problem, SQL, system design, a ' +
      'debugging/stack-trace, a behavioral or multiple-choice question, or a ' +
      'diagram/slide — and answer in the shape that kind of question needs. Read ' +
      'the WHOLE problem on screen before answering, including examples, ' +
      'constraints, and any starter code. If code is already on screen, analyse ' +
      'THAT code rather than substituting a different problem. Use the language ' +
      'shown on screen, or Python if none is specified. When several screenshots ' +
      'are supplied, treat them as one continuous task captured in order. ' +
      'Answer the question or problem that is in the image directly — do not describe ' +
      'the screen. FIRST CHECK: only answer a question, problem or code you can actually ' +
      'read in the image, word for word. Never invent or assume one. If you cannot read ' +
      'one (for example a blank or plain image, a desktop, wallpaper or a paused call), ' +
      'reply under [ANSWER] with exactly: "I don\'t see a question in this screenshot — ' +
      'capture the screen where the question is shown." and stop.';
    const promptText = volatile.length
      ? `${visionGuidance}\n\n${volatile.join('\n\n')}`
      : `${visionGuidance}\n\n${images.length > 1
          ? `Analyze the question across these ${images.length} screenshots and provide the optimal solution/answer.`
          : 'Analyze the question in this screenshot and provide the optimal solution/answer.'}`;
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

const SMALL_TALK_QUESTION = /^(hi|hello|hey|good (morning|afternoon|evening))?[\s,!.]*(how are you( doing)?|how'?s it going|how is it going|how have you been|how'?s (your|the) day|how is (your|the) day( going)?|what'?s up|wh?at up|can you hear me( now)?|can you see my screen|am i audible|are you there|is my (voice|audio|mic) (clear|okay|ok|fine)|are you ready|shall we (start|begin)|ready to (start|begin))\b/i;

function sse(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  if (typeof res.flush === 'function') res.flush();
}

// Lets the client render the persona and action lists without hardcoding them.
router.get('/catalogue', requireAuth, (req, res) => res.json({ ...catalogue(), agents: AGENTS }));

/* POST /api/answer/warm — sent once when the copilot opens.
 *
 * The first question of a session used to be the slow one: the user, session
 * and documents all came from Atlas cold, the HTTPS connection to OpenAI was
 * not open yet, and OpenAI had no cached copy of the long, unchanging prompt
 * prefix (rules + resume). This does all of that before anyone asks anything:
 * the lookups fill the live caches, and a 1-token completion with the same
 * prefix opens the connection and seeds OpenAI's prompt cache. */
const warmedAt = new Map();
const WARM_EVERY_MS = 4 * 60 * 1000;

router.post('/warm', requireAuthLive, async (req, res) => {
  const { getSessionLive: getSession } = require('./sessions');
  const sessionId = req.body && req.body.session_id;
  let session = null;
  let docs = {};
  try {
    [session, docs] = await Promise.all([
      sessionId ? getSession(req.user.id, sessionId) : Promise.resolve(null),
      getCachedUserDocs(req.user.id),
    ]);
  } catch (err) {
    console.warn(`[ANSWER WARM] lookup failed: ${err.message}`);
  }
  res.status(204).end();

  const key = `${req.user.id}:${sessionId || '-'}`;
  if (Date.now() - (warmedAt.get(key) || 0) < WARM_EVERY_MS) return;
  warmedAt.set(key, Date.now());
  if (warmedAt.size > 500) warmedAt.clear();

  const messages = buildMessages({
    question: 'Tell me about yourself.',
    transcript: '',
    resume: docs.resume || '',
    experience: docs.experience || '',
    jobDescription: docs.job_description || '',
    company: docs.company || '',
    sessionJobDescription: session && session.job_description,
    sessionCompany: session && session.company,
    sessionRole: session && session.role,
    sessionContext: session && session.context,
    images: [],
    mode: session && SESSION_TYPES[session.mode] ? session.mode : DEFAULT_TYPE,
    action: DEFAULT_ACTION,
    language: (session && session.language) || 'English',
  });
  const started = Date.now();
  try {
    await openai().chat.completions.create({
      model: modelFor(session),
      messages,
      max_completion_tokens: 1,
    });
    console.log(`[ANSWER WARM] user=${req.user.id} session=${sessionId || '-'} ready in ${Date.now() - started}ms`);
  } catch (err) {
    console.warn(`[ANSWER WARM] model call failed: ${err.message}`);
  }
});

router.post('/', requireAuthLive, answerLimiter, async (req, res, next) => {
  const question = String((req.body && req.body.question) || '').trim();
  const rawImages = (req.body && req.body.images) || (req.body && req.body.image ? [req.body.image] : []);
  const images = Array.isArray(rawImages) ? rawImages.filter(Boolean).slice(0, MAX_IMAGES) : [];
  const answerStyle = req.body && req.body.answerStyle;
  const action = ACTIONS[req.body && req.body.action] ? req.body.action : DEFAULT_ACTION;

  // Parallel pre-flight fetch: session, candidate documents, and quota all in one round-trip
  const { getSessionLive: getSession } = require('./sessions');
  const requestedSessionId = req.body && req.body.session_id;

  // The month's token total only gates anything when the quota is enforced
  // (off by default); otherwise it is just reported at the end, so the answer
  // does not wait for it.
  const usedPromise = tokensUsedThisMonth(req.user.id).catch(() => 0);
  const [session, docs] = await Promise.all([
    requestedSessionId ? getSession(req.user.id, requestedSessionId) : Promise.resolve(null),
    getCachedUserDocs(req.user.id),
  ]);
  const used = quota.ENFORCED ? await usedPromise : 0;
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
  if (session && process.env.NODE_ENV !== 'development') {
    const isUnlimitedUser = await credits.isUnlimited(req.user.id);
    if (!isUnlimitedUser && (session.status === 'ended' || (session.expires_at && isExpired(session.expires_at)))) {
      if (session.status !== 'ended') {
        await col('call_sessions').updateOne(
          { id: session.id },
          { $set: { status: 'ended', ended_at: session.ended_at || nowSql() } }
        );
        const fresh = await col('call_sessions').findOne({ id: session.id });
        await credits.settleSession(fresh);
      }
      return res.status(410).json({ error: 'session_ended', message: 'This session has ended or expired. Please start a new session.' });
    }
  }
    }
  }

  // Recap and follow-ups work off the transcript alone — there is no question
  // to answer, and demanding one would make the buttons unusable mid-call.
  const needsQuestion = action === 'answer' || action === 'shorten' || action === 'deepen';
  if (needsQuestion && !question) {
    return res.status(400).json({ error: 'missing_question', message: 'question is required.' });
  }
  // No length cap on the question itself — the only remaining ceiling is the
  // global express.json({limit:'4mb'}) body-size guard in server.js, which
  // exists to bound raw request-body memory use, not to police how long a
  // question is allowed to be.

  // Keep the tail and sanitize out any past AI refusal phrases
  let rawTranscript = String((req.body && req.body.transcript) || '').slice(-MAX_TRANSCRIPT_CHARS);
  rawTranscript = rawTranscript
    .replace(/I'm sorry, but I can't (assist with that|provide the full code)[^\n]*/gi, '')
    .replace(/I cannot provide the full code[^\n]*/gi, '')
    .replace(/as an ai.*?(cannot|unable)[^\n]*/gi, '');
  const transcript = rawTranscript;

  const messages = buildMessages({
    question,
    transcript,
    resume: docs.resume || '',
    experience: docs.experience || '',
    jobDescription: docs.job_description || '',
    company: docs.company || '',
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

  const TOKENS_PER_IMAGE_ESTIMATE = 1100;
  const textContent = messages
    .map((m) => (typeof m.content === 'string' ? m.content : (m.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n')))
    .join('\n');
  const promptEstimate = estimateTokens(textContent) + images.length * TOKENS_PER_IMAGE_ESTIMATE;
  const gate = quota.check(req.user, used, promptEstimate + MIN_USEFUL_OUTPUT_TOKENS);

  if (gate.blocked) {
    return res.status(429).json({
      error: 'quota_exhausted',
      message: 'Monthly token safety limit reached. Ask the owner to raise it.',
      token_quota: req.user.token_quota,
      tokens_used_this_month: used,
    });
  }

  /* Fast response token budget: sized to the format actually requested, so
   * the answer isn't cut off before it satisfies its own instructions. The
   * old flat 150/280 split cut off STAR (needs ~250-300) and any screenshot
   * (needs room for a full code+explanation+complexity answer) well before
   * the model could finish what the prompt told it to write. */
  const questionType = classifyQuestion(question);
  const isCoding = questionType === 'CODING' || isCodingQuestion(question) || answerStyle === 'code';
  const isBehavioral = questionType === 'BEHAVIORAL' && answerStyle === 'star';
  const hasImages = images.length > 0;
  const hasExplicitLength = Boolean(session && session.context && explicitLengthRule(session.context));

  // Token budget: allow full output capacity so answers can meet the 50+ lines requirement
  const maxOutputTokens = quota.outputBudget(MAX_OUTPUT_TOKENS, gate.remaining, promptEstimate);

  // Charged now, corrected in the finally block below.
  // Immediate SSE header transmission & socket noDelay to eliminate upstream proxy latency
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // don't let a reverse proxy buffer the stream
  });
  if (res.socket) res.socket.setNoDelay(true);
  res.flushHeaders();
  let headersSent = true;

  // Immediate event to prime downstream reader with zero lag
  res.write(': stream-start\n\n');
  if (typeof res.flush === 'function') res.flush();

  const chosenModel = modelFor(session);
  const usagePromise = reserveUsage(req.user.id, chosenModel, promptEstimate, maxOutputTokens, sessionId);

  const controller = new AbortController();
  let replyText = '';
  let answerChars = 0;
  let reportedUsage = null;
  let truncated = false;
  let fatalError = null;
  let usageId = null;

  // If the browser goes away mid-answer, stop paying for the rest of it.
  res.on('close', () => controller.abort());

  const customKey = req.get('x-openai-api-key') || (req.body && req.body.apiKey) || (req.headers['authorization']?.startsWith('Bearer ') && req.headers['authorization'].slice(7).startsWith('sk-') ? req.headers['authorization'].slice(7) : null);

  try {
    // One silent retry for a transient upstream failure, but only while nothing
    // has been streamed yet — after that a retry would duplicate visible text.
    for (let attempt = 1; ; attempt++) {
      try {
        const stream = await openai(customKey).chat.completions.create(
          {
            model: chosenModel,
            messages,
            temperature: 0.1,
            max_completion_tokens: maxOutputTokens,
            stream: true,
            stream_options: { include_usage: true },
          },
          { signal: controller.signal }
        );

        for await (const chunk of stream) {
          if (chunk.usage) reportedUsage = chunk.usage;

          const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
          const text = delta && delta.content;
          if (!text) continue;

          answerChars += text.length;
          const prevLen = replyText.length;
          replyText += text;

          // The copilot shows only the spoken answer, which comes first. Once
          // the model moves on to [POINTS], end the answer: those 1-2 seconds
          // of extra output were never shown and kept a streaming slot busy.
          const ansIdx = replyText.indexOf('[ANSWER]');
          const pointsAt = ansIdx >= 0 ? replyText.slice(ansIdx).search(/\n\s*\[POI/) : -1;
          if (pointsAt >= 0) {
            const cut = ansIdx + pointsAt;
            const keep = replyText.slice(prevLen, Math.max(prevLen, cut));
            replyText = replyText.slice(0, cut);
            if (keep) sse(res, 'token', { text: keep });
            controller.abort();
            break;
          }

          sse(res, 'token', { text });

          // Backstop for max_completion_tokens: if the model somehow overruns the
          // cap, cut the connection rather than keep billing.
          if (tokensFromChars(answerChars) > maxOutputTokens * 1.5) {
            truncated = true;
            controller.abort();
            break;
          }
        }
        break;
      } catch (err) {
        const aborted = controller.signal.aborted || err.name === 'AbortError';
        const retryable = !aborted && answerChars === 0 && attempt < 2
          && (!err.status || err.status === 429 || err.status >= 500);
        if (!retryable) throw err;
        console.warn(`[ANSWER RETRY] model=${chosenModel} status=${err.status || '-'}: ${err.message}`);
      }
    }
  } catch (err) {
    const aborted = controller.signal.aborted || err.name === 'AbortError';
    if (!aborted) {
      console.warn(`[ANSWER ERROR] model=${chosenModel} status=${err.status || '-'} code=${err.code || '-'} after ${answerChars} chars: ${err.message}`);
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
    usageId = await usagePromise;
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
        tokens_remaining: Math.max(0, req.user.token_quota - (await usedPromise) - total),   // reported, not enforced
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
  isCodingQuestion,
  modelFor,
  estimateTokens,
  answerLimiter,
};
