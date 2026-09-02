/**
 * AI Resume Analyzer
 * POST /api/resume/analyze  — analyze resume text, return ATS score + recommendations
 * GET  /api/resume/analyses  — list past analyses for current user
 */
const express = require('express');
const { col, nextId, nowSql, publicDoc } = require('./db');
const { requireAuth } = require('./auth');
const { openai } = require('./openai-client');
const { enforceFeatureLimit } = require('./subscriptions');
const { createNotification } = require('./notifications');

const router = express.Router();
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const ANALYSIS_SYSTEM_PROMPT = `You are an expert ATS (Applicant Tracking System) resume analyst and career coach.
Analyze the resume provided and return a structured JSON response.

Return ONLY valid JSON with exactly this structure:
{
  "ats_score": <number 0-100>,
  "section_scores": {
    "contact": <0-100>,
    "summary": <0-100>,
    "skills": <0-100>,
    "experience": <0-100>,
    "education": <0-100>,
    "formatting": <0-100>,
    "ats_compatibility": <0-100>
  },
  "extracted": {
    "skills": [<string>],
    "technologies": [<string>],
    "job_titles": [<string>],
    "companies": [<string>],
    "education": [<string>],
    "certifications": [<string>],
    "total_years_experience": <number or null>
  },
  "problems": [
    {
      "severity": "high|medium|low",
      "category": "keywords|bullet_points|formatting|skills|achievements|ats",
      "issue": "<description of problem>",
      "current": "<example of problematic text from resume or null>",
      "improved": "<suggested improved version or null>"
    }
  ],
  "strengths": [<string>],
  "recommendations": [<string top-5 action items>],
  "summary": "<2-3 sentence overall assessment>"
}`;

async function analyzeResumeText(resumeText) {
  const response = await openai().chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Please analyze this resume:\n\n${resumeText.slice(0, 12000)}`,
      },
    ],
    temperature: 0.2,
    response_format: { type: 'json_object' },
    max_completion_tokens: 2000,
  });

  const raw = response.choices[0].message.content;
  return JSON.parse(raw);
}

// POST /api/resume/analyze
router.post('/analyze', requireAuth, enforceFeatureLimit('resume_analyses'), async (req, res, next) => {
  try {
    const { document_id } = req.body || {};
    if (!document_id) {
      return res.status(400).json({ error: 'missing_document_id', message: 'Provide a document_id.' });
    }

    // Fetch resume document (must belong to this user)
    const doc = publicDoc(await col('documents').findOne({
      id: Number(document_id),
      user_id: req.user.id,
    }));
    if (!doc) {
      return res.status(404).json({ error: 'not_found', message: 'Resume not found.' });
    }
    if (doc.kind !== 'resume') {
      return res.status(400).json({ error: 'wrong_kind', message: 'Document must be a resume.' });
    }
    if (!doc.content || doc.content.length < 50) {
      return res.status(400).json({ error: 'empty_resume', message: 'Resume has too little text to analyze.' });
    }

    // Run AI analysis
    let analysis;
    try {
      analysis = await analyzeResumeText(doc.content);
    } catch (aiErr) {
      console.error('Resume AI analysis failed:', aiErr);
      return res.status(502).json({
        error: 'ai_error',
        message: 'AI analysis failed. Please try again.',
      });
    }

    // Save to resume_analyses collection
    const id = await nextId('resume_analyses');
    const record = {
      id,
      user_id: req.user.id,
      document_id: doc.id,
      document_filename: doc.filename,
      ats_score: analysis.ats_score,
      section_scores: analysis.section_scores,
      extracted: analysis.extracted,
      problems: analysis.problems,
      strengths: analysis.strengths,
      recommendations: analysis.recommendations,
      summary: analysis.summary,
      created_at: nowSql(),
    };
    await col('resume_analyses').insertOne(record);

    createNotification(req.user.id, {
      type: 'resume_analysis_complete',
      title: 'Resume Analysis Complete',
      message: `"${doc.filename}" scored ${analysis.ats_score}/100.`,
    }).catch(console.error);

    return res.json({ analysis: publicDoc(record) });
  } catch (err) {
    return next(err);
  }
});

// GET /api/resume/analyses — list all analyses for user
router.get('/analyses', requireAuth, async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const rows = await col('resume_analyses')
      .find({ user_id: req.user.id })
      .sort({ id: -1 })
      .limit(limit)
      .toArray();
    return res.json({ analyses: rows.map(publicDoc) });
  } catch (err) {
    return next(err);
  }
});

// GET /api/resume/analyses/:id — fetch single analysis
router.get('/analyses/:id', requireAuth, async (req, res, next) => {
  try {
    const row = publicDoc(await col('resume_analyses').findOne({
      id: Number(req.params.id),
      user_id: req.user.id,
    }));
    if (!row) return res.status(404).json({ error: 'not_found' });
    return res.json({ analysis: row });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
