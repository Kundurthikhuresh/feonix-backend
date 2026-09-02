/**
 * Interview Preparation
 * POST /api/interview-prep/generate    — generate questions by category
 * POST /api/interview-prep/evaluate    — evaluate user's answer (streaming SSE)
 * GET  /api/interview-prep/sessions    — list prep sessions
 * GET  /api/interview-prep/sessions/:id — get session with Q&A
 */
const express = require('express');
const { col, nextId, nowSql, publicDoc } = require('./db');
const { requireAuth } = require('./auth');
const { openai } = require('./openai-client');
const { enforceFeatureLimit } = require('./subscriptions');

const router = express.Router();
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const QUESTION_GEN_PROMPT = `You are an expert interview coach.
Generate interview questions based on the candidate's resume and target job.
Return ONLY valid JSON:
{
  "questions": [
    {
      "id": <number 1-N>,
      "category": "hr|technical|behavioral|scenario|resume_based",
      "difficulty": "easy|medium|hard",
      "question": "<the interview question>",
      "expected_topics": [<string — key topics a good answer should cover>],
      "hint": "<brief hint for the candidate>"
    }
  ]
}
Generate exactly the number requested per category. Mix difficulty appropriately.`;

const EVALUATION_PROMPT = `You are an expert interview coach evaluating a candidate's answer.
Evaluate the answer and return a JSON response first (one line), then stream the full feedback.

Return ONLY valid JSON:
{
  "scores": {
    "communication": <0-10>,
    "technical_accuracy": <0-10>,
    "clarity": <0-10>,
    "relevance": <0-10>,
    "confidence": <0-10>
  },
  "overall_score": <0-100>,
  "grade": "Excellent|Good|Satisfactory|Needs Improvement|Poor",
  "strengths": [<string>],
  "improvements": [<string>],
  "ideal_answer": "<what a great answer would include>",
  "feedback": "<2-3 paragraph detailed feedback>"
}`;

// POST /api/interview-prep/generate
router.post('/generate', requireAuth, enforceFeatureLimit('interview_prep'), async (req, res, next) => {
  try {
    const {
      resume_id,
      job_id,
      jd_text,
      job_role,
      categories = ['hr', 'technical', 'behavioral'],
      questions_per_category = 3,
    } = req.body || {};

    let resumeText = '';
    let jdContent = jd_text || '';

    if (resume_id) {
      const doc = publicDoc(await col('documents').findOne({
        id: Number(resume_id),
        user_id: req.user.id,
        kind: 'resume',
      }));
      if (doc) resumeText = doc.content || '';
    }

    if (job_id && !jdContent) {
      const jdDoc = publicDoc(await col('documents').findOne({
        id: Number(job_id),
        user_id: req.user.id,
      }));
      if (jdDoc) jdContent = jdDoc.content || '';
    }

    const totalQ = Math.min(Number(questions_per_category) || 3, 5) * categories.length;
    const categoriesStr = categories.join(', ');

    const userPrompt = `
Generate ${Number(questions_per_category) || 3} questions for each of these categories: ${categoriesStr}.
Total: ${totalQ} questions.
${job_role ? `Target Role: ${job_role}` : ''}
${resumeText ? `\nCANDIDATE RESUME:\n${resumeText.slice(0, 4000)}` : ''}
${jdContent ? `\nJOB DESCRIPTION:\n${jdContent.slice(0, 3000)}` : ''}
`.trim();

    const response = await openai().chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: QUESTION_GEN_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.6,
      response_format: { type: 'json_object' },
      max_completion_tokens: 2000,
    });

    const result = JSON.parse(response.choices[0].message.content);

    // Save prep session
    const id = await nextId('interview_prep_sessions');
    const session = {
      id,
      user_id: req.user.id,
      resume_id: resume_id ? Number(resume_id) : null,
      job_id: job_id ? Number(job_id) : null,
      job_role: String(job_role || '').trim(),
      categories,
      questions: result.questions || [],
      answers: [],
      created_at: nowSql(),
    };
    await col('interview_prep_sessions').insertOne(session);

    return res.json({ session: publicDoc(session) });
  } catch (err) {
    return next(err);
  }
});

// POST /api/interview-prep/evaluate (streaming SSE)
router.post('/evaluate', requireAuth, async (req, res, next) => {
  try {
    const { session_id, question_id, question, answer } = req.body || {};

    if (!question || !answer) {
      return res.status(400).json({ error: 'missing_fields', message: 'Provide question and answer.' });
    }

    const userPrompt = `
INTERVIEW QUESTION: ${String(question).trim()}

CANDIDATE'S ANSWER: ${String(answer).trim().slice(0, 3000)}

Please evaluate this answer.`.trim();

    const response = await openai().chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: EVALUATION_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
      max_completion_tokens: 800,
    });

    const evaluation = JSON.parse(response.choices[0].message.content);

    // Save evaluation to session
    if (session_id) {
      const evalRecord = {
        question_id: question_id || null,
        question: String(question).trim(),
        answer: String(answer).trim(),
        evaluation,
        answered_at: nowSql(),
      };
      await col('interview_prep_sessions').updateOne(
        { id: Number(session_id), user_id: req.user.id },
        { $push: { answers: evalRecord } }
      );
    }

    return res.json({ evaluation });
  } catch (err) {
    return next(err);
  }
});

// GET /api/interview-prep/sessions
router.get('/sessions', requireAuth, async (req, res, next) => {
  try {
    const rows = await col('interview_prep_sessions')
      .find({ user_id: req.user.id })
      .sort({ id: -1 })
      .limit(20)
      .toArray();
    // Return sessions without full question/answer lists for list view
    return res.json({
      sessions: rows.map((r) => {
        const s = publicDoc(r);
        return {
          id: s.id,
          job_role: s.job_role,
          categories: s.categories,
          question_count: (s.questions || []).length,
          answer_count: (s.answers || []).length,
          created_at: s.created_at,
        };
      }),
    });
  } catch (err) {
    return next(err);
  }
});

// GET /api/interview-prep/sessions/:id
router.get('/sessions/:id', requireAuth, async (req, res, next) => {
  try {
    const row = publicDoc(await col('interview_prep_sessions').findOne({
      id: Number(req.params.id),
      user_id: req.user.id,
    }));
    if (!row) return res.status(404).json({ error: 'not_found' });
    return res.json({ session: row });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
