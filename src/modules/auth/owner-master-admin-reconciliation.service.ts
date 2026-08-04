import type { Prisma } from "@prisma/client";

import { SHIPMASTR_OWNER_MASTER_ADMIN_EMAIL } from "../../lib/masterAdmin.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../audit/audit.service.js";

export const SHIPMASTR_OWNER_MASTER_ADMIN_ROLE = "MASTER_ADMIN" as const;
export const SHIPMASTR_OWNER_MASTER_ADMIN_USER_TYPE = "INTERNAL_SHIPMASTR" as const;
export const SHIPMASTR_OWNER_RECONCILIATION_ACTION = "SHIPMASTR_OWNER_MASTER_ADMIN_RECONCILED" as const;

type TransactionHost = {
  $transaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
};

type AuditWriter = (
  input: Parameters<typeof audit>[0],
  client: Prisma.TransactionClient
) => Promise<unknown>;

export type OwnerMasterAdminReconciliationInput = {
  operator: string;
  reason: string;
  source?: string;
};

export type OwnerMasterAdminReconciliationResult = {
  changed: boolean;
  ownerEmail: string;
  userId: string;
  role: typeof SHIPMASTR_OWNER_MASTER_ADMIN_ROLE;
  userType: typeof SHIPMASTR_OWNER_MASTER_ADMIN_USER_TYPE;
};

type ReconciliationDependencies = {
  client?: TransactionHost;
  auditWriter?: AuditWriter;
};

function requiredBounded(value: string, field: string, min: number, max: number) {
  const normalized = String(value || "").trim();
  if (normalized.length < min || normalized.length > max) {
    throw new Error(`${field}_INVALID`);
  }
  return normalized;
}

export async function reconcileShipmastrOwnerMasterAdmin(
  input: OwnerMasterAdminReconciliationInput,
  dependencies: ReconciliationDependencies = {}
): Promise<OwnerMasterAdminReconciliationResult> {
  const operator = requiredBounded(input.operator, "OWNER_RECONCILIATION_OPERATOR", 3, 320);
  const reason = requiredBounded(input.reason, "OWNER_RECONCILIATION_REASON", 10, 500);
  const source = requiredBounded(
    input.source || "offline-owner-reconciliation",
    "OWNER_RECONCILIATION_SOURCE",
    3,
    120
  );

  const client = dependencies.client || (prisma as unknown as TransactionHost);
  const auditWriter = dependencies.auditWriter || audit;

  return client.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({
      where: { email: SHIPMASTR_OWNER_MASTER_ADMIN_EMAIL },
      select: {
        id: true,
        email: true,
        role: true,
        userType: true
      }
    });

    if (!existing) {
      throw new Error("SHIPMASTR_OWNER_ACCOUNT_NOT_FOUND");
    }

    if (
      existing.role === SHIPMASTR_OWNER_MASTER_ADMIN_ROLE
      && existing.userType === SHIPMASTR_OWNER_MASTER_ADMIN_USER_TYPE
    ) {
      return {
        changed: false,
        ownerEmail: existing.email,
        userId: existing.id,
        role: SHIPMASTR_OWNER_MASTER_ADMIN_ROLE,
        userType: SHIPMASTR_OWNER_MASTER_ADMIN_USER_TYPE
      };
    }

    const previousRole = String(existing.role);
    const previousUserType = String(existing.userType);

    const updated = await tx.user.update({
      where: { id: existing.id },
      data: {
        role: SHIPMASTR_OWNER_MASTER_ADMIN_ROLE,
        userType: SHIPMASTR_OWNER_MASTER_ADMIN_USER_TYPE
      },
      select: {
        id: true,
        email: true,
        role: true,
        userType: true
      }
    });

    await auditWriter(
      {
        action: SHIPMASTR_OWNER_RECONCILIATION_ACTION,
        entityType: "user",
        entityId: updated.id,
        metadata: {
          ownerEmail: updated.email,
          previousRole,
          previousUserType,
          nextRole: SHIPMASTR_OWNER_MASTER_ADMIN_ROLE,
          nextUserType: SHIPMASTR_OWNER_MASTER_ADMIN_USER_TYPE,
          operator,
          reason,
          source
        }
      },
      tx
    );

    return {
      changed: true,
      ownerEmail: updated.email,
      userId: updated.id,
      role: SHIPMASTR_OWNER_MASTER_ADMIN_ROLE,
      userType: SHIPMASTR_OWNER_MASTER_ADMIN_USER_TYPE
    };
  });
}
