// Per-row billing.
//
// One tracked stop costs $2, charged ONCE, covering the row from its first
// successful check through Arrived (or through Checked IN when the check-in
// reminder is enabled). A load with both a pickup and a delivery is two rows,
// so $4 — the arithmetic falls out of the row model rather than being special-cased.
//
// Idempotency is enforced by the DATABASE, not by this code: there is a partial
// unique index on credit_transactions(load_id, cycle) WHERE kind = 'charge'.
// A retry storm, a double-fired cron, or two concurrent workers physically
// cannot charge the same row twice — the second insert raises 23505 and we
// treat that as "already paid", which is exactly right.

export const ROW_COST_CENTS = 200;

/**
 * Charge for a row if it hasn't been charged for this cycle yet.
 * Returns { charged, reason }.
 *
 * Called only after a check actually produced a result, so a row that never
 * resolves (bad address, truck not found) is never billed.
 */
export async function chargeForRow(serviceSupabase, load) {
  if (load.charged_at) return { charged: false, reason: "already_charged" };

  const { data: profile } = await serviceSupabase
    .from("profiles")
    .select("balance_cents")
    .eq("id", load.user_id)
    .maybeSingle();

  if (!profile) return { charged: false, reason: "no_profile" };
  if ((profile.balance_cents ?? 0) < ROW_COST_CENTS) {
    return { charged: false, reason: "insufficient_balance" };
  }

  const { error } = await serviceSupabase.from("credit_transactions").insert({
    user_id: load.user_id,
    amount_cents: -ROW_COST_CENTS,
    kind: "charge",
    load_id: load.id,
    cycle: load.cycle ?? 0,
    note: `Tracking: ${load.name || load.truck_number || load.destination || "row"}`,
  });

  if (error) {
    // 23505 = unique violation on credit_charge_once. Another worker beat us
    // to it; the row is paid for either way.
    if (error.code === "23505") {
      await stampCharged(serviceSupabase, load.id);
      return { charged: false, reason: "already_charged" };
    }
    throw error;
  }

  await stampCharged(serviceSupabase, load.id);
  return { charged: true, reason: "charged" };
}

async function stampCharged(serviceSupabase, loadId) {
  await serviceSupabase
    .from("loads")
    .update({ charged_at: new Date().toISOString() })
    .eq("id", loadId)
    .is("charged_at", null);
}

// Admin top-up / bonus. The balance trigger keeps profiles.balance_cents in sync.
export async function credit(serviceSupabase, userId, amountCents, kind = "topup", note = null) {
  const { error } = await serviceSupabase.from("credit_transactions").insert({
    user_id: userId,
    amount_cents: Math.abs(amountCents),
    kind,
    note,
  });
  if (error) throw error;
}
