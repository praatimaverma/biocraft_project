// A fake Tally XML server for testing the sync WITHOUT the client's Tally.
//   node scripts/mock-tally.js            serves on http://localhost:9000
//   node scripts/mock-tally.js 9100       other port
//   Set MOCK_DROP=1 to leave out the Gupta invoice (simulates a customer paying in Tally).
// The XML mimics TallyPrime's "Bills Receivable" and Ledger collection exports.
const http = require('http');
const port = Number(process.argv[2]) || 9000;

const bills = [
  { party: 'Sharma Labs & Co', ref: 'BC/24-25/101', date: '5-Sep-26', amt: '-35,000.00', due: '5-Oct-26' },
  { party: 'Verma Diagnostics', ref: 'BC/24-25/117', date: '12-Sep-26', amt: '-1,20,450.50', due: '12-Oct-26' },
  { party: 'Gupta Research Pvt Ltd', ref: 'BC/24-25/130', date: '1-Oct-26', amt: '-8,200.00', due: '31-Oct-26' },
  { party: 'Advance Customer', ref: 'ADV-1', date: '2-Oct-26', amt: '5,000.00', due: '2-Oct-26' }
];
const ledgers = [
  { name: 'Sharma Labs & Co', mobile: '98765 43210', phone: '' },
  { name: 'Verma Diagnostics', mobile: '', phone: '011-23456789, 9811122233' },
  { name: 'Gupta Research Pvt Ltd', mobile: '+91 90000 11111', phone: '' }
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

function billsXml() {
  const list = process.env.MOCK_DROP ? bills.slice(0, -2).concat(bills.slice(-1)) : bills;
  return '<ENVELOPE>' + list.map((b) =>
    `<BILLFIXED><BILLDATE>${b.date}</BILLDATE><BILLREF>${esc(b.ref)}</BILLREF><BILLPARTY>${esc(b.party)}</BILLPARTY></BILLFIXED>` +
    `<BILLCL>${b.amt}</BILLCL><BILLDUE>${b.due}</BILLDUE><BILLOVERDUE>0</BILLOVERDUE>`).join('') + '</ENVELOPE>';
}
function ledgersXml() {
  return '<ENVELOPE><BODY><DATA><COLLECTION>' + ledgers.map((l) =>
    `<LEDGER NAME="${esc(l.name)}"><LEDGERPHONE>${l.phone}</LEDGERPHONE><LEDGERMOBILE>${l.mobile}</LEDGERMOBILE></LEDGER>`).join('') +
    '</COLLECTION></DATA></BODY></ENVELOPE>';
}

http.createServer((req, res) => {
  if (req.method !== 'POST') { res.end('<RESPONSE>TallyPrime Server is Running (mock)</RESPONSE>'); return; }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('Content-Type', 'text/xml');
    if (/<ID>Bills Receivable<\/ID>/.test(body)) return res.end(billsXml());
    if (/BiocraftLedgerPhones/.test(body)) return res.end(ledgersXml());
    res.end('<RESPONSE><LINEERROR>Unknown request</LINEERROR></RESPONSE>');
  });
}).listen(port, () => console.log(`Mock Tally running on http://localhost:${port}`));
