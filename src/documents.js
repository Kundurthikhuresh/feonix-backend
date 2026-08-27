const express = require('express');
const { col, nextId, nowSql, publicDoc } = require('./db');
const { requireAuth } = require('./auth');

const KINDS = ['resume', 'job_description', 'company'];
const MAX_TEXT_CHARS = 200000;
const MIN_TEXT_CHARS = 20;

function normalizeKind(k) {
  const s = String(k || '').toLowerCase().trim();
  if (['resume', 'resumes', 'cv', 'cvs'].includes(s)) return 'resume';
  if (['job_description', 'job_descriptions', 'documents', 'jd', 'jds'].includes(s)) return 'job_description';
  if (['company', 'company_notes', 'notes'].includes(s)) return 'company';
  return 'resume';
}

function looksLikeText(text) {
  if (!text || text.trim().length < MIN_TEXT_CHARS) return false;
  const nonControl = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').length;
  return nonControl / text.length > 0.85;
}

async function extractText(buffer, filename, mimeType = '') {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  const mime = String(mimeType || '').toLowerCase();

  if (ext === 'pdf' || mime.includes('pdf')) {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      if (parser.destroy) await parser.destroy();
    }
  }

  if (['docx', 'doc'].includes(ext) || mime.includes('word') || mime.includes('officedocument') || mime.includes('msword')) {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value || '';
  }

  if (['txt', 'md', 'markdown', 'text'].includes(ext) || mime.includes('text/')) {
    return buffer.toString('utf8');
  }

  const err = new Error(
    `Unsupported file type .${ext || 'unknown'}. Please upload a .docx, .pdf, .doc, or .txt file.`
  );
  err.status = 415;
  err.code = 'unsupported_type';
  throw err;
}

function shapeDoc(doc) {
  if (!doc) return null;
  const d = publicDoc(doc);
  return {
    id: d.id,
    kind: d.kind,
    filename: d.filename,
    source: d.source,
    is_active: d.is_active,
    chars: String(d.content || '').length,
    created_at: d.created_at,
  };
}

async function activateDocument(userId, id, kind) {
  await col('documents').updateMany({ user_id: userId, kind }, { $set: { is_active: 0 } });
  await col('documents').updateOne({ id, user_id: userId }, { $set: { is_active: 1 } });
}

async function saveDocument(userId, kind, filename, content, source = 'uploaded') {
  const id = await nextId('documents');
  const doc = {
    id,
    user_id: userId,
    kind,
    filename,
    content: content.slice(0, MAX_TEXT_CHARS),
    source,
    is_active: 0,
    created_at: nowSql(),
  };
  await col('documents').insertOne(doc);
  const activeCount = await col('documents').countDocuments({ user_id: userId, kind, is_active: 1 });
  if (!activeCount) await activateDocument(userId, id, kind);
  return shapeDoc(await col('documents').findOne({ id }));
}

const router = express.Router();

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const kind = String(req.query.kind || '');
    const filter = { user_id: req.user.id };
    if (KINDS.includes(kind)) filter.kind = kind;
    const rows = await col('documents').find(filter).sort({ id: -1 }).toArray();
    res.json({ documents: rows.map(shapeDoc) });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const doc = publicDoc(await col('documents').findOne({
      id: Number(req.params.id),
      user_id: req.user.id,
    }));
    if (!doc) return res.status(404).json({ error: 'not_found' });
    res.json({
      document: {
        id: doc.id,
        kind: doc.kind,
        filename: doc.filename,
        content: doc.content,
        created_at: doc.created_at,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/activate', requireAuth, async (req, res, next) => {
  try {
    const doc = publicDoc(await col('documents').findOne({
      id: Number(req.params.id),
      user_id: req.user.id,
    }));
    if (!doc) return res.status(404).json({ error: 'not_found' });
    await activateDocument(req.user.id, doc.id, doc.kind);
    res.json({ document: shapeDoc(await col('documents').findOne({ id: doc.id })) });
  } catch (err) {
    next(err);
  }
});

const multer = require('multer');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

router.post('/', requireAuth, async (req, res, next) => {
  if (!req.is('application/json')) return next();
  try {
    const kind = normalizeKind(String((req.body && req.body.kind) || ''));
    const content = String((req.body && req.body.content) || '').trim();
    const filename = String((req.body && req.body.filename) || '').trim() || `${kind}.txt`;
    if (content.length < MIN_TEXT_CHARS) {
      return res.status(400).json({
        error: 'too_short',
        message: `Needs at least ${MIN_TEXT_CHARS} characters of text.`,
      });
    }
    return res.status(200).json({
      document: await saveDocument(req.user.id, kind, filename, content, 'created'),
    });
  } catch (err) {
    return next(err);
  }
});

router.post(
  '/',
  requireAuth,
  (req, res, next) => {
    if (req.is('application/json')) return next();
    if (req.is('multipart/form-data')) {
      return upload.single('file')(req, res, (err) => {
        if (err) {
          return res.status(400).json({ error: 'upload_error', message: err.message });
        }
        next();
      });
    }
    express.raw({ type: () => true, limit: 10 * 1024 * 1024 })(req, res, next);
  },
  async (req, res) => {
    try {
      let fileBuffer = req.file ? req.file.buffer : req.body;
      const rawKind = String((req.body && req.body.kind) || req.get('X-Kind') || req.query.kind || '');
      const kind = normalizeKind(rawKind);
      let filename = String((req.file && req.file.originalname) || req.get('X-Filename') || req.query.filename || '');
      const mimeType = String((req.file && req.file.mimetype) || req.get('Content-Type') || '');
      if (filename) {
        try { filename = decodeURIComponent(filename); } catch { /* keep */ }
      }
      if (!fileBuffer || (Buffer.isBuffer(fileBuffer) && fileBuffer.length === 0)) {
        return res.status(400).json({ error: 'empty_upload', message: 'No file content received.' });
      }
      if (!filename || filename === 'upload') filename = `document.${mimeType.includes('pdf') ? 'pdf' : 'docx'}`;
      const text = (await extractText(fileBuffer, filename, mimeType)).trim();
      if (!looksLikeText(text)) {
        return res.status(422).json({
          error: 'no_text_found',
          message: 'No readable text extracted from file. Please ensure the document is not a scanned image.',
        });
      }
      const doc = await saveDocument(req.user.id, kind, filename, text);
      return res.status(200).json({ document: doc });
    } catch (err) {
      const status = err.status || 500;
      return res.status(status).json({
        error: err.code || 'upload_error',
        message: err.message || 'Failed to process document upload.',
      });
    }
  }
);

router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const doc = publicDoc(await col('documents').findOne({
      id: Number(req.params.id),
      user_id: req.user.id,
    }));
    if (!doc) return res.status(404).json({ error: 'not_found' });
    await col('documents').deleteOne({ id: doc.id });
    if (doc.is_active) {
      const next = await col('documents')
        .find({ user_id: req.user.id, kind: doc.kind })
        .sort({ id: -1 })
        .limit(1)
        .next();
      if (next) await activateDocument(req.user.id, next.id, doc.kind);
    }
    return res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
