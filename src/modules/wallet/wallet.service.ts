import { Prisma, type SellerWalletLedger } from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import type {
  AppendWalletLedgerInput,
  WalletBalance,
  WalletDirection,
  WalletLedgerFilters,
  WalletLedgerMutationResult,
  WalletReconciliationOptions
} from "./wallet.types.js";

type Db = Prisma.TransactionClient | typeof prisma;

const DEFAULT_CURRENCY = "INR";
const MAX_LEDGER_LIMIT = 100;

function decimal(value: number | string | Prisma.Decimal) {
  return new Prisma.Decimal(value);
}

function money(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

function positiveAmount(value: number | string | Prisma.Decimal) {
  const amount = decimal(value);
  if (amount.lte(0)) throw new HttpError(400, "WALLET_AMOUNT_MUST_BE_POSITIVE");
  return amount;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberFromMetadata(metadata: unknown, key: string) {
  const value = jsonObject(metadata)[key];
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function defaultImpact(direction: string, amount: number) {
  switch (direction.toUpperCase()) {
    case "CREDIT":
      return { currentImpact: amount, holdImpact: 0 };
    case "DEBIT":
      return { currentImpact: -amount, holdImpact: 0 };
    case "HOLD":
      return { currentImpact: 0, holdImpact: amount };
    case "RELEASE":
      return { currentImpact: 0, holdImpact: -amount };
    case "REVERSAL":
      return { currentImpact: -amount, holdImpact: 0 };
    default:
      return { currentImpact: 0, holdImpact: 0 };
  }
}

function ledgerImpact(entry: Pick<SellerWalletLedger, "direction" | "amount" | "metadata">) {
  const amount = money(entry.amount);
  const metadataCurrentImpact = numberFromMetadata(entry.metadata, "currentImpact");
  const metadataHoldImpact = numberFromMetadata(entry.metadata, "holdImpact");

  if (metadataCurrentImpact || metadataHoldImpact) {
    return {
      currentImpact: money(metadataCurrentImpact),
      holdImpact: money(metadataHoldImpact)
    };
  }

  return defaultImpact(entry.direction, amount);
}

function buildMetadata(
  input: AppendWalletLedgerInput,
  impact: { currentImpact: number; holdImpact: number }
): Prisma.InputJsonValue {
  return {
    ...jsonObject(input.metadata),
    currentImpact: impact.currentImpact,
    holdImpact: impact.holdImpact,
    walletSource: "SELLER_WALLET_LEDGER"
  };
}

function impactForInput(input: AppendWalletLedgerInput, amount: number) {
  const metadataCurrentImpact = numberFromMetadata(input.metadata, "currentImpact");
  const metadataHoldImpact = numberFromMetadata(input.metadata, "holdImpact");

  if (metadataCurrentImpact || metadataHoldImpact) {
    return {
      currentImpact: money(metadataCurrentImpact),
      holdImpact: money(metadataHoldImpact)
    };
  }

  return defaultImpact(input.direction, amount);
}

function isPrismaClient(client: Db): client is typeof prisma {
  return "$transaction" in client;
}

export function deriveWalletBalanceFromLedger(
  merchantId: string,
  entries: Array<Pick<SellerWalletLedger, "id" | "direction" | "amount" | "currency" | "status" | "balanceAfter" | "metadata" | "createdAt" | "postedAt">>
): WalletBalance {
  let currentBalance = 0;
  let holdBalance = 0;
  let currency = DEFAULT_CURRENCY;
  let lastLedgerEntryId: string | null = null;
  let lastTransactionAt: Date | null = null;

  for (const entry of entries) {
    if (entry.status === "FAILED") continue;
    currency = entry.currency || currency;
    const impact = ledgerImpact(entry);
    currentBalance = money(currentBalance + impact.currentImpact);
    holdBalance = money(Math.max(0, holdBalance + impact.holdImpact));
    lastLedgerEntryId = entry.id;
    lastTransactionAt = entry.postedAt ?? entry.createdAt ?? lastTransactionAt;
  }

  return {
    merchantId,
    currency,
    currentBalance,
    availableBalance: money(Math.max(0, currentBalance - holdBalance)),
    holdBalance,
    ledgerCount: entries.length,
    lastLedgerEntryId,
    lastTransactionAt,
    sourceOfTruth: "SELLER_WALLET_LEDGER",
    compatibilityNote: "Wallet balance is derived from append-only SellerWalletLedger entries. Any user.walletBalance value should be treated as cached/legacy compatibility until explicitly wired to this ledger."
  };
}

export async function getOrCreateWalletForSellerOrMerchant(merchantId: string, client: Db = prisma) {
  if (!merchantId) throw new HttpError(403, "MERCHANT_SCOPE_REQUIRED");

  const merchant = await client.merchant.findUnique({
    where: { id: merchantId },
    select: { id: true, name: true, email: true, onboardingStatus: true }
  });

  if (!merchant) throw new HttpError(404, "MERCHANT_NOT_FOUND");

  return {
    wallet: {
      id: `seller-wallet:${merchant.id}`,
      merchantId: merchant.id,
      ownerType: "MERCHANT",
      ownerName: merchant.name,
      status: "ACTIVE",
      currency: DEFAULT_CURRENCY,
      sourceOfTruth: "SELLER_WALLET_LEDGER"
    },
    merchant
  };
}

export async function getBalance(merchantId: string, client: Db = prisma): Promise<WalletBalance> {
  await getOrCreateWalletForSellerOrMerchant(merchantId, client);

  const entries = await client.sellerWalletLedger.findMany({
    where: { merchantId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      direction: true,
      amount: true,
      currency: true,
      status: true,
      balanceAfter: true,
      metadata: true,
      createdAt: true,
      postedAt: true
    }
  });

  return deriveWalletBalanceFromLedger(merchantId, entries);
}

export async function listLedgerEntries(
  merchantId: string,
  filters: WalletLedgerFilters = {},
  client: Db = prisma
) {
  await getOrCreateWalletForSellerOrMerchant(merchantId, client);

  const limit = Math.min(MAX_LEDGER_LIMIT, Math.max(1, Math.floor(Number(filters.limit || 50))));
  const where: Prisma.SellerWalletLedgerWhereInput = {
    merchantId,
    ...(filters.direction ? { direction: filters.direction } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.entryType ? { entryType: filters.entryType } : {}),
    ...(filters.dateFrom || filters.dateTo ? {
      createdAt: {
        ...(filters.dateFrom ? { gte: filters.dateFrom } : {}),
        ...(filters.dateTo ? { lte: filters.dateTo } : {})
      }
    } : {})
  };

  const entries = await client.sellerWalletLedger.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {})
  });

  return {
    entries: entries.slice(0, limit),
    limit,
    hasMore: entries.length > limit,
    nextCursor: entries.length > limit ? entries[limit]?.id ?? null : null
  };
}

async function appendLedgerEntryInTransaction(
  input: AppendWalletLedgerInput,
  tx: Prisma.TransactionClient
): Promise<WalletLedgerMutationResult> {
  await getOrCreateWalletForSellerOrMerchant(input.merchantId, tx);

  if (input.idempotencyKey) {
    const existing = await tx.sellerWalletLedger.findUnique({
      where: {
        merchantId_idempotencyKey: {
          merchantId: input.merchantId,
          idempotencyKey: input.idempotencyKey
        }
      }
    });

    if (existing) {
      return {
        entry: existing,
        balance: await getBalance(input.merchantId, tx),
        idempotent: true
      };
    }
  }

  const amount = positiveAmount(input.amount);
  const numericAmount = money(amount);
  const impact = impactForInput(input, numericAmount);
  const currentBalance = await getBalance(input.merchantId, tx);
  const nextCurrentBalance = money(currentBalance.currentBalance + impact.currentImpact);
  const nextHoldBalance = money(currentBalance.holdBalance + impact.holdImpact);

  if (!input.allowNegative && nextCurrentBalance < 0) {
    throw new HttpError(409, "WALLET_INSUFFICIENT_BALANCE");
  }

  if (nextHoldBalance < 0) {
    throw new HttpError(409, "WALLET_HOLD_BALANCE_UNDERFLOW");
  }

  const entry = await tx.sellerWalletLedger.create({
    data: {
      merchantId: input.merchantId,
      orderId: input.orderId ?? null,
      awb: input.awb ?? null,
      entryType: input.entryType,
      direction: input.direction,
      amount,
      currency: input.currency ?? DEFAULT_CURRENCY,
      status: input.status ?? "POSTED",
      balanceBefore: decimal(currentBalance.currentBalance),
      balanceAfter: decimal(nextCurrentBalance),
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      description: input.description,
      metadata: buildMetadata(input, impact),
      createdBy: input.createdBy ?? null,
      postedAt: new Date()
    }
  });

  return {
    entry,
    balance: await getBalance(input.merchantId, tx),
    idempotent: false
  };
}

export async function appendLedgerEntry(
  input: AppendWalletLedgerInput,
  client: Db = prisma
): Promise<WalletLedgerMutationResult> {
  if (isPrismaClient(client)) {
    return client.$transaction((tx) => appendLedgerEntryInTransaction(input, tx));
  }

  return appendLedgerEntryInTransaction(input, client);
}

export function credit(input: Omit<AppendWalletLedgerInput, "direction">, client: Db = prisma) {
  return appendLedgerEntry({ ...input, direction: "CREDIT" }, client);
}

export function debit(input: Omit<AppendWalletLedgerInput, "direction">, client: Db = prisma) {
  return appendLedgerEntry({ ...input, direction: "DEBIT" }, client);
}

export function hold(input: Omit<AppendWalletLedgerInput, "direction">, client: Db = prisma) {
  return appendLedgerEntry({ ...input, direction: "HOLD" }, client);
}

export function releaseHold(input: Omit<AppendWalletLedgerInput, "direction">, client: Db = prisma) {
  return appendLedgerEntry({ ...input, direction: "RELEASE" }, client);
}

export async function reverse(input: {
  merchantId: string;
  ledgerEntryId: string;
  idempotencyKey: string;
  description: string;
  createdBy?: string | null;
}, client: Db = prisma) {
  const execute = async (tx: Prisma.TransactionClient) => {
    const original = await tx.sellerWalletLedger.findFirst({
      where: { id: input.ledgerEntryId, merchantId: input.merchantId }
    });
    if (!original) throw new HttpError(404, "WALLET_LEDGER_ENTRY_NOT_FOUND");
    if (original.status === "REVERSED" || original.reversedByLedgerId) {
      throw new HttpError(409, "WALLET_LEDGER_ENTRY_ALREADY_REVERSED");
    }

    const originalImpact = ledgerImpact(original);
    const result = await appendLedgerEntryInTransaction({
      merchantId: input.merchantId,
      direction: "REVERSAL",
      amount: original.amount,
      currency: original.currency,
      entryType: `${original.entryType}_REVERSAL`,
      orderId: original.orderId,
      awb: original.awb,
      referenceType: "SellerWalletLedger",
      referenceId: original.id,
      idempotencyKey: input.idempotencyKey,
      description: input.description,
      createdBy: input.createdBy,
      metadata: {
        originalLedgerEntryId: original.id,
        originalDirection: original.direction,
        currentImpact: money(-originalImpact.currentImpact),
        holdImpact: money(-originalImpact.holdImpact)
      },
      allowNegative: true
    }, tx);

    await tx.sellerWalletLedger.update({
      where: { id: original.id },
      data: {
        status: "REVERSED",
        reversedByLedgerId: result.entry.id
      }
    });

    return result;
  };

  if (isPrismaClient(client)) {
    return client.$transaction((tx) => execute(tx));
  }

  return execute(client);
}

export async function reconcileBalance(
  merchantId: string,
  client: Db = prisma,
  options: WalletReconciliationOptions = {}
) {
  const balance = await getBalance(merchantId, client);
  const latest = await client.sellerWalletLedger.findFirst({
    where: { merchantId, balanceAfter: { not: null } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }]
  });
  const latestCachedBalance = latest?.balanceAfter == null ? null : money(latest.balanceAfter);
  const legacyCachedBalance = options.legacyCachedBalance == null ? null : money(options.legacyCachedBalance);
  const hasLegacyCachedBalance = legacyCachedBalance !== null;

  return {
    merchantId,
    mode: "READ_ONLY_CHECK",
    balance,
    latestCachedBalance,
    ledgerDerivedBalance: balance.currentBalance,
    matchesLatestCachedBalance: latestCachedBalance == null || money(latestCachedBalance) === money(balance.currentBalance),
    legacyCachedBalance,
    legacyCachedBalanceSource: options.legacyCachedBalanceSource || (hasLegacyCachedBalance ? "user.walletBalance" : null),
    matchesLegacyCachedBalance: hasLegacyCachedBalance ? money(legacyCachedBalance) === money(balance.currentBalance) : null,
    recommendation: latestCachedBalance == null
      ? "No cached balanceAfter is available yet; ledger-derived balance is the active source of truth."
      : "Use ledger-derived balance as source of truth and treat cached balance snapshots as compatibility data only."
  };
}

export async function listMerchantWallets(input: {
  search?: string | undefined;
  limit?: number | undefined;
}, client: Db = prisma) {
  const limit = Math.min(50, Math.max(1, Math.floor(Number(input.limit || 25))));
  const search = input.search?.trim();
  const query: Prisma.MerchantFindManyArgs = {
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      name: true,
      email: true,
      onboardingStatus: true,
      createdAt: true
    }
  };

  if (search) {
    query.where = {
      OR: [
        { id: { contains: search, mode: "insensitive" } },
        { name: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } }
      ]
    };
  }

  const merchants = await client.merchant.findMany(query);

  const rows = await Promise.all(merchants.map(async (merchant) => ({
    merchant,
    balance: await getBalance(merchant.id, client)
  })));

  return { wallets: rows, limit };
}
