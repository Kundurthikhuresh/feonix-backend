require('dotenv').config();
const { connect } = require('../src/db');

async function runCleanup() {
  const db = await connect();
  console.log('--- CLEANUP SCRIPT STARTED ---');

  // 1. Get all valid real user IDs
  const validUsers = await db.collection('users').find({}).toArray();
  const validUserIds = validUsers.map(u => u.id);
  console.log(`Current registered users count: ${validUsers.length}`);

  // 2. Identify dummy test users
  const dummyUsers = validUsers.filter(u =>
    u.email && (
      u.email.includes('dashfix') ||
      u.email.includes('test_normal') ||
      u.email.includes('example.com')
    )
  );
  if (dummyUsers.length > 0) {
    console.log('Dummy test users found:', dummyUsers.map(u => u.email));
    for (const du of dummyUsers) {
      await db.collection('users').deleteOne({ _id: du._id });
      console.log(`Deleted dummy user: ${du.email}`);
    }
  }

  // Refresh valid user IDs after dummy user deletion
  const activeUsers = await db.collection('users').find({}).toArray();
  const activeUserIds = activeUsers.map(u => u.id);
  console.log(`Active real users count: ${activeUsers.length}`);

  // 3. Clean orphan and dummy test sessions
  const allSessions = await db.collection('call_sessions').find({}).toArray();
  console.log(`Total sessions before cleanup: ${allSessions.length}`);

  const dummySessionIds = [];
  const realSessions = [];

  for (const s of allSessions) {
    const isOrphan = !activeUserIds.includes(s.user_id);
    const isDummyCompany = (s.company === 'Y' && s.role === 'X') ||
      (s.company && s.company.toLowerCase().includes('test co'));

    if (isOrphan || isDummyCompany) {
      dummySessionIds.push(s._id);
    } else {
      realSessions.push(s);
    }
  }

  console.log(`Identified ${dummySessionIds.length} dummy/orphan sessions to remove.`);
  console.log(`Keeping ${realSessions.length} real sessions.`);

  if (dummySessionIds.length > 0) {
    const delResult = await db.collection('call_sessions').deleteMany({
      _id: { $in: dummySessionIds }
    });
    console.log(`Successfully removed ${delResult.deletedCount} duplicate/dummy sessions.`);
  }

  // 4. Verify Remaining Sessions
  const remainingSessions = await db.collection('call_sessions').find({}).toArray();
  console.log(`Remaining real sessions in database: ${remainingSessions.length}`);
  for (const s of remainingSessions) {
    console.log(` - [ID ${s.id}] User ${s.user_id} | ${s.company} | ${s.role} | Status: ${s.status} | Created: ${s.created_at}`);
  }

  console.log('--- CLEANUP COMPLETED SUCCESSFULLY ---');
  process.exit(0);
}

runCleanup().catch(err => {
  console.error('Cleanup error:', err);
  process.exit(1);
});
