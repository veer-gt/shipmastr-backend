import type { Prisma, SellerWalletLedger } from "@prisma/client";

export const walletDirections = ["CREDIT", "DEBIT", "HOLD", "RELEASE", "REVERSAL"] as const;
export const walletStatuses = ["PENDING", "POSTED", "FAILED", "REVERSED"] as const;

export type WalletDirection = typeof walletDirections[number];
export type WalletStatus = typeof walletStatuses[number];

export type WalletLedgerEntry = SellerWalletLedger;

export type WalletBalance = {
  merchantId: string;
  currency: string;
  currentBalance: number;
  availableBalance: number;
  holdBalance: number;
  ledgerCount: number;
  lastLedgerEntryId: string | null;
  lastTransactionAt: Date | null;
  sourceOfTruth: "SELLER_WALLET_LEDGER";
  compatibilityNote: string;
};

export type WalletReconciliationSummary = {
  status: "MATCHED" | "MISMATCHED" | "UNCHECKED";
  latestCachedBalance: number | null;
  ledgerDerivedBalance: number;
  matchesLatestCachedBalance: boolean | null;
  recommendation: string;
};

export type WalletLedgerFilters = {
  direction?: WalletDirection | undefined;
  status?: WalletStatus | undefined;
  entryType?: string | undefined;
  dateFrom?: Date | undefined;
  dateTo?: Date | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
};

export type AppendWalletLedgerInput = {
  merchantId: string;
  direction: WalletDirection;
  amount: number | string | Prisma.Decimal;
  entryType: string;
  currency?: string | undefined;
  status?: WalletStatus | undefined;
  orderId?: string | null | undefined;
  awb?: string | null | undefined;
  referenceType?: string | null | undefined;
  referenceId?: string | null | undefined;
  idempotencyKey?: string | null | undefined;
  description: string;
  metadata?: Prisma.InputJsonValue | null | undefined;
  createdBy?: string | null | undefined;
  allowNegative?: boolean | undefined;
};

export type WalletLedgerMutationResult = {
  entry: WalletLedgerEntry;
  balance: WalletBalance;
  idempotent: boolean;
};

export type WalletReconciliationOptions = {
  legacyCachedBalance?: number | null | undefined;
  legacyCachedBalanceSource?: string | null | undefined;
};

export type AdminWalletListFilters = {
  search?: string | undefined;
  status?: "ACTIVE" | undefined;
  reconcileStatus?: WalletReconciliationSummary["status"] | undefined;
  limit?: number | undefined;
};
