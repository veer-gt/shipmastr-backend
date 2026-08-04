import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "@prisma/client";

import { SHIPMASTR_OWNER_MASTER_ADMIN_EMAIL } from "../../lib/masterAdmin.js";
import {
  reconcileShipmastrOwnerMasterAdmin,
  SHIPMASTR_OWNER_RECONCILIATION_ACTION
} from "./owner-master-admin-reconciliation.service.js";

type FakeUser = {
  id: string;
  email: string;
  role: string;
  userType: string;
};

type AuditInput = {
  action: string;
  entityType: string;
  entityId?: string;
  metadata?: unknown;
};

function createHarness(initialUser: FakeUser | null, options: { failAudit?: boolean } = {}) {
  let persisted = initialUser ? { ...initialUser } : null;
  let updateCount = 0;
  const auditRows: AuditInput[] = [];

  const client = {
    async $transaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) {
      let draft = persisted ? { ...persisted } : null;

      const tx = {
        user: {
          async findUnique(input: { where: { email: string } }) {
            if (!draft || draft.email !== input.where.email) return null;
            return { ...draft };
          },
          async update(input: {
            where: { id: string };
            data: { role: string; userType: string };
          }) {
            if (!draft || draft.id !== input.where.id) throw new Error("USER_NOT_FOUND");
            updateCount += 1;
            draft = { ...draft, ...input.data };
            return { ...draft };
          }
        }
      } as unknown as Prisma.TransactionClient;

      const result = await operation(tx);
      persisted = draft;
      return result;
    }
  };

  const auditWriter = async (auditInput: AuditInput) => {
    if (options.failAudit) throw new Error("AUDIT_WRITE_FAILED");
    auditRows.push(auditInput);
    return {} as never;
  };

  return {
    client: client as never,
    auditWriter: auditWriter as never,
    getUser: () => persisted ? { ...persisted } : null,
    getUpdateCount: () => updateCount,
    auditRows
  };
}

const input = {
  operator: "security-operator@shipmastr.com",
  reason: "Restore the permanent Shipmastr owner authority.",
  source: "unit-test"
};

test("reconciles only the permanent Shipmastr owner and writes the mandatory audit event", async () => {
  const harness = createHarness({
    id: "owner_1",
    email: SHIPMASTR_OWNER_MASTER_ADMIN_EMAIL,
    role: "ADMIN",
    userType: "INTERNAL_SHIPMASTR"
  });

  const result = await reconcileShipmastrOwnerMasterAdmin(input, harness);

  assert.equal(result.changed, true);
  assert.deepEqual(harness.getUser(), {
    id: "owner_1",
    email: SHIPMASTR_OWNER_MASTER_ADMIN_EMAIL,
    role: "MASTER_ADMIN",
    userType: "INTERNAL_SHIPMASTR"
  });
  assert.equal(harness.auditRows.length, 1);
  assert.equal(harness.auditRows[0]?.action, SHIPMASTR_OWNER_RECONCILIATION_ACTION);
  assert.deepEqual(harness.auditRows[0]?.metadata, {
    ownerEmail: SHIPMASTR_OWNER_MASTER_ADMIN_EMAIL,
    previousRole: "ADMIN",
    previousUserType: "INTERNAL_SHIPMASTR",
    nextRole: "MASTER_ADMIN",
    nextUserType: "INTERNAL_SHIPMASTR",
    operator: input.operator,
    reason: input.reason,
    source: input.source
  });
});

test("is idempotent when the owner already has the exact permanent authority", async () => {
  const harness = createHarness({
    id: "owner_1",
    email: SHIPMASTR_OWNER_MASTER_ADMIN_EMAIL,
    role: "MASTER_ADMIN",
    userType: "INTERNAL_SHIPMASTR"
  });

  const first = await reconcileShipmastrOwnerMasterAdmin(input, harness);
  const second = await reconcileShipmastrOwnerMasterAdmin(input, harness);

  assert.equal(first.changed, false);
  assert.equal(second.changed, false);
  assert.equal(harness.getUpdateCount(), 0);
  assert.equal(harness.auditRows.length, 0);
});

test("rolls back the owner role change when the mandatory audit write fails", async () => {
  const original = {
    id: "owner_1",
    email: SHIPMASTR_OWNER_MASTER_ADMIN_EMAIL,
    role: "ADMIN",
    userType: "SELLER_ACCOUNT"
  };
  const harness = createHarness(original, { failAudit: true });

  await assert.rejects(
    reconcileShipmastrOwnerMasterAdmin(input, harness),
    /AUDIT_WRITE_FAILED/
  );

  assert.deepEqual(harness.getUser(), original);
  assert.equal(harness.auditRows.length, 0);
});

test("never redirects reconciliation to another email", async () => {
  const other = {
    id: "other_1",
    email: "other-admin@shipmastr.com",
    role: "ADMIN",
    userType: "INTERNAL_SHIPMASTR"
  };
  const harness = createHarness(other);

  await assert.rejects(
    reconcileShipmastrOwnerMasterAdmin(input, harness),
    /SHIPMASTR_OWNER_ACCOUNT_NOT_FOUND/
  );

  assert.deepEqual(harness.getUser(), other);
  assert.equal(harness.getUpdateCount(), 0);
  assert.equal(harness.auditRows.length, 0);
});
