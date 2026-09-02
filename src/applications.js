/**
 * Job Application Tracker
 * Full CRUD for tracking job applications.
 */
const express = require('express');
const { col, nextId, nowSql, publicDoc } = require('./db');
const { requireAuth } = require('./auth');

const router = express.Router();

const VALID_STATUSES = [
  'saved', 'applied', 'screening', 'interview',
  'technical', 'hr_round', 'offer', 'rejected', 'withdrawn',
];

function shapeApplication(app) {
  if (!app) return null;
  return publicDoc(app);
}

function validateBody(body) {
  const {
    company, job_title, job_url, location, salary_range,
    applied_date, interview_date, status, notes,
    contact_name, contact_email, resume_id, cover_letter_id,
  } = body || {};

  const errors = [];
  if (!company || String(company).trim().length < 1) errors.push('company is required');
  if (!job_title || String(job_title).trim().length < 1) errors.push('job_title is required');
  if (status && !VALID_STATUSES.includes(status)) errors.push(`status must be one of: ${VALID_STATUSES.join(', ')}`);

  return {
    errors,
    fields: {
      company: String(company || '').trim(),
      job_title: String(job_title || '').trim(),
      job_url: String(job_url || '').trim(),
      location: String(location || '').trim(),
      salary_range: String(salary_range || '').trim(),
      applied_date: applied_date ? String(applied_date) : null,
      interview_date: interview_date ? String(interview_date) : null,
      status: VALID_STATUSES.includes(status) ? status : 'saved',
      notes: String(notes || '').trim(),
      contact_name: String(contact_name || '').trim(),
      contact_email: String(contact_email || '').trim(),
      resume_id: resume_id ? Number(resume_id) : null,
      cover_letter_id: cover_letter_id ? Number(cover_letter_id) : null,
    },
  };
}

// GET /api/applications
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { status, search, sort = 'newest', limit = 100 } = req.query;
    const filter = { user_id: req.user.id };
    if (status && VALID_STATUSES.includes(status)) filter.status = status;
    if (search) {
      const re = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ company: re }, { job_title: re }, { notes: re }];
    }

    const sortOrder = sort === 'oldest' ? 1 : -1;
    const rows = await col('job_applications')
      .find(filter)
      .sort({ id: sortOrder })
      .limit(Math.min(Number(limit) || 100, 200))
      .toArray();

    return res.json({ applications: rows.map(shapeApplication) });
  } catch (err) {
    return next(err);
  }
});

// POST /api/applications
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { errors, fields } = validateBody(req.body);
    if (errors.length > 0) {
      return res.status(400).json({ error: 'validation_error', errors });
    }

    const id = await nextId('job_applications');
    const record = {
      id,
      user_id: req.user.id,
      ...fields,
      created_at: nowSql(),
      updated_at: nowSql(),
    };
    await col('job_applications').insertOne(record);
    return res.status(201).json({ application: shapeApplication(record) });
  } catch (err) {
    return next(err);
  }
});

// GET /api/applications/:id
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const row = await col('job_applications').findOne({
      id: Number(req.params.id),
      user_id: req.user.id,
    });
    if (!row) return res.status(404).json({ error: 'not_found' });
    return res.json({ application: shapeApplication(row) });
  } catch (err) {
    return next(err);
  }
});

// PUT /api/applications/:id
router.put('/:id', requireAuth, async (req, res, next) => {
  try {
    const existing = await col('job_applications').findOne({
      id: Number(req.params.id),
      user_id: req.user.id,
    });
    if (!existing) return res.status(404).json({ error: 'not_found' });

    const { errors, fields } = validateBody({ ...publicDoc(existing), ...(req.body || {}) });
    if (errors.length > 0) {
      return res.status(400).json({ error: 'validation_error', errors });
    }

    await col('job_applications').updateOne(
      { id: existing.id },
      { $set: { ...fields, updated_at: nowSql() } }
    );

    const updated = shapeApplication(await col('job_applications').findOne({ id: existing.id }));
    return res.json({ application: updated });
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/applications/:id
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const row = await col('job_applications').findOne({
      id: Number(req.params.id),
      user_id: req.user.id,
    });
    if (!row) return res.status(404).json({ error: 'not_found' });
    await col('job_applications').deleteOne({ id: row.id });
    return res.status(204).end();
  } catch (err) {
    return next(err);
  }
});

// GET /api/applications/stats/summary — kanban counts per status
router.get('/stats/summary', requireAuth, async (req, res, next) => {
  try {
    const pipeline = [
      { $match: { user_id: req.user.id } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ];
    const rows = await col('job_applications').aggregate(pipeline).toArray();
    const counts = {};
    for (const status of VALID_STATUSES) counts[status] = 0;
    for (const row of rows) counts[row._id] = row.count;
    return res.json({ summary: counts, total: rows.reduce((s, r) => s + r.count, 0) });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
