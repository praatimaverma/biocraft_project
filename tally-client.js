// Talks to TallyPrime / Tally.ERP 9 over its built-in XML-over-HTTP server.
// No npm packages needed (Node 18+ built-in fetch). Used by:
//   - tally-agent/agent.js   (runs on the Tally server, pushes to the app)
//   - scripts/sync-tally.js  (runs next to the app, pulls over VPN)

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function pad(n) { return String(n).padStart(2, '0'); }

// "1-Apr-24", "01-Apr-2024", "20240401", "2024-04-01", "01/04/2024" -> "2024-04-01" ('' if unreadable)
function parseTallyDate(text) {
  const s = String(text || '').trim();
  let m = s.match(/^(\d{1,2})[-\s/]([A-Za-z]{3})[A-Za-z]*[-\s/,]*(\d{2}|\d{4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) {
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    return `${y}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(m[1])}`;
  }
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  return '';
}

// Indian-style numbers: "-1,23,456.50", "12,000.00 Dr", "(500.00)"
function parseAmount(text) {
  let s = String(text || '').trim();
  if (!s) return NaN;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  // "Dr"/"Cr" suffix: Dr = debit (negative in Tally's XML convention), Cr = credit (positive)
  s = s.replace(/\s*(Dr|Cr)\.?$/i, (m0, t) => { if (/dr/i.test(t)) negative = true; return ''; });
  s = s.replace(/[₹,\s]/g, '');
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1); }
  const n = Number(s);
  return Number.isFinite(n) ? (negative ? -n : n) : NaN;
}

// 10-digit Indian numbers become +91XXXXXXXXXX. Returns '' if nothing usable.
// A field may hold several numbers ("011-2345678, 98111 22233"); a mobile number is preferred
// because the app places voice calls.
function normalizePhone(raw) {
  const one = (part) => {
    const hasPlus = part.trim().startsWith('+');
    const d = part.replace(/\D/g, '');
    if (hasPlus && d.length >= 8) return `+${d}`;
    if (d.length === 10) return `+91${d}`;
    if (d.length === 11 && d.startsWith('0')) return `+91${d.slice(1)}`;
    if (d.length === 12 && d.startsWith('91')) return `+${d}`;
    return '';
  };
  const all = String(raw || '').split(/[,;/\n]/).map(one).filter(Boolean);
  return all.find((p) => /^\+91[6-9]\d{9}$/.test(p)) || all[0] || '';
}

function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (m0, n) => { const c = Number(n); return c < 32 && c !== 9 && c !== 10 && c !== 13 ? '' : String.fromCharCode(c); })
    .replace(/&#x([0-9a-f]+);/gi, (m0, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]) : '';
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function postXml(url, xml, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8' },
      body: xml,
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`Tally HTTP ${res.status}`);
    // Tally can answer in UTF-16 or UTF-8; fetch gives bytes, so decode ourselves.
    const buf = Buffer.from(await res.arrayBuffer());
    const text = (buf[0] === 0xff && buf[1] === 0xfe) ? buf.toString('utf16le') : buf.toString('utf8');
    return text.replace(/^﻿/, '');
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Tally did not answer within ${timeoutMs / 1000}s (${url})`);
    throw new Error(`Could not reach Tally at ${url}: ${err.cause ? err.cause.code || err.cause.message : err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

function staticVars(opts, extra = '') {
  return `<STATICVARIABLES>
      <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      ${opts.company ? `<SVCURRENTCOMPANY>${xmlEscape(opts.company)}</SVCURRENTCOMPANY>` : ''}
      ${extra}
    </STATICVARIABLES>`;
}

// The built-in "Bills Receivable" report = the outstanding receivables list.
function billsReceivableRequest(opts) {
  const dates = [
    opts.fromDate ? `<SVFROMDATE>${opts.fromDate}</SVFROMDATE>` : '',
    opts.toDate ? `<SVTODATE>${opts.toDate}</SVTODATE>` : ''
  ].join('');
  return `<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>Bills Receivable</ID></HEADER>
  <BODY><DESC>
    ${staticVars(opts, dates)}
  </DESC></BODY>
</ENVELOPE>`;
}

function ledgerPhonesRequest(opts) {
  return `<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>BiocraftLedgerPhones</ID></HEADER>
  <BODY><DESC>
    ${staticVars(opts)}
    <TDL><TDLMESSAGE>
      <COLLECTION NAME="BiocraftLedgerPhones" ISMODIFY="No">
        <TYPE>Ledger</TYPE>
        <FETCH>Name, Parent, LedgerPhone, LedgerMobile</FETCH>
      </COLLECTION>
    </TDLMESSAGE></TDL>
  </DESC></BODY>
</ENVELOPE>`;
}

// Bills Receivable XML lists, in order, for every bill:
//   <BILLFIXED> (date, ref, party) </BILLFIXED> <BILLCL>closing amount</BILLCL> <BILLDUE>due date</BILLDUE> ...
function parseBillsReceivable(xml, opts = {}) {
  const debitIsNegative = opts.debitIsNegative !== false;
  const re = /<BILLFIXED[^>]*>([\s\S]*?)<\/BILLFIXED>|<BILLCL[^>]*>([\s\S]*?)<\/BILLCL>|<BILLDUE[^>]*>([\s\S]*?)<\/BILLDUE>/gi;
  const bills = [];
  let cur = null;
  let m;
  while ((m = re.exec(xml))) {
    if (m[1] !== undefined) {
      cur = { party: tag(m[1], 'BILLPARTY'), ref: tag(m[1], 'BILLREF'), billDate: tag(m[1], 'BILLDATE'), cl: '', due: '' };
      bills.push(cur);
    } else if (cur && m[2] !== undefined) {
      cur.cl = decode(m[2]);
    } else if (cur && m[3] !== undefined) {
      cur.due = decode(m[3]);
    }
  }

  const stats = { found: bills.length, skippedCredit: 0, skippedIncomplete: 0, sawNegative: false, sawPositive: false };
  const merged = new Map();
  for (const b of bills) {
    const raw = parseAmount(b.cl);
    if (!b.party || !b.ref || !Number.isFinite(raw) || raw === 0) { stats.skippedIncomplete++; continue; }
    if (raw < 0) stats.sawNegative = true; else stats.sawPositive = true;
    const isDebit = debitIsNegative ? raw < 0 : raw > 0;
    if (!isDebit) { stats.skippedCredit++; continue; } // advance / on-account credit, not money owed
    const amount = Math.abs(raw);
    const billDate = parseTallyDate(b.billDate);
    const due = parseTallyDate(b.due) || billDate;
    if (!due) { stats.skippedIncomplete++; continue; }
    const key = `${b.party.toLowerCase()}|${b.ref.toLowerCase()}`;
    const prev = merged.get(key);
    if (prev) { prev.amount_due = Math.round((prev.amount_due + amount) * 100) / 100; if (due < prev.due_date) prev.due_date = due; }
    else merged.set(key, { customer_name: b.party, invoice_number: b.ref, amount_due: amount, due_date: due, bill_date: billDate });
  }

  const warnings = [];
  if (stats.found && !merged.size) {
    warnings.push(stats.skippedCredit
      ? 'Bills were found but all were treated as credits. If amounts show as positive for money owed, set TALLY_DEBIT_IS_NEGATIVE=false.'
      : 'Bills were found but none had a usable party / reference / amount / date. Run with --dump and send me the XML.');
  }
  return { invoices: [...merged.values()], stats, warnings };
}

// ledger name -> best phone number (mobile first, then phone)
function parseLedgerPhones(xml) {
  const phones = new Map();
  const re = /<LEDGER(?:\s[^>]*)?>([\s\S]*?)<\/LEDGER>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const attrName = (m[0].match(/^<LEDGER[^>]*\sNAME="([^"]*)"/i) || [])[1];
    const name = decode(attrName) || tag(m[1], 'NAME');
    const phone = normalizePhone(tag(m[1], 'LEDGERMOBILE')) || normalizePhone(tag(m[1], 'LEDGERPHONE'));
    if (name && phone) phones.set(name.toLowerCase(), phone);
  }
  return phones;
}

// Returns { invoices, warnings, stats, raw: {bills, ledgers} }
async function fetchOutstanding(opts = {}) {
  const url = (opts.url || 'http://localhost:9000').replace(/\/+$/, '');
  const warnings = [];
  const billsXml = await postXml(url, billsReceivableRequest(opts));

  const lineErr = billsXml.match(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/i);
  if (lineErr) throw new Error(`Tally refused the request: ${decode(lineErr[1])}. Check the company name and that the company is open.`);

  const parsed = parseBillsReceivable(billsXml, opts);
  warnings.push(...parsed.warnings);
  if (!parsed.stats.found) {
    warnings.push('Tally returned no bills. Either nothing is outstanding or the company is not open / the name is wrong.');
  }

  let ledgersXml = '';
  let phones = new Map();
  try {
    ledgersXml = await postXml(url, ledgerPhonesRequest(opts));
    phones = parseLedgerPhones(ledgersXml);
  } catch (err) {
    warnings.push(`Could not read phone numbers from Tally (${err.message}). Existing phone numbers in the app are kept.`);
  }

  for (const inv of parsed.invoices) inv.phone_number = phones.get(inv.customer_name.toLowerCase()) || '';
  return { invoices: parsed.invoices, warnings, stats: parsed.stats, raw: { bills: billsXml, ledgers: ledgersXml } };
}

module.exports = {
  fetchOutstanding, parseBillsReceivable, parseLedgerPhones,
  parseTallyDate, parseAmount, normalizePhone, billsReceivableRequest
};
