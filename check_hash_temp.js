const dns = require('dns');
if (process.platform === 'win32') {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
}
const { MongoClient } = require('mongodb');
const bcrypt = require('bcrypt');

const uri = 'mongodb+srv://feonix:feonixdileep@cluster0.zzwqedw.mongodb.net/?appName=Cluster0';

async function main() {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db('feonixai');
    const user = await db.collection('users').findOne({ email: 'khuresh@gmail.com' });
    if (!user) {
      console.log('User not found!');
      return;
    }
    console.log('User found:', user.email);
    console.log('Password hash in DB:', user.password_hash);
    
    // Test comparison
    const password = 'Khuresh@1234';
    console.log('Comparing with password:', password);
    const result = await bcrypt.compare(password, user.password_hash);
    console.log('Bcrypt comparison result:', result);
  } catch (err) {
    console.error('Error during test:', err);
  } finally {
    await client.close();
  }
}

main();
