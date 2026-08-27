const dns = require('dns');
if (process.platform === 'win32') {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
}

const { MongoClient } = require('mongodb');

const uri = 'mongodb+srv://feonix:feonixdileep@cluster0.zzwqedw.mongodb.net/?appName=Cluster0';

async function main() {
  console.log('Connecting to MongoDB Atlas using SRV with custom DNS resolvers...');
  const client = new MongoClient(uri);
  try {
    await client.connect();
    console.log('Connected successfully!');
    const db = client.db('feonixai');
    const count = await db.collection('users').countDocuments();
    console.log('Users count:', count);
    
    const users = await db.collection('users').find().toArray();
    console.log('Users:');
    users.forEach(u => {
      console.log(`- Email: ${u.email}, Role: ${u.role}, ID: ${u.id}`);
    });
  } catch (err) {
    console.error('Connection failed:', err);
  } finally {
    await client.close();
  }
}

main();
