/**
 * Cover Letter Generator
 * POST /api/cover-letter/generate  — streaming SSE cover letter
 * GET  /api/cover-letter           — list saved cover letters
 * DELETE /api/cover-letter/:id     — delete cover letter
 */
const express = require('express');
const { col, nextId, nowSql, publicDoc } = require('./db');
const { requireAuth } = require('./auth');
const { openai } = require('./openai-client');
const { enforceFeatureLimit } = require('./subscriptions');

const router = express.Router();
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const TONE_INSTRUCTIONS = {
  professional: 'Write in a formal, polished, and professional tone.',
  confident: 'Write in a confident, assertive tone that highlights achievements boldly.',
  concise: 'Write in a brief, direct tone. Keep the letter under 200 words.',
  friendly: 'Write in a warm, personable, and approachable tone.',
};

function buildCoverLetterPrompt({ resumeText, jdText, company, jobTitle, tone }) {
  const toneInstruction = TONE_INSTRUCTIONS[tone] || TONE_INSTRUCTIONS.professional;
  return `You are an expert cover letter writer.
${toneInstruction}

Write a personalized, compelling cover letter for this candidate applying for the role.
- Address it to the hiring team at ${company || 'the company'}.
- The position is: ${jobTitle || 'the advertised role'}.
- Use specific details from the resume (real experience, projects, skills).
- Match the key requirements from the job description.
- Do NOT use generic filler phrases like "I am writing to express my interest".
- Keep it to 3 short paragraphs + opening/closing.
- Do NOT add placeholders like [Your Name] or [Date] — write a clean final letter.

CANDIDATE RESUME:
${resumeText.slice(0, 5000)}

JOB DESCRIPTION:
${jdText.slice(0, 4000)}

Write the cover letter now:`;
}

// POST /api/cover-letter/generate (streaming SSE)
router.post('/generate', requireAuth, enforceFeatureLimit('cover_letters'), async (req, res, next) => {
  try {
    const { resume_id, job_id, jd_text, company, job_title, tone = 'professional' } = req.body || {};

    if (!resume_id) {
      return res.status(400).json({ error: 'missing_resume_id', message: 'Provide a resume_id.' });
    }

    const resumeDoc = publicDoc(await col('documents').findOne({
      id: Number(resume_id),
      user_id: req.user.id,
      kind: 'resume',
    }));
    if (!resumeDoc) return res.status(404).json({ error: 'resume_not_found' });

    let jdContent = jd_text || '';
    if (job_id && !jdContent) {
      const jdDoc = publicDoc(await col('documents').findOne({
        id: Number(job_id),
        user_id: req.user.id,
      }));
      if (jdDoc) jdContent = jdDoc.content || '';
    }

    // A full job description is ideal, but a job title alone is enough to
    // write from — only block when we have neither.
    if (jdContent.trim().length < 20 && !String(job_title || '').trim()) {
      return res.status(400).json({
        error: 'missing_jd',
        message: 'Provide a job description, or at least a job title.',
      });
    }
    if (!jdContent.trim()) {
      jdContent = `Role: ${String(job_title).trim()}`;
    }

    const prompt = buildCoverLetterPrompt({
      resumeText: resumeDoc.content,
      jdText: jdContent,
      company: String(company || '').trim(),
      jobTitle: String(job_title || '').trim(),
      tone,
    });

    // Set up SSE
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const controller = new AbortController();
    res.on('close', () => controller.abort());

    let fullText = '';
    const stream = await openai().chat.completions.create(
      {
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_completion_tokens: 800,
        stream: true,
      },
      { signal: controller.signal }
    );

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        fullText += delta;
        res.write(`event: token\ndata: ${JSON.stringify({ text: delta })}\n\n`);
      }
    }

    // Save the generated cover letter
    if (fullText.trim().length > 50) {
      const id = await nextId('cover_letters');
      await col('cover_letters').insertOne({
        id,
        user_id: req.user.id,
        resume_id: Number(resume_id),
        job_id: job_id ? Number(job_id) : null,
        company: String(company || '').trim(),
        job_title: String(job_title || '').trim(),
        tone,
        content: fullText,
        created_at: nowSql(),
      });
      res.write(`event: done\ndata: ${JSON.stringify({ saved_id: id })}\n\n`);
    } else {
      res.write(`event: done\ndata: ${JSON.stringify({ saved_id: null })}\n\n`);
    }

    res.end();
    return undefined;
  } catch (err) {
    if (err.name === 'AbortError') return undefined;
    return next(err);
  }
});

// GET /api/cover-letter — list saved cover letters
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const rows = await col('cover_letters')
      .find({ user_id: req.user.id })
      .sort({ id: -1 })
      .limit(50)
      .toArray();
    return res.json({ cover_letters: rows.map((r) => ({ ...publicDoc(r), content: undefined })) });
  } catch (err) {
    return next(err);
  }
});

// GET /api/cover-letter/:id — fetch single cover letter with content
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const row = publicDoc(await col('cover_letters').findOne({
      id: Number(req.params.id),
      user_id: req.user.id,
    }));
    if (!row) return res.status(404).json({ error: 'not_found' });
    return res.json({ cover_letter: row });
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/cover-letter/:id
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const row = await col('cover_letters').findOne({
      id: Number(req.params.id),
      user_id: req.user.id,
    });
    if (!row) return res.status(404).json({ error: 'not_found' });
    await col('cover_letters').deleteOne({ id: row.id });
    return res.status(204).end();
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
