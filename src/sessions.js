const express = require('express');
const { col, nextId, nowSql, isExpired, addMinutesFromNow, minutesBetween, publicDoc, sessionTokensUsed, loadDocContent, tokensUsedThisMonth, reserveUsage, settleUsage } = require('./db');
const { requireAuth, requireAuthLive } = require('./auth');
const credits = require('./credits');
const { transcribeAudio, transcribeLimiter, MODEL: TRANSCRIBE_MODEL, RESERVE_TOKENS: TRANSCRIBE_RESERVE_TOKENS } = require('./transcribe');
const { buildMessages, classifyQuestion, modelFor, answerLimiter } = require('./answer');
const { saveAnswer } = require('./history');
const { openai } = require('./openai-client');
const quota = require('./quota');
const multer = require('multer');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const router = express.Router();

async function enrichSession(session) {
  if (!session) return null;
  const s = publicDoc(session);
  if (s.expires_at || s.started_at) {
    const isUnlimited = s.billing_kind === 'unlimited';
    const expiredByExpiresAt = s.expires_at && isExpired(s.expires_at);
    const limitMin = isUnlimited ? (credits.UNLIMITED_MINUTES || 1440) : ((s.billing_kind === 'trial' || s.plan === 'free') ? (credits.TRIAL_MINUTES || 10) : (s.max_minutes || 60));
    const expiredByStartedAt = !s.expires_at && s.started_at && minutesBetween(s.started_at, nowSql()) >= limitMin;
    if ((expiredByExpiresAt || expiredByStartedAt) && s.status !== 'ended') {
      s.status = 'ended';
      s.ended_at = s.ended_at || s.expires_at || nowSql();
      await col('call_sessions').updateOne(
        { id: s.id },
        { $set: { status: 'ended', ended_at: s.ended_at } }
      );
      await credits.settleSession(s);
    }
  }
  const numId = Number(s.id);
  const sessionQuery = Number.isFinite(numId) ? { $in: [numId, String(s.id)] } : s.id;
  const [tokens_used, answer_count, line_count] = await Promise.all([
    sessionTokensUsed(s.id),
    col('answers').countDocuments({ session_id: sessionQuery }),
    col('transcript_lines').countDocuments({ session_id: sessionQuery }),
  ]);
  return { ...s, tokens_used, answer_count, line_count };
}

async function ownedSession(userId, id) {
  if (!id) return null;
  const numId = Number(id);
  const numUser = Number(userId);
  const idQuery = Number.isFinite(numId) ? { $in: [numId, String(id)] } : String(id);
  const userQuery = Number.isFinite(numUser) ? { $in: [numUser, String(userId)] } : userId;
  return publicDoc(await col('call_sessions').findOne({ id: idQuery, user_id: userQuery }));
}

function looksLikeQuestion(text) {
  const t = String(text || '').trim();
  if (!t || t.length < 5) return false;

  // Filter out single-word or 2-word filler fragments like "What?", "Why?", "Okay?", "Right?"
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 3 && !/\b(explain|describe|write|code|solve|implement|clarify)\b/i.test(t)) {
    return false;
  }

  if (t.endsWith('?') || t.includes('?')) return true;

  const QUESTION_STARTERS = /^(what|why|how|when|where|who|whom|whose|which|can|could|would|will|shall|should|do|does|did|is|are|was|were|have|has|had|tell me|walk me through|explain|describe|elaborate on|give me|give an example|talk about|compare|discuss|solve|write|implement|find|calculate|clarify|define)\b/i;
  if (QUESTION_STARTERS.test(t)) return true;

  const INNER_QUESTION_PATTERNS = /\b(what is|what are|what would|what does|how do|how does|how would|how can|how to|why do|why does|why is|why are|can you|could you|would you|have you|do you know|do you have|difference between|explain how|tell me about|walk me through|in your opinion|in your experience)\b/i;
  return INNER_QUESTION_PATTERNS.test(t);
}

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const status = String(req.query.status || 'all');
    const filter = { user_id: req.user.id };
    const rows = await col('call_sessions').find(filter).sort({ id: -1 }).toArray();
    let enriched = await Promise.all(rows.map(enrichSession));
    if (status !== 'all') {
      enriched = enriched.filter(s => s.status === status);
    }
    res.json({ sessions: enriched });
  } catch (err) {
    next(err);
  }
});

router.get('/account', requireAuth, async (req, res, next) => {
  try {
    const recent = await col('call_sessions')
      .find({ user_id: req.user.id, started_at: { $ne: null } })
      .sort({ id: -1 })
      .limit(20)
      .toArray();
    const recent_usage = [];
    for (const s of recent) {
      const consume = await col('credit_transactions').findOne({ session_id: s.id, type: 'CONSUME' });
      recent_usage.push({
        id: s.id,
        company: s.company,
        role: s.role,
        billing_kind: s.billing_kind,
        status: s.status,
        started_at: s.started_at,
        ended_at: s.ended_at,
        settled_at: s.settled_at,
        credits_charged: consume ? consume.amount : null,
        usage_minutes: consume ? consume.usage_minutes : null,
      });
    }
    res.json({
      account: await credits.accountSummary(req.user.id),
      recent_usage,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const b = req.body || {};
    const mode = b.mode === 'call' ? 'call' : 'interview';
    const company = String(b.company || '').trim();
    const role = String(b.role || '').trim();
    const jobDescription = String(b.job_description || '').trim().slice(0, 20000);
    const language = String(b.language || 'English').slice(0, 40);
    const autoAnswer = b.auto_answer === false ? 0 : 1;
    const context = String(b.context || '').trim().slice(0, 20000);
    const agent = String(b.agent || '').trim().slice(0, 60);
    const billing = String(b.billing) === 'paid' ? 'paid' : 'trial';
    const saveTranscript = b.save_transcript === false ? 0 : 1;

    if (!company) {
      return res.status(400).json({
        error: 'missing_company',
        message: mode === 'call' ? 'Give the call a title.' : 'Company is required.',
      });
    }

    // Deduplication check:
    // If the same user created an identical session within the last 15 seconds that is
    // still in 'ready' status (e.g. from accidental double-clicks or client retries),
    // return the existing session rather than creating duplicate sessions and deducting credits.
    const recentThreshold = new Date(Date.now() - 15000).toISOString().replace('T', ' ').slice(0, 19);
    const existingRecent = await col('call_sessions').findOne({
      user_id: req.user.id,
      company,
      role,
      mode,
      status: 'ready',
      created_at: { $gte: recentThreshold },
    });
    if (existingRecent) {
      return res.status(200).json({
        session: await enrichSession(existingRecent),
        account: await credits.accountSummary(req.user.id),
      });
    }

    const id = await nextId('call_sessions');

    // Verify user has any allowance (trials, paid credits, or unlimited) before creating
    const [trialRem, paidBal, unlimited] = await Promise.all([
      credits.trialsRemaining(req.user.id),
      credits.creditBalance(req.user.id),
      credits.isUnlimited(req.user.id),
    ]);
    if (!unlimited && trialRem <= 0 && paidBal < 0.5) {
      return res.status(409).json({
        error: 'no_trials_left',
        message: 'All 5 free trials have been used and you have no paid credits. Please purchase credits to continue.',
      });
    }

    const defaultBilling = billing === 'paid'
      ? (paidBal >= 0.5 || unlimited ? 'paid' : 'trial')
      : (trialRem > 0 || unlimited ? 'trial' : 'paid');

    const session = {
      id,
      user_id: req.user.id,
      company,
      role,
      mode,
      status: 'ready',
      started_at: null,
      ended_at: null,
      created_at: nowSql(),
      job_description: jobDescription,
      language,
      auto_answer: autoAnswer,
      save_transcript: saveTranscript,
      context,
      agent,
      plan: defaultBilling === 'trial' ? 'free' : 'full',
      expires_at: null,
      billing_kind: defaultBilling,
      settled_at: null,
      notes: null,
    };
    await col('call_sessions').insertOne(session);
    return res.status(201).json({ session: await enrichSession(session), account: await credits.accountSummary(req.user.id) });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const owned = await ownedSession(req.user.id, req.params.id);
    if (!owned) return res.status(404).json({ error: 'not_found' });
    const numId = Number(owned.id);
    const sessionQuery = Number.isFinite(numId) ? { $in: [numId, String(owned.id)] } : owned.id;
    const lines = await col('transcript_lines')
      .find({ session_id: sessionQuery })
      .project({ _id: 0, id: 1, text: 1, is_question: 1, created_at: 1 })
      .sort({ id: 1 })
      .toArray();
    const answers = await col('answers')
      .find({ session_id: sessionQuery })
      .project({ _id: 0, id: 1, question: 1, reply: 1, mode: 1, action: 1, created_at: 1 })
      .sort({ id: -1 })
      .toArray();
    return res.json({ session: await enrichSession(owned), transcript: lines, answers });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/start', requireAuth, async (req, res, next) => {
  try {
    const owned = await ownedSession(req.user.id, req.params.id);
    if (!owned) return res.status(404).json({ error: 'not_found' });

    // Once ended, a session cannot be restarted — create a new session
    if (owned.status === 'ended') {
      return res.status(410).json({
        error: 'session_ended',
        message: 'This session has ended. Please create a new session.',
      });
    }

    const isCopilotOpen = Boolean(req.body && req.body.copilot_open);

    // If Copilot has ALREADY been opened before for this session:
    if (owned.copilot_opened_at) {
      // Check if session has expired
      if (owned.expires_at && isExpired(owned.expires_at)) {
        const limitMin = (owned.billing_kind === 'trial' || owned.plan === 'free') ? (credits.TRIAL_MINUTES || 10) : 15;
        return res.status(410).json({
          error: 'session_expired',
          message: `This session has expired after ${limitMin} minutes. Please create a new session.`,
        });
      }

      // If active and unexpired, return existing session without resetting clock (refreshes preserve timer)
      if (owned.status === 'active' && owned.started_at) {
        return res.json({ session: await enrichSession(owned), account: await credits.accountSummary(req.user.id) });
      }
    }

    // If this session is already active but Copilot was NEVER opened yet (!owned.copilot_opened_at):
    // Opening Copilot starts the timer fresh from the exact moment Copilot is opened!
    if (owned.status === 'active' && isCopilotOpen && !owned.copilot_opened_at) {
      const minutes = owned.max_minutes
        || ((owned.billing_kind === 'trial' || owned.plan === 'free') ? credits.TRIAL_MINUTES : 60);
      const $set = {
        started_at: nowSql(),
        expires_at: addMinutesFromNow(minutes),
        copilot_opened_at: nowSql(),
      };
      await col('call_sessions').updateOne({ id: owned.id }, { $set });
      const account = await credits.accountSummary(req.user.id);
      return res.json({ session: await enrichSession({ ...owned, ...$set }), account });
    }

    // If session is already active, not copilot_open, and unexpired:
    if (owned.status === 'active' && owned.started_at && (!owned.expires_at || !isExpired(owned.expires_at))) {
      return res.json({ session: await enrichSession(owned), account: await credits.accountSummary(req.user.id) });
    }

    const requested = String((req.body && req.body.billing) || '')
      || (String(req.body && req.body.plan) === 'full' ? 'paid' : (String(req.body && req.body.plan) === 'free' ? 'trial' : (owned.billing_kind || 'trial')));

    let opened;
    try {
      opened = await credits.openSession(req.user.id, owned.id, requested);
    } catch (err) {
      return res.status(err.status || 409).json({
        error: err.code || 'no_trials_left',
        message: err.message || 'All 5 free trials have been used. Payment is required to continue.',
      });
    }

    const sessionMinutes = opened.minutes || (opened.kind === 'trial' ? credits.TRIAL_MINUTES : 60);
    const $set = {
      status: 'active',
      plan: opened.kind === 'trial' ? 'free' : 'full',
      billing_kind: opened.kind,
      started_at: nowSql(),
      expires_at: addMinutesFromNow(sessionMinutes),
      max_minutes: sessionMinutes,
      ended_at: null,
      settled_at: null,
    };
    if (isCopilotOpen) $set.copilot_opened_at = nowSql();

    await col('call_sessions').updateOne({ id: owned.id }, { $set });
    const fresh = await ownedSession(req.user.id, owned.id);
    res.json({ session: await enrichSession(fresh), account: await credits.accountSummary(req.user.id) });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/resume', requireAuth, async (req, res, next) => {
  try {
    const owned = await ownedSession(req.user.id, req.params.id);
    if (!owned) return res.status(404).json({ error: 'not_found' });
    if (owned.status === 'ended' || (owned.expires_at && isExpired(owned.expires_at))) {
      return res.status(410).json({ error: 'session_ended', message: 'This session has ended or expired.' });
    }
    res.json({ session: await enrichSession(owned), account: await credits.accountSummary(req.user.id) });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/end', requireAuth, async (req, res, next) => {
  try {
    const owned = await ownedSession(req.user.id, req.params.id);
    if (!owned) return res.status(404).json({ error: 'not_found' });

    await col('call_sessions').updateOne(
      { id: owned.id },
      { $set: { status: 'ended', ended_at: owned.ended_at || nowSql() } }
    );
    const fresh = await ownedSession(req.user.id, owned.id);
    const settlement = await credits.settleSession(fresh);
    res.json({
      session: await enrichSession(await ownedSession(req.user.id, owned.id)),
      settlement,
      account: await credits.accountSummary(req.user.id),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/transcript', requireAuth, async (req, res, next) => {
  try {
    const owned = await ownedSession(req.user.id, req.params.id);
    if (!owned) return res.status(404).json({ error: 'not_found' });
    if (owned.status === 'ended' || (owned.expires_at && isExpired(owned.expires_at))) {
      return res.status(410).json({ error: 'session_ended', message: 'This session has ended or expired.' });
    }
    const text = String((req.body && req.body.text) || '').trim();
    if (!text) return res.status(400).json({ error: 'empty_line' });
    const id = await nextId('transcript_lines');
    await col('transcript_lines').insertOne({
      id,
      session_id: owned.id,
      text,
      is_question: req.body.is_question ? 1 : 0,
      created_at: nowSql(),
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireAuthLive, async (req, res, next) => {
  try {
    const result = await col('call_sessions').deleteOne({
      id: Number(req.params.id),
      user_id: req.user.id,
    });
    if (!result.deletedCount) return res.status(404).json({ error: 'not_found' });
    // The session row is gone, so the delete is done as far as the user is
    // concerned; its transcript lines are cleaned up without holding the reply.
    res.status(204).end();
    col('transcript_lines').deleteMany({ session_id: Number(req.params.id) })
      .catch((err) => console.warn(`[SESSION DELETE] transcript cleanup failed: ${err.message}`));
    return;
  } catch (err) {
    next(err);
  }
});

router.post('/:id/audio', requireAuth, transcribeLimiter, upload.single('audio'), async (req, res, next) => {
  try {
    const owned = await ownedSession(req.user.id, req.params.id);
    if (!owned) return res.status(404).json({ error: 'not_found' });
    if (owned.status === 'ended' || (owned.expires_at && isExpired(owned.expires_at))) {
      return res.status(410).json({ error: 'session_ended', message: 'This session has ended or expired.' });
    }

    if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
      return res.status(400).json({ error: 'empty_audio', message: 'No audio chunk received.' });
    }

    const used = await tokensUsedThisMonth(req.user.id);
    const gate = quota.check(req.user, used, TRANSCRIBE_RESERVE_TOKENS);
    if (gate.blocked) {
      return res.status(429).json({
        error: 'quota_exhausted',
        message: 'Monthly token safety limit reached. Transcription stopped.',
      });
    }

    const usageId = await reserveUsage(req.user.id, TRANSCRIBE_MODEL, 0, TRANSCRIBE_RESERVE_TOKENS, owned.id);
    let inputTokens = 0;
    let outputTokens = 0;
    let text = '';

    try {
      const filename = req.file.originalname || 'chunk.webm';
      const contentType = req.file.mimetype || 'audio/webm';
      const result = await transcribeAudio(req.file.buffer, filename, contentType, owned);
      text = result.text;

      if (result.usage) {
        inputTokens = result.usage.input_tokens || 0;
        outputTokens = result.usage.output_tokens || 0;
      } else {
        outputTokens = TRANSCRIBE_RESERVE_TOKENS;
      }
    } catch (err) {
      inputTokens = 0;
      outputTokens = 0;
      throw err;
    } finally {
      await settleUsage(usageId, inputTokens, outputTokens);
    }

    if (!text || !text.trim()) {
      const lines = await col('transcript_lines')
        .find({ session_id: owned.id })
        .project({ _id: 0, id: 1, text: 1, is_question: 1, created_at: 1 })
        .sort({ id: 1 })
        .toArray();
      const answers = await col('answers')
        .find({ session_id: owned.id })
        .project({ _id: 0, id: 1, question: 1, reply: 1, mode: 1, action: 1, created_at: 1 })
        .sort({ id: 1 })
        .toArray();
      const answersMapped = answers.map(a => ({ ...a, answer: a.reply }));
      return res.json({ transcripts: lines, answers: answersMapped });
    }

    const isQuestion = looksLikeQuestion(text);

    const transcriptLineId = await nextId('transcript_lines');
    await col('transcript_lines').insertOne({
      id: transcriptLineId,
      session_id: owned.id,
      text,
      is_question: isQuestion ? 1 : 0,
      created_at: nowSql(),
    });

    if (owned.auto_answer && isQuestion) {
      const previousLines = await col('transcript_lines')
        .find({ session_id: owned.id })
        .sort({ id: 1 })
        .toArray();
      const transcriptStr = previousLines.map(l => (l.is_question ? 'Q: ' : '- ') + l.text).join('\n');

      const MAX_DOC_CHARS = 8000;
      const loadDoc = (kind) => loadDocContent(req.user.id, kind, MAX_DOC_CHARS);

      const messages = buildMessages({
        question: text,
        transcript: transcriptStr,
        resume: await loadDoc('resume'),
        experience: await loadDoc('experience'),
        jobDescription: await loadDoc('job_description'),
        company: await loadDoc('company'),
        sessionJobDescription: owned.job_description,
        sessionCompany: owned.company,
        sessionRole: owned.role,
        sessionContext: owned.context,
        mode: owned.mode,
        action: 'answer',
        language: owned.language || 'English',
      });

      const promptEstimate = Math.ceil(messages.map(m => m.content).join('\n').length / 4);
      const usedNow = await tokensUsedThisMonth(req.user.id);
      const answerGate = quota.check(req.user, usedNow, promptEstimate + 64);

      if (!answerGate.blocked) {
        const chosenModel = modelFor(owned);
        const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS || 4000);
        const budget = quota.outputBudget(MAX_OUTPUT_TOKENS, answerGate.remaining, promptEstimate);
        const answerUsageId = await reserveUsage(req.user.id, chosenModel, promptEstimate, budget, owned.id);

        let answerText = '';
        let reported = null;
        try {
          const completion = await openai().chat.completions.create({
            model: chosenModel,
            messages,
            temperature: 0.3,
            max_completion_tokens: budget,
          });
          answerText = (completion.choices[0] && completion.choices[0].message.content) || '';
          reported = completion.usage || null;
        } finally {
          await settleUsage(
            answerUsageId,
            reported ? reported.prompt_tokens : promptEstimate,
            reported ? reported.completion_tokens : Math.ceil(answerText.length / 4)
          );
        }

        await saveAnswer({
          userId: req.user.id,
          question: text,
          reply: answerText,
          mode: owned.mode,
          action: 'answer',
          sessionId: owned.id,
        });
      }
    }

    const finalLines = await col('transcript_lines')
      .find({ session_id: owned.id })
      .project({ _id: 0, id: 1, text: 1, is_question: 1, created_at: 1 })
      .sort({ id: 1 })
      .toArray();
    const finalAnswers = await col('answers')
      .find({ session_id: owned.id })
      .project({ _id: 0, id: 1, question: 1, reply: 1, mode: 1, action: 1, created_at: 1 })
      .sort({ id: 1 })
      .toArray();
    const answersMapped = finalAnswers.map(a => ({ ...a, answer: a.reply }));

    res.json({ transcripts: finalLines, answers: answersMapped });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/questions', requireAuth, answerLimiter, async (req, res, next) => {
  try {
    const owned = await ownedSession(req.user.id, req.params.id);
    if (!owned) return res.status(404).json({ error: 'not_found' });

    const question = String(req.body && req.body.question).trim();
    if (!question) return res.status(400).json({ error: 'missing_question', message: 'question is required.' });

    const transcriptLineId = await nextId('transcript_lines');
    await col('transcript_lines').insertOne({
      id: transcriptLineId,
      session_id: owned.id,
      text: question,
      is_question: 1,
      created_at: nowSql(),
    });

    const previousLines = await col('transcript_lines')
      .find({ session_id: owned.id })
      .sort({ id: 1 })
      .toArray();
    const transcriptStr = previousLines.map(l => (l.is_question ? 'Q: ' : '- ') + l.text).join('\n');

    const MAX_DOC_CHARS = 8000;
    const loadDoc = (kind) => loadDocContent(req.user.id, kind, MAX_DOC_CHARS);

    const messages = buildMessages({
      question,
      transcript: transcriptStr,
      resume: await loadDoc('resume'),
      experience: await loadDoc('experience'),
      jobDescription: await loadDoc('job_description'),
      company: await loadDoc('company'),
      sessionJobDescription: owned.job_description,
      sessionCompany: owned.company,
      sessionRole: owned.role,
      sessionContext: owned.context,
      mode: owned.mode,
      action: 'answer',
      language: owned.language || 'English',
    });

    const promptEstimate = Math.ceil(messages.map(m => m.content).join('\n').length / 4);
    const used = await tokensUsedThisMonth(req.user.id);
    const gate = quota.check(req.user, used, promptEstimate + 64);

    let answerText = '';
    let kind = 'AI Assistant';

    if (gate.blocked) {
      return res.status(429).json({
        error: 'quota_exhausted',
        message: 'Monthly token safety limit reached.',
      });
    }

    const chosenModel = modelFor(owned);
    const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS || 4000);
    const budget = quota.outputBudget(MAX_OUTPUT_TOKENS, gate.remaining, promptEstimate);
    const usageId = await reserveUsage(req.user.id, chosenModel, promptEstimate, budget, owned.id);

    let reported = null;
    try {
      const completion = await openai().chat.completions.create({
        model: chosenModel,
        messages,
        temperature: 0.3,
        max_completion_tokens: budget,
      });
      answerText = (completion.choices[0] && completion.choices[0].message.content) || '';
      reported = completion.usage || null;
      kind = classifyQuestion(question);
    } finally {
      await settleUsage(
        usageId,
        reported ? reported.prompt_tokens : promptEstimate,
        reported ? reported.completion_tokens : Math.ceil(answerText.length / 4)
      );
    }

    await saveAnswer({
      userId: req.user.id,
      question,
      reply: answerText,
      mode: owned.mode,
      action: 'answer',
      sessionId: owned.id,
    });

    res.json({
      question,
      answer: answerText,
      kind,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/transcript', requireAuth, async (req, res, next) => {
  try {
    const owned = await ownedSession(req.user.id, req.params.id);
    if (!owned) return res.status(404).json({ error: 'not_found' });

    const numId = Number(owned.id);
    const sessionQuery = Number.isFinite(numId) ? { $in: [numId, String(owned.id)] } : owned.id;
    const lines = await col('transcript_lines')
      .find({ session_id: sessionQuery })
      .project({ _id: 0, id: 1, text: 1, is_question: 1, created_at: 1 })
      .sort({ id: 1 })
      .toArray();

    res.json({ transcripts: lines });
  } catch (err) {
    next(err);
  }
});

async function sessionExists(userId, id) {
  if (!id) return null;
  const row = await ownedSession(userId, id);
  return row ? row.id : null;
}

async function getSession(userId, id) {
  if (!id) return null;
  return ownedSession(userId, id);
}

// Live-call routes look the session up on every transcription chunk and
// answer; a few seconds of reuse saves an Atlas round trip on each. Returns a
// copy so a caller mutating its row cannot alter the cached one.
const LIVE_SESSION_CACHE_MS = 5 * 1000;
// Past LIVE_SESSION_CACHE_MS a found session is still served from cache while
// it is re-read in the background, so a question never waits on this lookup.
// Expiry is checked against expires_at by the caller, so time-up still holds.
const LIVE_SESSION_STALE_MS = 10 * 60 * 1000;
const liveSessionCache = new Map();

function refreshLiveSession(key, userId, id) {
  return ownedSession(userId, id).then((session) => {
    liveSessionCache.set(key, { session, at: Date.now() });
    if (liveSessionCache.size > 500) liveSessionCache.clear();
    return session;
  });
}

async function getSessionLive(userId, id) {
  if (!id) return null;
  const key = `${userId}:${id}`;
  const hit = liveSessionCache.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && age < LIVE_SESSION_CACHE_MS) return hit.session && { ...hit.session };
  if (hit && hit.session && age < LIVE_SESSION_STALE_MS) {
    if (!hit.refreshing) {
      hit.refreshing = true;
      refreshLiveSession(key, userId, id).catch(() => { hit.refreshing = false; });
    }
    return { ...hit.session };
  }
  const session = await refreshLiveSession(key, userId, id);
  return session && { ...session };
}

module.exports = { router, sessionExists, getSession, getSessionLive, ownedSession, looksLikeQuestion };
