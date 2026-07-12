import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import {
  AUTH_ABUSE_POLICY,
  accountScope,
  getAuthAbuseStatus,
  networkScope,
  recordAuthFailure,
  resetAuthAccountFailures
} from "./auth-abuse.service.js";

const enabled = process.env.RUN_SCRATCH_DB_TESTS === "1";

function assertScratchUrl() {
  const raw = process.env.DATABASE_URL ?? "";
  const url = new URL(raw);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname.toLowerCase()));
  assert.equal(url.port, "5433");
  assert.match(url.pathname.slice(1), /^shipmastr_scratch_[a-zA-Z0-9_]+$/);
  return url;
}

if (enabled) {
  test("live H1 auth-abuse state is isolated to a scratch database and remains atomic under concurrency", async () => {
    const url = assertScratchUrl();
    const client = new PrismaClient();
    const now = new Date("2026-07-12T10:00:00.000Z");
    const accountKey = "scratch-account-fixture";
    const networkKey = "scratch-network-fixture";
    try {
      const connected = await client.$queryRaw<Array<{ name: string; port: string }>>`SELECT current_database() AS name, current_setting('port') AS port`;
      assert.equal(connected[0]?.name, decodeURIComponent(url.pathname.slice(1)));
      assert.match(connected[0]?.name ?? "", /^shipmastr_scratch_[a-zA-Z0-9_]+$/);
      assert.equal(connected[0]?.port, "5432");

      const parallel = 16;
      const results = await Promise.all(Array.from({ length: parallel }, () => recordAuthFailure({ accountKey, networkKey, now, client })));
      assert.equal(results.length, parallel);
      const account = await client.authAbuseState.findUnique({ where: { scopeKey: accountScope(accountKey) } });
      const network = await client.authAbuseState.findUnique({ where: { scopeKey: networkScope(networkKey) } });
      assert.equal(account?.attempts, parallel);
      assert.equal(network?.attempts, parallel);
      assert.ok(account?.lockUntil);
      assert.equal(results.filter((result) => result.shouldNotify).length, 1);
      assert.ok(results.every((result) => result.delayMs <= AUTH_ABUSE_POLICY.delayCapMs));
      assert.equal((await getAuthAbuseStatus({ accountKey, networkKey, now, client })).blocked, true);
    } finally {
      await resetAuthAccountFailures(accountKey, client);
      await client.authAbuseState.deleteMany({ where: { scopeKey: networkScope(networkKey) } });
      await client.$disconnect();
    }
  });

  test("live H1 reset and expiry paths affect only scratch rows", async () => {
    assertScratchUrl();
    const client = new PrismaClient();
    const accountKey = "scratch-expiry-fixture";
    const networkKey = "scratch-expiry-network";
    const oldWindow = new Date("2025-01-01T00:00:00.000Z");
    const now = new Date("2026-07-12T10:00:00.000Z");
    try {
      const current = await client.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
      assert.match(current[0]?.name ?? "", /^shipmastr_scratch_[a-zA-Z0-9_]+$/);
      await client.authAbuseState.create({ data: {
        scopeKey: accountScope(accountKey), routeClass: AUTH_ABUSE_POLICY.routeClass,
        windowStart: oldWindow, attempts: 99
      } });
      const next = await recordAuthFailure({ accountKey, networkKey, now, client });
      assert.equal(next.accountAttempts, 1);
      await resetAuthAccountFailures(accountKey, client);
      assert.equal((await getAuthAbuseStatus({ accountKey, networkKey, now, client })).accountAttempts, 0);
      await assert.rejects(() => client.$transaction(async (tx) => {
        await tx.authAbuseState.create({ data: {
          scopeKey: accountScope("scratch-rollback-fixture"), routeClass: AUTH_ABUSE_POLICY.routeClass,
          windowStart: now, attempts: 1
        } });
        throw new Error("intentional scratch rollback");
      }));
      assert.equal(await client.authAbuseState.findUnique({ where: { scopeKey: accountScope("scratch-rollback-fixture") } }), null);
    } finally {
      await client.authAbuseState.deleteMany({ where: { scopeKey: { in: [accountScope(accountKey), networkScope(networkKey), accountScope("scratch-rollback-fixture")] } } });
      await client.$disconnect();
    }
  });
}
