require('dotenv').config();
const { connect } = require('../src/db');

async function resetToAdminOnly() {
  const db = await connect();
  console.log('=== RESET TO ADMIN ONLY INITIATED ===');

  const adminEmail = 'premchand@gmail.com';
  const adminUser = await db.collection('users').findOne({ email: adminEmail });

  if (!adminUser) {
    console.error(`Admin user ${adminEmail} not found! Aborting.`);
    process.exit(1);
  }

  console.log(`Preserving Admin: ${adminUser.email} (ID: ${adminUser.id})`);

  // 1. Delete all other users
  const deleteUsersResult = await db.collection('users').deleteMany({
    email: { $ne: adminEmail }
  });
  console.log(`Deleted ${deleteUsersResult.deletedCount} non-admin user accounts.`);

  // 2. Delete sessions not belonging to admin
  const deleteSessionsResult = await db.collection('call_sessions').deleteMany({
    user_id: { $ne: adminUser.id }
  });
  console.log(`Deleted ${deleteSessionsResult.deletedCount} non-admin call sessions.`);

  // 3. Delete documents not belonging to admin
  const deleteDocsResult = await db.collection('documents').deleteMany({
    user_id: { $ne: adminUser.id }
  });
  console.log(`Deleted ${deleteDocsResult.deletedCount} non-admin documents.`);

  // 4. Verify remaining database state
  const remainingUsers = await db.collection('users').find({}).toArray();
  console.log(`Remaining Users count: ${remainingUsers.length}`);
  remainingUsers.forEach(u => console.log(` - ${u.email} (${u.role}, ID: ${u.id})`));

  const remainingSessions = await db.collection('call_sessions').countDocuments();
  console.log(`Remaining Call Sessions: ${remainingSessions}`);

  console.log('=== RESET COMPLETED: ADMIN READY FOR NEW USERS ===');
  process.exit(0);
}

resetToAdminOnly().catch(err => {
  console.error('Reset failed:', err);
  process.exit(1);
});
