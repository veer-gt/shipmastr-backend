import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDropTarget,
  assertLocalDatabaseUrl,
  assertScratchName,
  makeScratchName,
  withGuaranteedScratchCleanup
} from "./db-scratch-guards.mjs";

test("scratch guards accept generated names and reject protected or malformed names", () => {
  const name = makeScratchName("f9943b4", new Date("2026-07-12T07:15:00.000Z"));
  assert.equal(name, "shipmastr_scratch_f9943b4_20260712T071500Z");
  assert.equal(assertScratchName(name), name);
  for (const invalid of ["shipmastr_scratch_", "postgres", "shipmastr_dev", "shipmastr_prod", "shipmastr_scratch_x;DROP DATABASE postgres", "production"]) {
    assert.throws(() => assertScratchName(invalid));
    assert.throws(() => assertDropTarget(invalid));
  }
});

test("local database URL guard rejects remote and Cloud SQL socket targets", () => {
  assert.doesNotThrow(() => assertLocalDatabaseUrl("postgresql://user:password@127.0.0.1:5433/shipmastr_scratch_test"));
  for (const value of [
    "postgresql://user:password@db.example.test:5433/shipmastr_scratch_test",
    "postgresql://user:password@127.0.0.1:5432/shipmastr_scratch_test",
    "postgresql://user:password@127.0.0.1:5433/shipmastr_dev",
    "postgresql://user:password@127.0.0.1:5433/shipmastr_scratch_test?host=/cloudsql/project:region:instance"
  ]) assert.throws(() => assertLocalDatabaseUrl(value));
});

test("guaranteed scratch cleanup runs when the wrapped command fails", async () => {
  const events = [];
  await assert.rejects(() => withGuaranteedScratchCleanup({
    create: async () => { events.push("create"); return "shipmastr_scratch_fixture"; },
    drop: async (name) => { events.push(`drop:${name}`); },
    run: async () => { events.push("run"); throw new Error("expected test failure"); }
  }));
  assert.deepEqual(events, ["create", "run", "drop:shipmastr_scratch_fixture"]);
});
