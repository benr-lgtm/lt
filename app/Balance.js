"use client";

import Link from "next/link";

// The balance chip in the header.
//
// This used to expand into a dropdown holding the whole ledger. That was the
// wrong container for it: a dropdown closes when you click away, can't be
// linked to or bookmarked, and had to stay short enough not to swallow the
// screen — while the thing inside it was a list you scroll and read back over.
// It now links to /history, which holds billing AND past loads together,
// because "what did that load cost" and "what did we run yesterday" are the
// same question asked twice.

const money = (cents) => {
  const v = (Math.abs(cents) / 100).toFixed(2);
  return `${cents < 0 ? "−" : ""}$${v}`;
};

export default function Balance({ balanceCents }) {
  const balance = balanceCents ?? 0;
  const negative = balance < 0;
  const low = !negative && balance < 200;

  return (
    <Link
      href="/history"
      className={"balance-btn" + (negative ? " negative" : low ? " low" : "")}
      title={
        negative
          ? "Balance owing — tracking continues. Open history and billing."
          : "Open history and billing"
      }
    >
      {money(balance)}
      <span className="balance-caret">›</span>
    </Link>
  );
}
