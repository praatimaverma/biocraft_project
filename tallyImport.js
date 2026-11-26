// Applies a snapshot of Tally's outstanding receivables to the local invoices table.
// Used by POST /api/tally-sync (agent push) and scripts/sync-tally.js (pull).
//
// Rules:
//  - An invoice is matched by invoice_number + customer name.
//  - Existing invoices only get amount / due date / name / phone refreshed. Call history,
//    promised date, payment mode, dispute notes etc. are never touched.
//  - An invoice that was synced from Tally earlier and is no longer outstanding there is
//    marked as paid (payment_state 'done'), so no more calls go out for it.
//  - Safety: if a snapshot would close an unusually large share of open invoices (or is
//    empty), nothing is closed unless force=true. This protects against a bad/empty export.
const db = require('./db');

const PAID_STATUSES = ['paid', 'paid_on_call', 'payment done', 'payment_done'];

function clean(v) { return String(v == null ? '' : v).trim(); }

function validRow(r) {
  return clean(r.customer_name) && clean(r.invoice_number) &&
    Number.isFinite(Number(r.amount_due)) && Number(r.amount_due) > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(clean(r.due_date));
}

function applyTallySnapshot(rows, { complete = false, force = false } = {}) {
  const now = new Date().toISOString();
  const summary = { received: rows.length, added: 0, updated: 0, reopened: 0, closed: 0, skipped: 0, closeSkippedReason: null };

  const find = db.prepare('SELECT * FROM customers_invoices WHERE invoice_number = ? AND LOWER(customer_name) = LOWER(?)');
  const insert = db.prepare(`
    INSERT INTO customers_invoices
      (customer_name, phone_number, amount_due, due_date, payment_status, payment_state, invoice_number, source, tally_closed, tally_synced_at)
    VALUES (?, ?, ?, ?, 'pending', 'pending', ?, 'tally', 0, ?)`);
  const update = db.prepare(`
    UPDATE customers_invoices
    SET customer_name = ?, amount_due = ?, due_date = ?, phone_number = ?, source = 'tally', tally_synced_at = ?
    WHERE id = ?`);
  const reopen = db.prepare(`
    UPDATE customers_invoices
    SET payment_state = 'pending', payment_status = 'pending', tally_closed = 0
    WHERE id = ?`);

  db.transaction(() => {
    const seen = new Set();

    for (const r of rows) {
      if (!validRow(r)) { summary.skipped++; continue; }
      const name = clean(r.customer_name);
      const inv = clean(r.invoice_number);
      const amount = Math.round(Number(r.amount_due) * 100) / 100;
      const phone = clean(r.phone_number);
      seen.add(`${name.toLowerCase()}|${inv}`);

      const existing = find.get(inv, name);
      if (existing) {
        const keepPhone = phone || existing.phone_number || 'N/A';
        update.run(name, amount, clean(r.due_date), keepPhone, now, existing.id);
        summary.updated++;
        if (existing.tally_closed) { reopen.run(existing.id); summary.reopened++; }
      } else {
        insert.run(name, phone || 'N/A', amount, clean(r.due_date), inv, now);
        summary.added++;
      }
    }

    if (!complete) { summary.closeSkippedReason = 'snapshot not marked complete'; return; }
    if (!seen.size) { summary.closeSkippedReason = 'snapshot has no valid invoices'; return; }

    const open = db.prepare(`
      SELECT id, customer_name, invoice_number, payment_status FROM customers_invoices
      WHERE source = 'tally' AND tally_closed = 0 AND COALESCE(payment_state, 'pending') != 'done'`).all();
    const gone = open.filter((o) => !seen.has(`${String(o.customer_name).toLowerCase()}|${o.invoice_number}`));

    if (!force && gone.length > Math.max(5, Math.floor(open.length * 0.5))) {
      summary.closeSkippedReason = `would mark ${gone.length} of ${open.length} open invoices as paid; looks wrong, so none were changed (run the agent with --force if it is right)`;
      return;
    }

    const close = db.prepare(`
      UPDATE customers_invoices
      SET payment_state = 'done', tally_closed = 1,
          payment_status = CASE WHEN LOWER(COALESCE(payment_status, '')) IN (${PAID_STATUSES.map(() => '?').join(',')})
                                THEN payment_status ELSE 'paid' END
      WHERE id = ?`);
    for (const g of gone) { close.run(...PAID_STATUSES, g.id); summary.closed++; }
  })();

  return summary;
}

module.exports = { applyTallySnapshot };
