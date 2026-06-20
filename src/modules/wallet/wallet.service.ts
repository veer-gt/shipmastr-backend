import { Prisma, type SellerWalletLedger } from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../audit/audit.service.js";
import type {
  AdminWalletListFilters,
  AppendWalletLedgerInput,
  WalletBalance,
  WalletLedgerFilters,
  WalletLedgerMutationResult,
  WalletReconciliationOptions,
  WalletReconciliationSummary
} from "./wallet.types.js";

type Db = Prisma.TransactionClient | typeof prisma;

const DEFAULT_CURRENCY = "INR";
const MAX_LEDGER_LIMIT = 100;

function decimal(value: unknown) {
  return new Prisma.Decimal(String(value ?? 0));
}

function decimalMoney(value: unknown) {
  return decimal(value).toDecimalPlaces(2);
}

function money(value: unknown) {
  const parsed = Number(decimalMoney(value).toFixed(2));
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
  try {
    return decimalMoney(value);
  } catch {
    return decimalMoney(0);
  }
}

function defaultImpact(direction: string, amount: Prisma.Decimal) {
  switch (direction.toUpperCase()) {
    case "CREDIT":
      return { currentImpact: amount, holdImpact: decimalMoney(0) };
    case "DEBIT":
      return { currentImpact: amount.negated(), holdImpact: decimalMoney(0) };
    case "HOLD":
      return { currentImpact: decimalMoney(0), holdImpact: amount };
    case "RELEASE":
      return { currentImpact: decimalMoney(0), holdImpact: amount.negated() };
    case "REVERSAL":
      return { currentImpact: amount.negated(), holdImpact: decimalMoney(0) };
    default:
      return { currentImpact: decimalMoney(0), holdImpact: decimalMoney(0) };
  }
}

function ledgerImpact(entry: Pick<SellerWalletLedger, "direction" | "amount" | "metadata">) {
  const amount = decimalMoney(entry.amount);
  const metadataCurrentImpact = numberFromMetadata(entry.metadata, "currentImpact");
  const metadataHoldImpact = numberFromMetadata(entry.metadata, "holdImpact");

  if (!metadataCurrentImpact.isZero() || !metadataHoldImpact.isZero()) {
    return {
      currentImpact: metadataCurrentImpact,
      holdImpact: metadataHoldImpact
    };
  }

  return defaultImpact(entry.direction, amount);
}

function buildMetadata(
  input: AppendWalletLedgerInput,
  impact: { currentImpact: Prisma.Decimal; holdImpact: Prisma.Decimal }
): Prisma.InputJsonValue {
  return {
    ...jsonObject(input.metadata),
    currentImpact: money(impact.currentImpact),
    holdImpact: money(impact.holdImpact),
    walletSource: "SELLER_WALLET_LEDGER"
  };
}

function impactForInput(input: AppendWalletLedgerInput, amount: Prisma.Decimal) {
  const metadataCurrentImpact = numberFromMetadata(input.metadata, "currentImpact");
  const metadataHoldImpact = numberFromMetadata(input.metadata, "holdImpact");

  if (!metadataCurrentImpact.isZero() || !metadataHoldImpact.isZero()) {
    return {
      currentImpact: metadataCurrentImpact,
      holdImpact: metadataHoldImpact
    };
  }

  return defaultImpact(input.direction, amount);
}

function isPrismaClient(client: Db): client is typeof prisma {
  return "$transaction" in client;
}

function maxDecimal(value: Prisma.Decimal, floor: Prisma.Decimal) {
  return value.greaterThan(floor) ? value : floor;
}

function walletAuditAction(direction: string) {
  return `WALLET_LEDGER_${direction.toUpperCase()}`;
}

export function deriveWalletBalanceFromLedger(
  merchantId: string,
  entries: Array<Pick<SellerWalletLedger, "id" | "direction" | "amount" | "currency" | "status" | "balanceAfter" | "metadata" | "createdAt" | "postedAt">>
): WalletBalance {
  let currentBalance = decimalMoney(0);
  let holdBalance = decimalMoney(0);
  let currency = DEFAULT_CURRENCY;
  let lastLedgerEntryId: string | null = null;
  let lastTransactionAt: Date | null = null;

  for (const entry of entries) {
    if (entry.status === "FAILED") continue;
    currency = entry.currency || currency;
    const impact = ledgerImpact(entry);
    currentBalance = decimalMoney(currentBalance.plus(impact.currentImpact));
    holdBalance = maxDecimal(decimalMoney(holdBalance.plus(impact.holdImpact)), decimalMoney(0));
    lastLedgerEntryId = entry.id;
    lastTransactionAt = entry.postedAt ?? entry.createdAt ?? lastTransactionAt;
  }

  return {
    merchantId,
    currency,
    currentBalance: money(currentBalance),
    availableBalance: money(maxDecimal(currentBalance.minus(holdBalance), decimalMoney(0))),
    holdBalance: money(holdBalance),
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
  const impact = impactForInput(input, amount);
  const currentBalance = await getBalance(input.merchantId, tx);
  const nextCurrentBalance = decimalMoney(decimalMoney(currentBalance.currentBalance).plus(impact.currentImpact));
  const nextHoldBalance = decimalMoney(decimalMoney(currentBalance.holdBalance).plus(impact.holdImpact));

  if (!input.allowNegative && nextCurrentBalance.lessThan(0)) {
    throw new HttpError(409, "WALLET_INSUFFICIENT_BALANCE");
  }

  if (nextHoldBalance.lessThan(0)) {
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
      balanceBefore: decimalMoney(currentBalance.currentBalance),
      balanceAfter: nextCurrentBalance,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      description: input.description,
      metadata: buildMetadata(input, impact),
      createdBy: input.createdBy ?? null,
      postedAt: new Date()
    }
  });

  await audit({
    merchantId: input.merchantId,
    ...(input.createdBy ? { actorId: input.createdBy } : {}),
    action: walletAuditAction(entry.direction),
    entityType: "SellerWalletLedger",
    entityId: entry.id,
    metadata: {
      entryType: entry.entryType,
      direction: entry.direction,
      amount: money(entry.amount),
      currency: entry.currency,
      status: entry.status,
      referenceType: entry.referenceType,
      hasReference: Boolean(entry.referenceId || entry.orderId || entry.awb),
      idempotent: false,
      sourceOfTruth: "SELLER_WALLET_LEDGER"
    }
  }, tx);

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
        currentImpact: money(originalImpact.currentImpact.negated()),
        holdImpact: money(originalImpact.holdImpact.negated())
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

async function walletReconciliationSummary(
  merchantId: string,
  balance: WalletBalance,
  client: Db
): Promise<WalletReconciliationSummary> {
  const latest = await client.sellerWalletLedger.findFirst({
    where: { merchantId, balanceAfter: { not: null } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }]
  });
  const latestCachedBalance = latest?.balanceAfter == null ? null : money(latest.balanceAfter);
  const matchesLatestCachedBalance = latestCachedBalance == null ? null : money(latestCachedBalance) === money(balance.currentBalance);

  return {
    status: latestCachedBalance == null ? "UNCHECKED" : matchesLatestCachedBalance ? "MATCHED" : "MISMATCHED",
    latestCachedBalance,
    ledgerDerivedBalance: balance.currentBalance,
    matchesLatestCachedBalance,
    recommendation: latestCachedBalance == null
      ? "No cached balance snapshot is available; ledger-derived balance is active."
      : "Use ledger-derived balance as source of truth."
  };
}

export async function listMerchantWallets(input: AdminWalletListFilters, client: Db = prisma) {
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

  const rows = await Promise.all(merchants.map(async (merchant) => {
    const balance = await getBalance(merchant.id, client);
    const reconciliation = await walletReconciliationSummary(merchant.id, balance, client);
    return {
      merchant,
      balance,
      wallet: {
        status: "ACTIVE" as const,
        sourceOfTruth: "SELLER_WALLET_LEDGER" as const
      },
      reconciliation
    };
  }));

  return {
    wallets: rows.filter((row) => {
      if (input.status && row.wallet.status !== input.status) return false;
      if (input.reconcileStatus && row.reconciliation.status !== input.reconcileStatus) return false;
      return true;
    }),
    limit
  };
}
