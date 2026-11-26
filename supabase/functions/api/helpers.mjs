// Pure helpers copied VERBATIM from functions/lib/helpers.js (which was copied from server.js). Only change: ESM export.

// ---- Values sent to the Bolna agent as {{variables}} in its prompt ----
const ORDINAL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

function ordinal(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;
}

// 2026-10-09 -> "9th October 2026" (spoken naturally by the agent, never as ISO)
function speakDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return String(iso || '');
  return `${ordinal(Number(m[3]))} ${ORDINAL_MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

function buildUserData(inv) {
  return {
    record_id: String(inv.id),
    customer_name: inv.customer_name,
    invoice_id: inv.invoice_number || `INV-${1000 + inv.id}`,
    amount_due: String(inv.amount_due),
    due_date: speakDate(inv.due_date),
    today_date: speakDate(getIndiaTime().date)
  };
}
// India date helper
function getIndiaTime() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23'
  }).formatToParts(new Date());

  const result = {};

  for (const part of parts) {
    if (part.type !== 'literal') {
      result[part.type] = part.value;
    }
  }

  return {
    date: `${result.year}-${result.month}-${result.day}`,
    hour: Number(result.hour),
    minute: Number(result.minute),
    weekday: result.weekday
  };
}
// Find a field inside nested objects
function findKey(obj, wantedKey) {
  if (!obj || typeof obj !== 'object') return null;

  if (
    Object.prototype.hasOwnProperty.call(obj, wantedKey)
  ) {
    return obj[wantedKey];
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') {
      const found = findKey(value, wantedKey);

      if (found !== null && found !== undefined) {
        return found;
      }
    }
  }

  return null;
}

// Read the actual extracted value.
// Bolna wraps each field like:
//   { objective: null, confidence: 0.9, subjective: "promised_to_pay", reasoning_subjective: "..." }
// Only the answer keys are read, in this order. Never loop over the other keys:
// that is how the confidence score (0.9) used to be mistaken for the answer.
const ANSWER_KEYS = ['subjective', 'objective', 'value', 'answer'];

function getObjective(value) {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value).trim();
  }

  if (!value || typeof value !== 'object') return '';

  for (const key of ANSWER_KEYS) {
    if (value[key] != null) {
      const result = getObjective(value[key]);
      if (result) return result;
    }
  }

  return '';
}

// First non-empty value among several possible field names
// (the Bolna extraction names have changed over time).
function getField(extracted, ...names) {
  for (const name of names) {
    const result = getObjective(findKey(extracted, name));
    if (result) return result;
  }
  return '';
}

// extracted_data can arrive as an object or as a JSON string
function parseExtracted(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch (e) { return {}; }
  }
  return typeof value === 'object' ? value : {};
}

// Convert ISO or written English dates to YYYY-MM-DD.
// Accepts: 2026-10-14, 14 October 2026 (also 14th October, 2026), October 14, 2026
const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
};
const MONTH_NAMES = Object.keys(MONTHS).join('|');

function toIsoDay(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizeDate(value) {
  if (!value) return null;

  const text = String(value);

  let match = text.match(
    /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/
  );

  if (match) {
    return toIsoDay(match[1], match[2], match[3]);
  }

  // 14 October 2026
  match = text.match(
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAMES})[,]?\\s+(20\\d{2})\\b`, 'i')
  );

  if (match) {
    return toIsoDay(match[3], MONTHS[match[2].toLowerCase()], match[1]);
  }

  // October 14, 2026
  match = text.match(
    new RegExp(`\\b(${MONTH_NAMES})\\s+(\\d{1,2})(?:st|nd|rd|th)?[,]?\\s+(20\\d{2})\\b`, 'i')
  );

  if (match) {
    return toIsoDay(match[3], MONTHS[match[1].toLowerCase()], match[2]);
  }

  // 24th October / October 24 (no year): use the current year in India,
  // or next year if that date is more than 60 days in the past.
  match = text.match(
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAMES})\\b`, 'i')
  ) || null;
  let day, month;
  if (match) {
    day = match[1]; month = MONTHS[match[2].toLowerCase()];
  } else {
    const alt = text.match(
      new RegExp(`\\b(${MONTH_NAMES})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i')
    );
    if (alt) { month = MONTHS[alt[1].toLowerCase()]; day = alt[2]; }
  }

  if (day && month) {
    const today = getIndiaTime().date;
    let year = Number(today.slice(0, 4));
    const candidate = new Date(`${toIsoDay(year, month, day)}T00:00:00Z`);
    const diffDays = (candidate - new Date(`${today}T00:00:00Z`)) / 86400000;
    if (diffDays < -60) year += 1;
    return toIsoDay(year, month, day);
  }

  return null;
}

// Only use the dedicated promised-date extraction.
// Never guess a promised date from a transcript, a reasoning field or the
// invoice due date: a wrong guess would trigger follow-up calls on the wrong day.
function findPromisedDate(data) {
  if (!data || typeof data !== 'object') return null;

  return normalizeDate(
    getField(data, 'promised_pay_date', 'promised_payment_date')
  );
}

// ---- Payment state & payment mode (decided from the conversation) ----
const PAID_OUTCOMES = ['paid', 'paid_on_call', 'payment_done'];
const PENDING_OUTCOMES = ['promised_to_pay', 'callback_requested', 'disputed', 'refused'];

// pending | done | unclear. Returns null when the call gave no new information
// (unanswered / failed), so the previous state is kept.
// Change the rules here if you want different behaviour.
function derivePaymentState(callStatus, rawOutcome) {
  if (callStatus !== 'completed') return null;
  if (PAID_OUTCOMES.includes(rawOutcome)) return 'done';
  if (PENDING_OUTCOMES.includes(rawOutcome)) return 'pending';
  if (rawOutcome === 'no_answer') return null;
  return 'unclear';   // wrong number, or the answer could not be understood
}

const MODE_PATTERNS = [
  ['UPI', /\b(upi|gpay|g pay|google ?pay|phone ?pe|paytm|bhim)\b/i],
  ['Bank transfer', /\b(neft|rtgs|imps|net ?banking|bank transfer|online transfer|wire transfer)\b/i],
  ['Cheque', /\b(cheque|check)\b/i],
  ['Cash', /\bcash\b/i],
  ['Card', /\b(card|credit card|debit card)\b/i]
];

function normalizePaymentMode(value) {
  const text = String(value || '').trim().replace(/[_-]+/g, ' ');
  if (!text || /^(none|null|n\/a|na|unknown|not (stated|mentioned|specified|provided)|no answer)$/i.test(text)) {
    return null;
  }
  for (const [label, pattern] of MODE_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  if (/\bbank\b/i.test(text)) return 'Bank transfer';
  return 'Other';
}

// Fallback when the Bolna agent did not extract payment_mode:
// look only at what the CUSTOMER said (never the agent's script).
function paymentModeFromTranscript(transcript) {
  if (!transcript) return null;
  const customerText = String(transcript)
    .split(/\n+/)
    .filter((line) => /^\s*(user|customer|human)\s*:/i.test(line))
    .join(' ');
  for (const [label, pattern] of MODE_PATTERNS) {
    if (pattern.test(customerText)) return label;
  }
  return null;
}

const FAILED = [
  'failed',
  'error',
  'canceled',
  'cancelled',
  'stopped',
  'balance-low'
];

const UNANSWERED = [
  'no-answer',
  'no_answer',
  'busy'
];

export {
  ORDINAL_MONTHS, ordinal, speakDate, buildUserData, getIndiaTime,
  findKey, getObjective, getField, parseExtracted, normalizeDate, findPromisedDate,
  derivePaymentState, normalizePaymentMode, paymentModeFromTranscript,
  FAILED, UNANSWERED, PAID_OUTCOMES, PENDING_OUTCOMES
};
