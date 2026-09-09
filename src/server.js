require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const cors = require('cors');

const { connect, isDbFallback } = require('./db');
const MongoSessionStore = require('./session-store');
const { router: authRouter } = require('./auth');
const adminRouter = require('./admin');
const { router: answerRouter } = require('./answer');
const documentsRouter = require('./documents');
const { router: transcribeRouter } = require('./transcribe');
const { router: historyRouter } = require('./history');
const { router: sessionsRouter } = require('./sessions');
const notesRouter = require('./notes');
const visionRouter = require('./vision');
const { router: handoffRouter } = require('./handoff');

// Career Platform Routes
const profileRouter = require('./profile');
const razorpayRouter = require('./razorpay');
const resumeAiRouter = require('./resume-ai');
const jobAnalyzerRouter = require('./job-analyzer');
const coverLetterRouter = require('./cover-letter');
const interviewPrepRouter = require('./interview-prep');
const applicationsRouter = require('./applications');
const { router: notificationsRouter } = require('./notifications');
const assistantRouter = require('./assistant');

const app = express();
const PORT = Number(process.env.PORT || 4000);
const isProduction = process.env.NODE_ENV === 'production';
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:3001';

app.disable('x-powered-by');

if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY));

const allowedOrigins = [
  FRONTEND_ORIGIN,
  'http://localhost:3001',
  'http://localhost:3000',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:3000',
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, true);
    }
  },
  credentials: true,
}));

// Razorpay webhook MUST receive raw body — register BEFORE express.json()
app.use('/api/razorpay/webhook', express.raw({ type: 'application/json' }));

app.use('/api/vision', express.json({ limit: '32mb' }));
app.use(express.json({ limit: '4mb' }));

let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  if (isProduction) {
    console.error('SESSION_SECRET is required in production. Refusing to start.');
    process.exit(1);
  }
  sessionSecret = crypto.randomBytes(32).toString('hex');
  console.warn('SESSION_SECRET not set — using a random one. Sessions reset on restart.');
}

app.use(
  session({
    name: 'sid',
    secret: sessionSecret,
    store: new MongoSessionStore(),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProduction,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/answer', answerRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/transcribe', transcribeRouter);
app.use('/api/history', historyRouter);
app.use('/api/vision', visionRouter);
app.use('/api/sessions', handoffRouter);
app.use('/api/sessions', notesRouter);
app.use('/api/sessions', sessionsRouter);

// Career Platform Routes
app.use('/api/profile', profileRouter);
app.use('/api/razorpay', razorpayRouter);
app.use('/api/resume', resumeAiRouter);
app.use('/api/job', jobAnalyzerRouter);
app.use('/api/cover-letter', coverLetterRouter);
app.use('/api/interview-prep', interviewPrepRouter);
app.use('/api/applications', applicationsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/assistant', assistantRouter);

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    openai_configured: Boolean(process.env.OPENAI_API_KEY),
    // true here means this process couldn't reach MongoDB Atlas at startup
    // and is serving an empty, volatile in-memory store instead — every
    // account/session it reports is invisible to every other process and
    // gone on restart. A quick way to catch that class of bug instead of
    // rediscovering it via "my data disappeared".
    db_fallback: isDbFallback(),
  });
});

app.get(['/download/:platform', '/api/download/:platform'], (req, res) => {
  const platform = req.params.platform.toLowerCase();
  const distDir = path.join(__dirname, '..', '..', 'desktop-electron', 'dist');
  const fs = require('fs');

  if (!fs.existsSync(distDir)) {
    return res.status(404).send('No built installers found.');
  }

  const files = fs.readdirSync(distDir);
  let candidates = [];
  if (platform === 'mac' || platform === 'dmg') {
    candidates = files.filter((f) => f.endsWith('.dmg') || f.endsWith('.zip'));
  } else if (platform === 'win' || platform === 'exe') {
    candidates = files.filter((f) => f.endsWith('.exe') && !f.startsWith('__uninstaller'));
  }
  if (!candidates.length) {
    return res.status(404).send(`No installer binary found for ${platform}.`);
  }
  // electron-builder never cleans up a previous version's output in dist/,
  // so multiple installer files can sit side by side — picking the first
  // one alphabetically ("...0.1.0.exe" before "...0.2.0.exe") served the
  // same stale build no matter how many times a newer one was built. The
  // most recently modified file is always the one from the last build.
  const targetFile = candidates
    .map((f) => ({ f, mtime: fs.statSync(path.join(distDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0].f;
  return res.download(path.join(distDir, targetFile));
});

app.use((req, res) => {
  res.status(404).json({ error: 'not_found' });
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return res.end();
  return res
    .status(err.status || 500)
    .json({ error: err.code || 'server_error', message: err.message || 'Something went wrong.' });
});

async function start() {
  await connect();
  app.listen(PORT, () => {
    console.log(`feonixai api listening on http://localhost:${PORT}`);
  });
}

if (require.main === module) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = app;
