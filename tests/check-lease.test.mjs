import { test } from "node:test";
import assert from "node:assert/strict";
import { acquireCheckLease, releaseCheckLease } from "../lib/checkLease.js";

function database() {
  const row = { id: 1, check_lease_token: null, check_lease_until: null };
  let releaseError = null;
  const db = {
    row,
    setReleaseError(value) { releaseError = value; },
    from() {
      let patch;
      let token;
      let acquiring = false;
      const query = {
        update(value) { patch = value; return this; },
        eq(field, value) { if (field === "check_lease_token") token = value; return this; },
        is() { return this; },
        or() { acquiring = true; return this; },
        select() { return this; },
        async maybeSingle() {
          if (acquiring && row.check_lease_until && Date.parse(row.check_lease_until) >= Date.now()) {
            return { data: null, error: null };
          }
          Object.assign(row, patch);
          return { data: { ...row }, error: null };
        },
        then(resolve, reject) {
          if (!releaseError && token === row.check_lease_token) Object.assign(row, patch);
          return Promise.resolve({ error: releaseError }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  return db;
}

test("overlapping checks cannot claim the same unexpired lease", async () => {
  const db = database();
  const first = await acquireCheckLease(db, 1);
  assert.ok(first.token);
  assert.equal(await acquireCheckLease(db, 1), null);
  await releaseCheckLease(db, 1, "wrong-token");
  assert.equal(await acquireCheckLease(db, 1), null);
  await releaseCheckLease(db, 1, first.token);
  assert.ok(await acquireCheckLease(db, 1));
});

test("an expired lease can be reclaimed", async () => {
  const db = database();
  db.row.check_lease_token = "old";
  db.row.check_lease_until = "2000-01-01T00:00:00.000Z";
  assert.ok(await acquireCheckLease(db, 1));
});

test("lease release errors are surfaced", async () => {
  const db = database();
  const lease = await acquireCheckLease(db, 1);
  db.setReleaseError({ code: "test", message: "failed" });
  const original = console.error;
  console.error = () => {};
  try {
    await assert.rejects(releaseCheckLease(db, 1, lease.token), /could not be released/);
  } finally {
    console.error = original;
  }
});
