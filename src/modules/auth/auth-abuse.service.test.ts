import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTH_ABUSE_POLICY,
  accountScope,
  delayForAttempts,
  getAuthAbuseStatus,
  networkScope,
  recordAuthFailure,
  resetAuthAccountFailures
} from "./auth-abuse.service.js";

function fakeClient() {
  const rows = new Map<string, any>();
  const model = {
    async findUnique({ where }: any) { return rows.get(where.scopeKey) ?? null; },
    async upsert({ where, create, update }: any) {
      const current = rows.get(where.scopeKey);
      const next = { id: current?.id ?? `state_${rows.size + 1}`, ...(current ? { ...current, ...update } : create), updatedAt: new Date() };
      rows.set(where.scopeKey, next);
      return next;
    },
    async update({ where, data }: any) {
      const current = rows.get(where.id ? [...rows.values()].find((entry) => entry.id === where.id)?.scopeKey : where.scopeKey);
      if (!current) throw new Error("missing state");
      const next = { ...current };
      for (const [key, value] of Object.entries(data)) next[key] = (value as any)?.increment ? current[key] + (value as any).increment : value;
      rows.set(next.scopeKey, next);
      return next;
    },
    async deleteMany({ where }: any) { rows.delete(where.scopeKey); }
  };
  return {
    authAbuseState: model,
    async $transaction(callback: (tx: any) => Promise<unknown>) { return callback(this); }
  } as any;
}

test("auth abuse failures are shared by network and account scopes", async () => {
  const client = fakeClient();
  const now = new Date("2026-07-12T10:00:00.000Z");
  const first = await recordAuthFailure({ accountKey: "seller@example.com", networkKey: "network-a", now, client });
  assert.equal(first.accountAttempts, 1);
  assert.equal(first.networkAttempts, 1);
  assert.equal((await getAuthAbuseStatus({ accountKey: "seller@example.com", networkKey: "network-a", now, client })).blocked, false);
  assert.equal(accountScope("seller@example.com").length, 64);
  assert.equal(networkScope("network-a").length, 64);
});

test("progressive delay and lockout are bounded and notify once per lock", async () => {
  const client = fakeClient();
  const now = new Date("2026-07-12T10:00:00.000Z");
  let result: any;
  for (let attempt = 0; attempt < AUTH_ABUSE_POLICY.accountLockThreshold; attempt += 1) {
    result = await recordAuthFailure({ accountKey: "seller@example.com", networkKey: `network-${attempt}`, now, client });
  }
  assert.equal(result.locked, true);
  assert.equal(result.shouldNotify, true);
  assert.ok(result.delayMs <= AUTH_ABUSE_POLICY.delayCapMs);
  const next = await recordAuthFailure({ accountKey: "seller@example.com", networkKey: "network-next", now, client });
  assert.equal(next.shouldNotify, false);
});

test("successful login clears account failures", async () => {
  const client = fakeClient();
  const now = new Date("2026-07-12T10:00:00.000Z");
  await recordAuthFailure({ accountKey: "seller@example.com", networkKey: "network-a", now, client });
  await resetAuthAccountFailures("seller@example.com", client);
  const status = await getAuthAbuseStatus({ accountKey: "seller@example.com", networkKey: "network-a", now, client });
  assert.equal(status.accountAttempts, 0);
});

test("delay starts only after the documented threshold", () => {
  assert.equal(delayForAttempts(2), 0);
  assert.equal(delayForAttempts(3), AUTH_ABUSE_POLICY.delayBaseMs);
  assert.equal(delayForAttempts(99), AUTH_ABUSE_POLICY.delayCapMs);
});
