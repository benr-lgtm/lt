// Per-row billing.
//
// One tracked stop costs $2, charged ONCE, ON COMPLETION — when the truck is
// confirmed Arrived, or when the driver is marked Checked IN. A load with both
// a pickup and a delivery is two rows, so $4; the arithmetic falls out of the
// row model rather than being special-cased.
//
// Billing on completion rather than on the first check is a deliberate promise:
// the customer pays for a delivered answer, not for the attempt. A load that
// never completes — driver goes dark, load cancelled, row cleared mid-trip — is
// never billed. The provider cost of tracking an abandoned row is a fraction of
// a cent, which is a cheap price for a rule that needs no explaining.
//
// The balance is allowed to go negative. Tracking is never withheld over money:
// a dispatcher discovering mid-run that a load stopped being watched because a
// balance dipped is a far worse outcome than an invoice to settle later.
//
// Idempotency is enforced by the DATABASE, not by this code: there is a partial
// unique index on credit_transactions(load_id, cycle) WHERE kind = 'charge'.
// A retry storm, a double-fired cron, or two concurrent workers physically
// cannot charge the same row twice — the second insert raises 23505 and we
// treat that as "already paid", which is exactly right.

export const ROW_COST_CENTS = 200;

// What a charge line should say in the ledger. The truck number and where it
// went are the two things that let someone reconcile a statement against their
// own records months later, so both go in the note rather than a row id.
export function chargeNote(load) {
  const truck = load.truck_number ? `Truck # ${load.truck_number}` : "Shared truck";
  const kind = load.kind === "pickup" ? "PU" : "DEL";
  const where = load.destination || load.name || "";
  return `${truck} · ${kind}${where ? ` · ${where}` : ""}`.slice(0, 180);
}

/**
 * Charge for a completed row, if it hasn't been charged for this cycle yet.
 * Returns { charged, reason }.
 *
 * Call this ONLY once the row has actually finished — see completion handling
 * in app/api/check/route.js and app/api/loads/checkin/route.js. Calling it
 * mid-trip would reintroduce the thing this design exists to avoid.
 */
export async function chargeForRow(serviceSupabase, load) {
  if (load.charged_at) return { charged: false, reason: "already_charged" };

  const { data: profile } = await serviceSupabase
    .from("profiles")
    .select("balance_cents")
    .eq("id", load.user_id)
    .maybeSingle();

  if (!profile) return { charged: false, reason: "no_profile" };

  // Note the absence of a balance check. The work is already done and the
  // answer already delivered; refusing to record the charge here would mean
  // giving the row away for free, not collecting later.
  const { error } = await serviceSupabase.from("credit_transactions").insert({
    user_id: load.user_id,
    amount_cents: -ROW_COST_CENTS,
    kind: "charge",
    load_id: load.id,
    cycle: load.cycle ?? 0,
    note: chargeNote(load),
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
