// Automatic promised-date follow-up scheduler. Same business rules as server.js
// runAutomaticFollowups(): Mon-Fri, India time, morning 10:00-12:00 and evening 17:00-19:00 slots,
// one attempt per invoice per slot, one invoice per tick, stuck 'calling' invoices retried after 90 min,
// dry-run never calls Bolna.
// What changed: (1) state lives in Supabase, (2) the "one attempt per invoice per slot" lock is the
// atomic UNIQUE insert in followup_attempts, so several function instances can never double-call.
import * as store from './store.mjs';
import { requestBolnaCall } from './bolna.mjs';
import { getIndiaTime } from './helpers.mjs';
import { env } from './env.mjs';

const FOLLOWUP_SLOTS = [
  { name: 'morning', startHour: 10, endHour: 12 },
  { name: 'evening', startHour: 17, endHour: 19 }
];
const STUCK_CALL_MINUTES = 90;
const EXCLUDED_STATUS = ['paid', 'paid_on_call', 'payment done', 'disputed', 'refused', 'wrong_number', 'human_review', 'needs_human_review'];

async function runAutomaticFollowups(deps = {}) {
  const d = { store, requestBolnaCall, getIndiaTime, log: console.log, ...deps };
  const enabled = env('AUTO_FOLLOWUP_ENABLED') === 'true';
  const dryRun = env('AUTO_FOLLOWUP_DRY_RUN') === 'true';
  if (!enabled && !dryRun) return { ran: false, reason: 'disabled' };

  const now = d.getIndiaTime();
  if (now.weekday === 'Sat' || now.weekday === 'Sun') {
    if (dryRun) d.log('[DRY RUN] Skipping: weekend in India.');
    return { ran: false, reason: 'weekend' };
  }
  const slot = FOLLOWUP_SLOTS.find((s) => now.hour >= s.startHour && now.hour < s.endHour);
  if (!slot) {
    if (dryRun) d.log(`[DRY RUN] Outside calling windows. India time: ${now.hour}:${String(now.minute).padStart(2, '0')}`);
    return { ran: false, reason: 'outside-window' };
  }

  const stuckCutoff = Date.now() - STUCK_CALL_MINUTES * 60 * 1000;
  const [candidates, already] = await Promise.all([
    d.store.listFollowupCandidates(now.date),
    d.store.attemptedInvoiceIds(now.date, slot.name)
  ]);

  const eligible = candidates.filter((ci) => {
    if (already.has(ci.id)) return false;
    if (String(ci.payment_state || 'pending') === 'done') return false;
    const status = String(ci.payment_status || 'pending').toLowerCase();
    if (EXCLUDED_STATUS.includes(status)) return false;
    if (status === 'calling' && ci.last_call_at && new Date(ci.last_call_at).getTime() >= stuckCutoff) return false;
    return true;
  });

  const inv = eligible[0]; // at most one invoice per tick
  if (!inv) {
    if (dryRun) d.log(`[DRY RUN] No eligible invoice found for ${now.date} (${slot.name} slot).`);
    return { ran: true, slot: slot.name, action: 'none' };
  }

  if (dryRun) {
    d.log('[DRY RUN] Eligible invoice found. NO CALL SENT.', {
      invoiceId: inv.id, customerName: inv.customer_name, promisedPayDate: inv.promised_pay_date,
      paymentStatus: inv.payment_status, slot: slot.name, dateChecked: now.date
    });
    return { ran: true, slot: slot.name, action: 'dry-run', invoiceId: inv.id };
  }

  const attempt = await d.store.reserveAttempt(inv.id, now.date, slot.name);
  if (!attempt) return { ran: true, slot: slot.name, action: 'lost-race', invoiceId: inv.id }; // another instance has it

  try {
    const executionId = await d.requestBolnaCall(inv);
    await d.store.updateAttempt(attempt.id, { status: 'requested', execution_id: executionId });
    d.log('Automatic follow-up requested:', { invoiceId: inv.id, executionId, date: now.date, slot: slot.name });
    return { ran: true, slot: slot.name, action: 'called', invoiceId: inv.id, executionId };
  } catch (err) {
    await d.store.updateAttempt(attempt.id, { status: 'failed', error_message: String(err.message || 'Call request failed').slice(0, 500) })
      .catch((e) => console.error('Could not record failed attempt:', e.message));
    console.error('Automatic follow-up failed:', { invoiceId: inv.id, error: err.message });
    return { ran: true, slot: slot.name, action: 'failed', invoiceId: inv.id };
  }
}

export { runAutomaticFollowups, FOLLOWUP_SLOTS, STUCK_CALL_MINUTES };
