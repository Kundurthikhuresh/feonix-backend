// One-off repair for the free-trial double charge (two /start requests for one
// session each recorded a TRIAL_CONSUMED row). Keeps the first charge per
// session and relabels the extras so they stop counting. Nothing is deleted:
// set the type back to TRIAL_CONSUMED to undo.
//
//   node scripts/fixDuplicateTrialCharges.js          -> preview only
//   node scripts/fixDuplicateTrialCharges.js --apply  -> make the change

require('dns').setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config({ quiet: true });
const { MongoClient } = require('mongodb');

(async () => {
  const apply = process.argv.includes('--apply');
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const tx = client.db('feonixai').collection('trial_transactions');

  const dups = await tx.aggregate([
    { $match: { type: 'TRIAL_CONSUMED', session_id: { $ne: null } } },
    { $sort: { id: 1 } },
    { $group: { _id: { u: '$user_id', s: '$session_id' }, ids: { $push: '$id' } } },
    { $match: { 'ids.1': { $exists: true } } },
  ]).toArray();

  if (!dups.length) {
    console.log('No double charges found.');
  } else {
    for (const d of dups) {
      console.log(`user ${d._id.u} session ${d._id.s}: keep row ${d.ids[0]}, reverse rows ${d.ids.slice(1).join(',')}`);
    }
    const extra = dups.flatMap((d) => d.ids.slice(1));
    if (apply) {
      const r = await tx.updateMany(
        { id: { $in: extra }, type: 'TRIAL_CONSUMED' },
        { $set: { type: 'TRIAL_CONSUMED_DUPLICATE', reversed_reason: 'double charge for one session', reversed_at: new Date().toISOString() } }
      );
      console.log(`Done: ${r.modifiedCount} duplicate charges reversed.`);
    } else {
      console.log(`Preview only: ${extra.length} duplicate charges would be reversed. Run again with --apply to do it.`);
    }
  }
  await client.close();
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
