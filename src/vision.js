// POST /api/vision — a screenshot in, an answer out.
//
// The user presses one key; everything else is inferred. No prompt is typed,
// so the model has to work out for itself what it is looking at — a LeetCode
// problem, a SQL exercise, a system-design prompt, a stack trace, a diagram, a
// multiple-choice question — and answer in the shape that kind of question
// deserves.
//
// Capture happens in the browser: a frame is grabbed from the same
// getDisplayMedia stream the meeting audio uses and posted here as a JPEG. That
// deliberately avoids native screen capture, which on macOS means
// ScreenCaptureKit and a full Xcode toolchain.

const express = require('express');
const { col, nowSql, isExpired, loadDocContent, tokensUsedThisMonth, reserveUsage, settleUsage } = require('./db');
const { requireAuth } = require('./auth');
const { openai } = require('./openai-client');
const quota = require('./quota');
const { getSession } = require('./sessions');
const credits = require('./credits');

const MAX_DOC_CHARS = 12000;
function loadDoc(userId, kind) {
  return loadDocContent(userId, kind, MAX_DOC_CHARS);
}
const { saveAnswer } = require('./history');

// NOT the mini model, and not a stylistic choice. gpt-4o-mini bills image
// tokens at roughly 33x gpt-4o: the same 900x620 screenshot costs 25,520 prompt
// tokens on mini versus 784 on gpt-4o, measured. Since the quota is denominated
// in tokens, mini would give ~195 screenshots per 5M where gpt-4o gives ~6,300,
// and it is cheaper in dollars too.
const MODEL = process.env.VISION_MODEL || 'gpt-4o';
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;   // several screenshots in one request
const MAX_SCREENSHOTS = 5;
// Code answers need materially more room than a spoken reply: a full solution
// plus complexity and edge cases does not fit in 900.
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_VISION_OUTPUT_TOKENS || 1600);

// A screenshot is worth far more prompt tokens than a sentence of speech, and
// the real figure only arrives with the response. Reserve enough to cover a
// full-resolution frame, then settle down to what it actually cost.
const RESERVE_TOKENS = Number(process.env.VISION_RESERVE_TOKENS || 1800);

const router = express.Router();

const SYSTEM_PROMPT = [
  'You are looking at a screenshot taken during a live interview. The candidate',
  'pressed one key and typed nothing — work out what is on screen and answer it.',
  '',
  'First decide what kind of content this is, then answer in the shape it needs:',
  '',
  '- Coding problem: give the approach, then working code, then time and space',
  '  complexity. Name the edge cases that break a naive solution.',
  '- SQL: give the query, then one line on why it is shaped that way.',
  '- System design: lead with the architecture in five or six beats, then the',
  '  bottleneck and the trade-off you are making.',
  '- Debugging or a stack trace: name the probable cause first, then the fix.',
  '- Behavioural question: answer in the first person from the resume provided.',
  '- Multiple choice: state the answer, then one line of justification.',
  '- Diagram, slide, spreadsheet or document: say what it shows and answer any',
  '  question visible on it.',
  '',
  'Rules for anything technical:',
  '- Read the WHOLE problem off the screen before answering, including examples,',
  '  constraints and any starter code. Solve the problem that is actually shown.',
  '- If code is already on screen, analyse THAT code. Do not substitute a',
  '  different problem or rewrite it from scratch unless asked to.',
  '- If it is broken, name the specific defect and give the corrected code.',
  '- If asked what the code on screen returns or prints, trace the ORIGINAL code',
  '  exactly as written — before any fix you propose — and state that literal',
  '  output. Then, separately, state what the corrected version returns. Do not',
  '  answer the question about the buggy code with the fixed code\'s behaviour.',
  '- Use the language the screen specifies. If none is specified, use Python.',
  '- Always give complete, runnable code — never a sketch or an ellipsis.',
  '',
  'When several screenshots are supplied they are ONE task, captured in order —',
  'page 1, page 2, and so on. Read them as a single continuous problem: the',
  'constraints or examples may only appear on the later ones. Never answer the',
  'last screenshot alone, and never treat a continuation as a new question.',
  '',
  'If a question is visible on screen, answer THAT question rather than',
  'describing the page. If nothing on screen is a question, summarise what is',
  'shown and say what you would ask about it.',
  '',
  'Reply in exactly this format, tags on their own lines:',
  '',
  '[TYPE] coding | sql | system_design | debugging | behavioral | mcq | other',
  '[POINTS]',
  '- three to six fragments, the beats to say out loud',
  '[ANSWER]',
  'The full answer. Include code in a fenced block when the content calls for it.',
].join('\n');

router.post(
  '/',
  requireAuth,
  express.raw({ type: () => true, limit: MAX_IMAGE_BYTES }),
  async (req, res, next) => {
    const contentType = req.get('Content-Type') || 'image/jpeg';

    // express.json() is mounted globally, so a JSON body arrives already parsed
    // as an object and never reaches express.raw as a Buffer. Accept either.
    const jsonBody = /^application\/json/.test(contentType)
      ? (Buffer.isBuffer(req.body)
          ? (() => { try { return JSON.parse(req.body.toString('utf8')); } catch { return null; } })()
          : req.body)
      : null;

    if (!jsonBody && (!Buffer.isBuffer(req.body) || req.body.length === 0)) {
      return res.status(400).json({ error: 'empty_image', message: 'No screenshot received.' });
    }

    /* One question can span several screenshots — a coding problem continued on
     * a second page, for instance. JSON carries the ordered set; a raw image
     * body is still accepted so a single capture works unchanged. */
    let images = [];
    if (jsonBody) {
      const parsed = jsonBody;
      const list = Array.isArray(parsed.images) ? parsed.images : [];

      /* Screenshots are scoped to one question. If the request declares a
       * question_id, every image must carry the same one — a client bug that
       * mixed two questions' screenshots would otherwise produce a merged
       * answer, which is exactly the failure this guards against. */
      const questionId = parsed.question_id;
      if (questionId !== undefined && questionId !== null) {
        const stray = list.filter(
          (img) => img.question_id !== undefined && String(img.question_id) !== String(questionId)
        );
        if (stray.length) {
          return res.status(400).json({
            error: 'question_mismatch',
            message: 'Screenshots do not all belong to the current question.',
          });
        }
      }

      images = list
        .slice(0, MAX_SCREENSHOTS)
        .map((img, i) => ({
          seq: Number(img.seq) || i + 1,
          mime: /^image\/(jpeg|png|webp)$/.test(img.mime || '') ? img.mime : 'image/png',
          data: String(img.data || ''),
        }))
        .filter((img) => img.data)
        .sort((a, b) => a.seq - b.seq);

      if (!images.length) {
        return res.status(400).json({ error: 'empty_image', message: 'No screenshot received.' });
      }
      req.visionQuestion = String(parsed.question || '');
      req.visionContext = String(parsed.context || '');
    } else {
      if (!/^image\/(jpeg|png|webp)$/.test(contentType)) {
        return res.status(415).json({
          error: 'unsupported_image',
          message: `Unsupported image type ${contentType}.`,
        });
      }
      images = [{ seq: 1, mime: contentType, data: req.body.toString('base64') }];
    }

    const session = await getSession(req.user.id, req.get('X-Session-Id'));
    const sessionId = session ? session.id : null;

    if (session) {
      if (session.status === 'ended') {
        return res.status(409).json({ error: 'session_ended', message: 'This session has ended.' });
      }
      if (session.expires_at && isExpired(session.expires_at)) {
        await col('call_sessions').updateOne(
          { id: session.id },
          { $set: { status: 'ended', ended_at: session.ended_at || nowSql() } }
        );
        const fresh = await getSession(req.user.id, session.id);
        await credits.settleSession(fresh);
        return res.status(409).json({ error: 'session_expired', message: 'Session time has run out.' });
      }
    }

    const used = await tokensUsedThisMonth(req.user.id);
    const gate = quota.check(req.user, used, RESERVE_TOKENS);
    if (gate.blocked) {
      return res.status(429).json({
        error: 'quota_exhausted',
        message: 'Monthly token safety limit reached.',
        tokens_remaining: gate.remaining,
      });
    }

    const budget = quota.outputBudget(MAX_OUTPUT_TOKENS, gate.remaining, RESERVE_TOKENS);
    const usageId = await reserveUsage(req.user.id, MODEL, RESERVE_TOKENS, budget, sessionId);

    let promptTokens = RESERVE_TOKENS;
    let outputTokens = 0;
    let reply = '';

    try {
      const context = (req.visionContext !== undefined
        ? req.visionContext
        : String(req.get('X-Context') || '')).slice(0, 2000);
      const question = (req.visionQuestion !== undefined
        ? req.visionQuestion
        : decodeURIComponent(String(req.get('X-Question') || ''))).slice(0, 2000);

      // The screenshot is extra evidence, not a replacement for who the
      // candidate is. Same materials the spoken-answer path uses.
      const brief = [];
      if (session && (session.company || session.role)) {
        brief.push(`## This interview\n${[
          session.company && `Company: ${session.company}`,
          session.role && `Role: ${session.role}`,
        ].filter(Boolean).join('\n')}`);
      }
      const resume = await loadDoc(req.user.id, 'resume');
      if (resume) brief.push(`## Candidate resume\n${resume}`);
      const jd = (session && session.job_description) || await loadDoc(req.user.id, 'job_description');
      if (jd) brief.push(`## Target job description\n${jd}`);
      if (session && session.context) {
        brief.push(
          '## Instructions from the candidate\n' +
          'Apply these to the prose around the answer. They must NEVER cause you ' +
          'to shorten, summarise or omit code, a query, or a required technical ' +
          'result — a line-count instruction applies to the explanation only.\n\n' +
          session.context
        );
      }
      if (question) brief.push(`## The question being asked\n${question}`);

      const result = await openai().chat.completions.create({
        model: MODEL,
        max_completion_tokens: budget,
        temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: [
                  ...brief,
                  context
                    ? `## Recent conversation\n${context}`
                    : '## Recent conversation\n(none captured)',
                ].join('\n\n'),
              },
              // Each screenshot is labelled with its position so the model reads
              // them as one continued task rather than separate questions.
              ...images.flatMap((img, i) => ([
                {
                  type: 'text',
                  text: images.length > 1
                    ? `--- Screenshot ${i + 1} of ${images.length} ---`
                    : '--- Screenshot ---',
                },
                // detail:high — a coding problem is unreadable at low detail, and
                // an unreadable screenshot is worse than no screenshot.
                {
                  type: 'image_url',
                  image_url: { url: `data:${img.mime};base64,${img.data}`, detail: 'high' },
                },
              ])),
            ],
          },
        ],
      });

      reply = (result.choices[0] && result.choices[0].message.content) || '';
      if (result.usage) {
        promptTokens = result.usage.prompt_tokens;
        outputTokens = result.usage.completion_tokens;
      } else {
        outputTokens = Math.ceil(reply.length / 4);
      }

      await saveAnswer({
        userId: req.user.id,
        question: '(screenshot)',
        reply,
        mode: session ? session.mode : 'interview',
        action: 'screenshot',
        sessionId,
      });

      return res.json({
        reply,
        usage: { prompt_tokens: promptTokens, output_tokens: outputTokens, model: MODEL },
      });
    } catch (err) {
      // Nothing usable came back, so don't hold the reservation against them.
      promptTokens = 0;
      outputTokens = 0;
      return next(err);
    } finally {
      await settleUsage(usageId, promptTokens, outputTokens);
    }
  }
);

module.exports = router;
