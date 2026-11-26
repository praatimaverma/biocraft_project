// PULL mode: read Tally directly (e.g. over Tailscale/VPN) and update this app's database.
//   node scripts/sync-tally.js            run once
//   node scripts/sync-tally.js --test     show what Tally returns, change nothing
// Needs TALLY_URL (and optionally TALLY_COMPANY) in .env. See README "Tally sync".
require('dotenv').config();
const { fetchOutstanding } = require('../tally-agent/tally-client');
const { applyTallySnapshot } = require('../tallyImport');

async function runTallySync({ test = false } = {}) {
  if (!process.env.TALLY_URL) throw new Error('TALLY_URL is not set in .env');
  const result = await fetchOutstanding({
    url: process.env.TALLY_URL,
    company: process.env.TALLY_COMPANY || '',
    fromDate: process.env.TALLY_FROM_DATE || '',
    toDate: process.env.TALLY_TO_DATE || '',
    debitIsNegative: String(process.env.TALLY_DEBIT_IS_NEGATIVE || 'true').toLowerCase() !== 'false'
  });
  result.warnings.forEach((w) => console.warn('WARNING:', w));
  if (test) {
    console.table(result.invoices.slice(0, 15));
    console.log(`${result.invoices.length} outstanding invoices found. Nothing was saved.`);
    return null;
  }
  const summary = applyTallySnapshot(result.invoices, { complete: result.invoices.length > 0 });
  console.log('Tally sync:', JSON.stringify(summary));
  return summary;
}

module.exports = { runTallySync };

if (require.main === module) {
  runTallySync({ test: process.argv.includes('--test') })
    .then(() => process.exit(0))
    .catch((err) => { console.error('Tally sync failed:', err.message); process.exit(1); });
}
