require('dotenv').config();
const path = require('path');
const bcrypt = require('bcrypt');
const { connect, col, nextId, nowSql } = require('../src/db');
const { BCRYPT_ROUNDS, MIN_PASSWORD_LENGTH, normalizeEmail } = require('../src/auth');

async function provisionAdmin() {
  const args = process.argv.slice(2);
  const emailArg = args[0] || process.env.ADMIN_PROVISION_EMAIL || process.env.ADMIN_EMAIL || 'admin@feonixai.com';
  const passwordArg = args[1] || process.env.ADMIN_PROVISION_PASSWORD || 'FeonixAdmin@2026';

  const email = normalizeEmail(emailArg);
  const password = String(passwordArg || '');

  if (!email || !email.includes('@')) {
    console.error('Error: Please provide a valid email address.');
    process.exit(1);
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(`Error: Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    process.exit(1);
  }

  console.log(`[Admin Provisioning] Connecting to database...`);
  const db = await connect();
  console.log(`[Admin Provisioning] Provisioning administrator account for: ${email}`);

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const usersCollection = col('users');

  const existing = await usersCollection.findOne({ email });

  if (existing) {
    await usersCollection.updateOne(
      { email },
      {
        $set: {
          role: 'owner',
          password_hash: passwordHash,
          disabled: 0,
          updated_at: nowSql(),
        },
      }
    );
    console.log(`[Admin Provisioning] Success: Existing account ${email} updated with ADMIN privileges (role: owner).`);
  } else {
    const id = await nextId('users');
    await usersCollection.insertOne({
      id,
      email,
      password_hash: passwordHash,
      role: 'owner',
      token_quota: 100000,
      disabled: 0,
      created_at: nowSql(),
    });
    console.log(`[Admin Provisioning] Success: Created new ADMIN account ${email} (ID: ${id}, role: owner).`);
  }

  console.log(`[Admin Provisioning] Provisioning complete.`);
  process.exit(0);
}

provisionAdmin().catch((err) => {
  console.error('[Admin Provisioning] Failed:', err);
  process.exit(1);
});

