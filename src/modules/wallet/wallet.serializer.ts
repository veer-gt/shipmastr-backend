import type { SellerWalletLedger } from "@prisma/client";
import type { WalletBalance } from "./wallet.types.js";

function money(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

function iso(value: Date | string | null | undefined) {
  return value ? new Date(value).toISOString() : null;
}

export function serializeWalletBalance(balance: WalletBalance) {
  return {
    merchantId: balance.merchantId,
    currency: balance.currency,
    currentBalance: money(balance.currentBalance),
    availableBalance: money(balance.availableBalance),
    holdBalance: money(balance.holdBalance),
    ledgerCount: balance.ledgerCount,
    lastLedgerEntryId: balance.lastLedgerEntryId,
    lastTransactionAt: iso(balance.lastTransactionAt),
    sourceOfTruth: balance.sourceOfTruth,
    compatibilityNote: balance.compatibilityNote
  };
}

export function serializeWalletLedgerEntry(entry: SellerWalletLedger) {
  return {
    id: entry.id,
    merchantId: entry.merchantId,
    direction: entry.direction,
    amount: money(entry.amount),
    currency: entry.currency ?? "INR",
    entryType: entry.entryType,
    status: entry.status ?? "POSTED",
    balanceBefore: money(entry.balanceBefore),
    balanceAfter: money(entry.balanceAfter),
    reference: {
      type: entry.referenceType ?? null,
      id: entry.referenceId ?? null,
      orderId: entry.orderId ?? null,
      awb: entry.awb ?? null
    },
    description: entry.description ?? null,
    postedAt: iso(entry.postedAt),
    createdAt: iso(entry.createdAt),
    updatedAt: iso(entry.updatedAt)
  };
}

