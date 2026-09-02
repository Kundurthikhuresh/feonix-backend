/**
 * Job Description Analyzer
 * POST /api/job/analyze   — parse JD text into structured fields
 * POST /api/job/match     — match resume against JD
 */
const express = require('express');
const { col, nextId, nowSql, publicDoc } = require('./db');
const { requireAuth } = require('./auth');
const { openai } = require('./openai-client');
const { enforceFeatureLimit } = require('./subscriptions');

const router = express.Router();
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const JD_ANALYSIS_PROMPT = `You are an expert job description parser.
Extract structured information from the job description.
Return ONLY valid JSON with exactly this structure:
{
  "job_title": "<string>",
  "company": "<string or null>",
  "location": "<string or null>",
  "employment_type": "<full-time|part-time|contract|freelance|internship|null>",
  "experience_required": "<string e.g. '3-5 years' or null>",
  "education_required": "<string or null>",
  "required_skills": [<string>],
  "preferred_skills": [<string>],
  "technologies": [<string>],
  "responsibilities": [<string top 8>],
  "keywords": [<string top 15 ATS keywords>],
  "salary_range": "<string or null>",
  "summary": "<2 sentence summary>"
}`;

const JOB_MATCH_PROMPT = `You are an expert resume and job matching specialist.
Given a resume and a job description, perform a detailed match analysis.
Return ONLY valid JSON with exactly this structure:
{
  "overall_match": <number 0-100>,
  "skills_match": <number 0-100>,
  "experience_match": <number 0-100>,
  "keywords_match": <number 0-100>,
  "education_match": <number 0-100>,
  "matched_skills": [<string>],
  "missing_skills": [<string>],
  "matched_keywords": [<string>],
  "missing_keywords": [<string>],
  "improvement_tips": [
    {
      "priority": "high|medium|low",
      "tip": "<actionable improvement instruction>",
      "example": "<example of how to apply it>"
    }
  ],
  "summary": "<3 sentence overall assessment with key strengths and gaps>"
}`;

// POST /api/job/analyze
router.post('/analyze', requireAuth, enforceFeatureLimit('ai_generations'), async (req, res, next) => {
  try {
    const { document_id, text } = req.body || {};

    let jdText = '';
    let documentId = null;

    if (document_id) {
      const doc = publicDoc(await col('documents').findOne({
        id: Number(document_id),
        user_id: req.user.id,
      }));
      if (!doc) return res.status(404).json({ error: 'not_found', message: 'Document not found.' });
      jdText = doc.content || '';
      documentId = doc.id;
    } else if (text) {
      jdText = String(text).trim().slice(0, 12000);
    }

    if (!jdText || jdText.length < 50) {
      return res.status(400).json({ error: 'too_short', message: 'Job description is too short to analyze.' });
    }

    const response = await openai().chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: JD_ANALYSIS_PROMPT },
        { role: 'user', content: `Analyze this job description:\n\n${jdText}` },
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
      max_completion_tokens: 1200,
    });

    const analysis = JSON.parse(response.choices[0].message.content);

    // Optionally save the analysis
    const id = await nextId('job_analyses');
    const record = {
      id,
      user_id: req.user.id,
      document_id: documentId,
      ...analysis,
      raw_text_preview: jdText.slice(0, 500),
      created_at: nowSql(),
    };
    await col('job_analyses').insertOne(record);

    return res.json({ analysis: publicDoc(record) });
  } catch (err) {
    return next(err);
  }
});

// POST /api/job/match
router.post('/match', requireAuth, enforceFeatureLimit('job_matches'), async (req, res, next) => {
  try {
    const { resume_id, job_id, jd_text } = req.body || {};

    if (!resume_id) {
      return res.status(400).json({ error: 'missing_resume_id', message: 'Provide a resume_id.' });
    }

    // Fetch resume
    const resumeDoc = publicDoc(await col('documents').findOne({
      id: Number(resume_id),
      user_id: req.user.id,
      kind: 'resume',
    }));
    if (!resumeDoc) return res.status(404).json({ error: 'resume_not_found' });

    // Fetch JD: either from stored doc or from raw text
    let jdContent = '';
    if (job_id) {
      const jdDoc = publicDoc(await col('documents').findOne({
        id: Number(job_id),
        user_id: req.user.id,
      }));
      if (!jdDoc) return res.status(404).json({ error: 'jd_not_found' });
      jdContent = jdDoc.content || '';
    } else if (jd_text) {
      jdContent = String(jd_text).trim().slice(0, 8000);
    }

    if (!jdContent.trim()) {
      return res.status(400).json({ error: 'missing_jd', message: 'Provide a job_id or jd_text.' });
    }

    const response = await openai().chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: JOB_MATCH_PROMPT },
        {
          role: 'user',
          content: `RESUME:\n${resumeDoc.content.slice(0, 6000)}\n\nJOB DESCRIPTION:\n${jdContent}`,
        },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
      max_completion_tokens: 1500,
    });

    const match = JSON.parse(response.choices[0].message.content);

    const id = await nextId('job_matches');
    const record = {
      id,
      user_id: req.user.id,
      resume_id: Number(resume_id),
      job_id: job_id ? Number(job_id) : null,
      ...match,
      created_at: nowSql(),
    };
    await col('job_matches').insertOne(record);

    return res.json({ match: publicDoc(record) });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
