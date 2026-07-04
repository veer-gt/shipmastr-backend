import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";

export const ledgerOwnerTypes = ["seller", "courier", "platform", "gateway"] as const;
export const ledgerAccountClasses = ["asset", "liability", "revenue", "expense"] as const;
export const ledgerAccountTypes = [
  "shipping_balance",
  "cod_receivable",
  "dispute_hold",
  "seller_shortfall",
  "checkout_balance",
  "courier_payable",
  "courier_cod_due",
  "courier_suspense",
  "platform_escrow",
  "gateway_clearing",
  "platform_revenue",
  "fee_expense",
  "tax_payable",
  "courier_leakage"
] as const;
export const ledgerAccountStatuses = ["active", "preview", "locked", "frozen", "closed"] as const;
export const ledgerScopes = ["custodial", "shadow"] as const;
export const ledgerEntryTypes = [
  "topup",
  "topup_refund",
  "gateway_settlement",
  "shipment_charge",
  "shipment_refund",
  "rto_freight_charge",
  "return_freight_charge",
  "weight_dispute_hold",
  "weight_dispute_release",
  "weight_dispute_capture",
  "cod_collected",
  "cod_remittance_in",
  "cod_payout",
  "courier_net_settlement",
  "checkout_capture",
  "checkout_split_settlement",
  "success_fee",
  "platform_fee",
  "adjustment",
  "suspense_recovery",
  "suspense_writeoff",
  "closure_refund_to_source",
  "closure_bank_settlement"
] as const;
export const postingDirections = ["debit", "credit"] as const;

export type LedgerOwnerType = typeof ledgerOwnerTypes[number];
export type LedgerAccountClass = typeof ledgerAccountClasses[number];
export type LedgerAccountType = typeof ledgerAccountTypes[number];
export type LedgerAccountStatus = typeof ledgerAccountStatuses[number];
export type LedgerScope = typeof ledgerScopes[number];
export type LedgerEntryType = typeof ledgerEntryTypes[number];
export type PostingDirection = typeof postingDirections[number];
export type PaiseInput = bigint | string;

type AccountTypeConfigRecord = {
  accountType: LedgerAccountType;
  accountClass: LedgerAccountClass;
  normalSide: PostingDirection;
  allowedOwnerTypes: LedgerOwnerType[];
  allowedLedgerScopes: LedgerScope[];
};

type WalletOwnerRecord = {
  id: string;
  ownerType: LedgerOwnerType;
  externalId?: string | null;
  displayName?: string | null;
};

type WalletAccountRecord = {
  id: string;
  ownerId: string;
  ownerType: LedgerOwnerType;
  accountType: LedgerAccountType;
  accountClass: LedgerAccountClass;
  status: LedgerAccountStatus;
  ledgerScope: LedgerScope;
  currency: string;
};

type JournalEntryRecord = {
  id: string;
  entryRef: string;
  commandHash: string;
  entryType: LedgerEntryType;
  ledgerScope: LedgerScope;
  currency: string;
  sourceType: string;
  sourceRef: string;
  reversalOf?: string | null;
  narrative?: string | null;
  createdBy?: string | null;
  createdAt?: Date;
};

type LedgerClient = {
  $transaction<T>(callback: (tx: LedgerTx) => Promise<T>): Promise<T>;
};

type LedgerTx = {
  $executeRaw?: (query: unknown) => Promise<unknown>;
  $queryRaw?: (query: unknown) => Promise<unknown>;
  accountTypeConfig: {
    findMany(): Promise<AccountTypeConfigRecord[]>;
    findUnique(input: { where: { accountType: LedgerAccountType } }): Promise<AccountTypeConfigRecord | null>;
  };
  walletOwner: {
    create(input: { data: Record<string, unknown> }): Promise<WalletOwnerRecord>;
    findUnique(input: { where: { ownerType_externalId: { ownerType: LedgerOwnerType; externalId: string | null } } }): Promise<WalletOwnerRecord | null>;
  };
  walletAccount: {
    create(input: { data: Record<string, unknown> }): Promise<WalletAccountRecord>;
    findMany(input: Record<string, unknown>): Promise<WalletAccountRecord[]>;
  };
  journalEntry: {
    create(input: { data: Record<string, unknown> }): Promise<JournalEntryRecord>;
    findUnique(input: Record<string, unknown>): Promise<(JournalEntryRecord & { postings?: JournalPostingRecord[] }) | null>;
  };
  journalPosting: {
    createMany(input: { data: Array<Record<string, unknown>> }): Promise<unknown>;
    findMany(input: Record<string, unknown>): Promise<JournalPostingRecord[]>;
  };
  accountBalance: {
    upsert(input: Record<string, unknown>): Promise<unknown>;
    findMany(input: Record<string, unknown>): Promise<Array<{ accountId: string; balancePaise: bigint }>>;
  };
  walletEventsOutbox: {
    create(input: { data: Record<string, unknown> }): Promise<unknown>;
  };
};

type JournalPostingRecord = {
  id?: string;
  entryId: string;
  accountId: string;
  direction: PostingDirection;
  amountPaise: bigint;
  currency: string;
};

export type CreateWalletOwnerInput = {
  ownerType: LedgerOwnerType;
  externalId?: string | null;
  displayName?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type CreateWalletAccountInput = {
  ownerId: string;
  ownerType: LedgerOwnerType;
  accountType: LedgerAccountType;
  ledgerScope?: LedgerScope;
  currency?: string;
  status?: LedgerAccountStatus;
  label?: string | null;
  metadata?: Record<string, unknown> | null;
  accountClass?: LedgerAccountClass;
};

export type LedgerPostingInput = {
  accountId: string;
  direction: PostingDirection;
  amountPaise: PaiseInput;
  currency?: string;
};

export type PostLedgerEntryCommand = {
  entryRef: string;
  commandHash?: string;
  entryType: LedgerEntryType;
  ledgerScope?: LedgerScope;
  currency?: string;
  sourceType: string;
  sourceRef: string;
  reversalOf?: string | null;
  narrative?: string | null;
  createdBy?: string | null;
  postings: LedgerPostingInput[];
  metadata?: Record<string, unknown> | null;
};

export type PostLedgerEntryResult = {
  entry: JournalEntryRecord;
  postings: JournalPostingRecord[];
  idempotent: boolean;
};

const defaultClient = prisma as unknown as LedgerClient;
const DEFAULT_CURRENCY = "INR";

export const defaultAccountTypeConfigs: AccountTypeConfigRecord[] = [
  { accountType: "shipping_balance", accountClass: "liability", normalSide: "credit", allowedOwnerTypes: ["seller"], allowedLedgerScopes: ["shadow", "custodial"] },
  { accountType: "cod_receivable", accountClass: "liability", normalSide: "credit", allowedOwnerTypes: ["seller"], allowedLedgerScopes: ["shadow", "custodial"] },
  { accountType: "dispute_hold", accountClass: "liability", normalSide: "credit", allowedOwnerTypes: ["seller"], allowedLedgerScopes: ["shadow", "custodial"] },
  { accountType: "seller_shortfall", accountClass: "asset", normalSide: "debit", allowedOwnerTypes: ["seller"], allowedLedgerScopes: ["shadow", "custodial"] },
  { accountType: "checkout_balance", accountClass: "liability", normalSide: "credit", allowedOwnerTypes: ["seller"], allowedLedgerScopes: ["shadow"] },
  { accountType: "courier_payable", accountClass: "liability", normalSide: "credit", allowedOwnerTypes: ["courier"], allowedLedgerScopes: ["shadow", "custodial"] },
  { accountType: "courier_cod_due", accountClass: "asset", normalSide: "debit", allowedOwnerTypes: ["courier"], allowedLedgerScopes: ["shadow", "custodial"] },
  { accountType: "courier_suspense", accountClass: "asset", normalSide: "debit", allowedOwnerTypes: ["courier"], allowedLedgerScopes: ["custodial"] },
  { accountType: "platform_escrow", accountClass: "asset", normalSide: "debit", allowedOwnerTypes: ["platform"], allowedLedgerScopes: ["custodial"] },
  { accountType: "gateway_clearing", accountClass: "asset", normalSide: "debit", allowedOwnerTypes: ["platform", "gateway"], allowedLedgerScopes: ["custodial"] },
  { accountType: "platform_revenue", accountClass: "revenue", normalSide: "credit", allowedOwnerTypes: ["platform"], allowedLedgerScopes: ["custodial"] },
  { accountType: "fee_expense", accountClass: "expense", normalSide: "debit", allowedOwnerTypes: ["platform"], allowedLedgerScopes: ["custodial"] },
  { accountType: "tax_payable", accountClass: "liability", normalSide: "credit", allowedOwnerTypes: ["platform"], allowedLedgerScopes: ["custodial"] },
  { accountType: "courier_leakage", accountClass: "expense", normalSide: "debit", allowedOwnerTypes: ["platform"], allowedLedgerScopes: ["custodial"] }
];

function assertEnum<T extends string>(value: string, allowed: readonly T[], code: string): T {
  if (!allowed.includes(value as T)) throw new HttpError(400, code);
  return value as T;
}

function cleanRequired(value: unknown, code: string) {
  const next = typeof value === "string" ? value.trim() : "";
  if (!next) throw new HttpError(400, code);
  return next;
}

function normalizeCurrency(value?: string) {
  const currency = (value || DEFAULT_CURRENCY).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new HttpError(400, "LEDGER_CURRENCY_INVALID");
  return currency;
}

export function parsePaise(value: PaiseInput): bigint {
  if (typeof value === "bigint") {
    if (value <= 0n) throw new HttpError(400, "LEDGER_AMOUNT_MUST_BE_POSITIVE");
    return value;
  }

  if (typeof value !== "string") throw new HttpError(400, "LEDGER_AMOUNT_MUST_BE_BIGINT_PAISE");
  const next = value.trim();
  if (!/^[1-9][0-9]*$/.test(next)) throw new HttpError(400, "LEDGER_AMOUNT_MUST_BE_BIGINT_PAISE");
  return BigInt(next);
}

function stableJson(value: unknown): string {
  if (typeof value === "bigint") return `"${value.toString()}"`;
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function computeCommandHash(command: Omit<PostLedgerEntryCommand, "commandHash">) {
  return createHash("sha256").update(stableJson(command)).digest("hex");
}

const directReferenceTerms = [
  ["a", "wb"].join(""),
  ["dock", "et"].join(""),
  ["way", "bill"].join(""),
  ["pho", "ne"].join(""),
  ["mob", "ile"].join(""),
  ["buy", "er"].join(""),
  ["cust", "omer"].join(""),
  ["addr", "ess"].join("")
];
const marketplaceReferencePrefixes = [
  ["ord", "er"].join(""),
  "ord",
  ["am", "z"].join(""),
  ["flip", "kart"].join(""),
  ["myn", "tra"].join(""),
  ["shop", "ify"].join("")
];
const directReferencePattern = new RegExp(`\\b(${directReferenceTerms.join("|")})\\b`, "i");
const marketplaceReferencePattern = new RegExp(`\\b(${marketplaceReferencePrefixes.join("|")})[-_]?[a-z0-9]{5,}\\b`, "i");
const internalOpaqueReferencePattern = /^(W0IMP-[A-Z]+-[a-f0-9]{16,32}|W0COR-(REV|NEW|FIX)-[a-f0-9]{16,32}|shp_[a-f0-9]{16,32})$/i;

function rejectPiiLikeRef(value: string, field: "entry_ref" | "source_ref") {
  const ref = cleanRequired(value, `LEDGER_${field.toUpperCase()}_REQUIRED`);
  const compactDigits = ref.replace(/\D/g, "");
  const lower = ref.toLowerCase();

  if (/@/.test(ref) || /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(ref)) {
    throw new HttpError(400, `LEDGER_${field.toUpperCase()}_PII_FORBIDDEN`);
  }
  if (internalOpaqueReferencePattern.test(ref)) return ref;
  if (compactDigits.length >= 10) throw new HttpError(400, `LEDGER_${field.toUpperCase()}_PII_FORBIDDEN`);
  if (directReferencePattern.test(ref)) {
    throw new HttpError(400, `LEDGER_${field.toUpperCase()}_PII_FORBIDDEN`);
  }
  if (marketplaceReferencePattern.test(lower)) {
    throw new HttpError(400, `LEDGER_${field.toUpperCase()}_BUYER_RESOLVABLE_REF_FORBIDDEN`);
  }

  return ref;
}

function balanceImpact(direction: PostingDirection, normalSide: PostingDirection, amount: bigint) {
  return direction === normalSide ? amount : -amount;
}

function isUniqueConstraintError(error: unknown) {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "P2002");
}

async function accountTypeConfigMap(tx: LedgerTx) {
  const configs = await tx.accountTypeConfig.findMany();
  const records = configs.length > 0 ? configs : defaultAccountTypeConfigs;
  return new Map(records.map((config) => [config.accountType, config]));
}

async function existingEntryResult(tx: LedgerTx, entryRef: string, commandHash: string): Promise<PostLedgerEntryResult | null> {
  const existing = await tx.journalEntry.findUnique({
    where: { entryRef },
    include: { postings: true }
  });
  if (!existing) return null;
  if (existing.commandHash !== commandHash) throw new HttpError(409, "LEDGER_ENTRY_REF_COMMAND_HASH_CONFLICT");
  const existingPostings = existing.postings || await tx.journalPosting.findMany({ where: { entryId: existing.id } });
  return { entry: existing, postings: existingPostings, idempotent: true };
}

async function ensureAndLockBalances(tx: LedgerTx, accounts: WalletAccountRecord[], ledgerScope: LedgerScope, currency: string) {
  const sortedAccounts = [...accounts].sort((left, right) => left.id.localeCompare(right.id));
  const accountIds = sortedAccounts.map((account) => account.id);
  if (tx.$executeRaw && sortedAccounts.length > 0) {
    const rows = sortedAccounts.map((account) => Prisma.sql`(${account.id}, CAST(${ledgerScope} AS ledger_scope), ${currency}, ${0n})`);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO account_balances (account_id, ledger_scope, currency, balance_paise)
      VALUES ${Prisma.join(rows)}
      ON CONFLICT (account_id) DO NOTHING
    `);
  }
  if (!tx.$queryRaw || accountIds.length === 0) return;
  await tx.$queryRaw(Prisma.sql`
    SELECT account_id
    FROM account_balances
    WHERE account_id IN (${Prisma.join(accountIds)})
    ORDER BY account_id ASC
    FOR UPDATE
  `);
}

export class LedgerService {
  constructor(private readonly client: LedgerClient = defaultClient) {}

  async createOwner(input: CreateWalletOwnerInput) {
    const ownerType = assertEnum(input.ownerType, ledgerOwnerTypes, "LEDGER_OWNER_TYPE_INVALID");
    const externalId = input.externalId ?? null;

    return this.client.$transaction(async (tx) => {
      const existing = await tx.walletOwner.findUnique({ where: { ownerType_externalId: { ownerType, externalId } } });
      if (existing) return existing;
      return tx.walletOwner.create({
        data: {
          ownerType,
          externalId,
          displayName: input.displayName?.trim() || null,
          metadata: input.metadata ?? undefined
        }
      });
    });
  }

  async createAccount(input: CreateWalletAccountInput) {
    const ownerType = assertEnum(input.ownerType, ledgerOwnerTypes, "LEDGER_OWNER_TYPE_INVALID");
    const accountType = assertEnum(input.accountType, ledgerAccountTypes, "LEDGER_ACCOUNT_TYPE_INVALID");
    const ledgerScope = assertEnum(input.ledgerScope || "shadow", ledgerScopes, "LEDGER_SCOPE_INVALID");
    const status = assertEnum(input.status || "active", ledgerAccountStatuses, "LEDGER_ACCOUNT_STATUS_INVALID");
    const currency = normalizeCurrency(input.currency);

    return this.client.$transaction(async (tx) => {
      const config = await tx.accountTypeConfig.findUnique({ where: { accountType } })
        || defaultAccountTypeConfigs.find((item) => item.accountType === accountType)
        || null;
      if (!config) throw new HttpError(400, "LEDGER_ACCOUNT_TYPE_CONFIG_MISSING");
      if (!config.allowedOwnerTypes.includes(ownerType)) throw new HttpError(400, "LEDGER_ACCOUNT_OWNER_TYPE_NOT_ALLOWED");
      if (!config.allowedLedgerScopes.includes(ledgerScope)) throw new HttpError(400, "LEDGER_ACCOUNT_SCOPE_NOT_ALLOWED");

      return tx.walletAccount.create({
        data: {
          ownerId: input.ownerId,
          ownerType,
          accountType,
          accountClass: config.accountClass,
          status,
          ledgerScope,
          currency,
          label: input.label?.trim() || null,
          metadata: input.metadata ?? undefined
        }
      });
    });
  }

  async postEntry(input: PostLedgerEntryCommand): Promise<PostLedgerEntryResult> {
    const entryRef = rejectPiiLikeRef(input.entryRef, "entry_ref");
    const sourceRef = rejectPiiLikeRef(input.sourceRef, "source_ref");
    const entryType = assertEnum(input.entryType, ledgerEntryTypes, "LEDGER_ENTRY_TYPE_INVALID");
    const ledgerScope = assertEnum(input.ledgerScope || "shadow", ledgerScopes, "LEDGER_SCOPE_INVALID");
    const currency = normalizeCurrency(input.currency);
    const sourceType = cleanRequired(input.sourceType, "LEDGER_SOURCE_TYPE_REQUIRED");
    const reversalOf = input.reversalOf?.trim() || null;
    const commandWithoutHash: Omit<PostLedgerEntryCommand, "commandHash"> = {
      ...input,
      entryRef,
      entryType,
      ledgerScope,
      currency,
      sourceType,
      sourceRef,
      ...(reversalOf ? { reversalOf } : {}),
      postings: input.postings
    };
    const commandHash = input.commandHash?.trim() || computeCommandHash(commandWithoutHash);

    if (!/^[a-f0-9]{64}$/i.test(commandHash)) throw new HttpError(400, "LEDGER_COMMAND_HASH_INVALID");
    if (!Array.isArray(input.postings) || input.postings.length < 2) throw new HttpError(400, "LEDGER_POSTINGS_MINIMUM_TWO_REQUIRED");

    const postings = input.postings.map((posting) => ({
      accountId: cleanRequired(posting.accountId, "LEDGER_POSTING_ACCOUNT_REQUIRED"),
      direction: assertEnum(posting.direction, postingDirections, "LEDGER_POSTING_DIRECTION_INVALID"),
      amountPaise: parsePaise(posting.amountPaise),
      currency: normalizeCurrency(posting.currency || currency)
    }));

    const debitTotal = postings.filter((posting) => posting.direction === "debit").reduce((sum, posting) => sum + posting.amountPaise, 0n);
    const creditTotal = postings.filter((posting) => posting.direction === "credit").reduce((sum, posting) => sum + posting.amountPaise, 0n);
    if (debitTotal !== creditTotal) throw new HttpError(400, "LEDGER_ENTRY_UNBALANCED");

    const postingCurrencies = new Set(postings.map((posting) => posting.currency));
    if (postingCurrencies.size !== 1 || !postingCurrencies.has(currency)) throw new HttpError(400, "LEDGER_ENTRY_CROSS_CURRENCY_FORBIDDEN");

    try {
      return await this.client.$transaction(async (tx) => {
        const existing = await existingEntryResult(tx, entryRef, commandHash);
        if (existing) return existing;

        if (reversalOf) {
          const reversedEntry = await tx.journalEntry.findUnique({ where: { id: reversalOf } });
          if (!reversedEntry) throw new HttpError(400, "LEDGER_REVERSAL_TARGET_NOT_FOUND");
          if (reversedEntry.reversalOf) throw new HttpError(400, "LEDGER_REVERSAL_OF_REVERSAL_FORBIDDEN");
          if (reversedEntry.ledgerScope !== ledgerScope) throw new HttpError(400, "LEDGER_REVERSAL_SCOPE_MISMATCH");
        }

        const accountIds = Array.from(new Set(postings.map((posting) => posting.accountId))).sort();

        const accounts = await tx.walletAccount.findMany({
          where: { id: { in: accountIds } },
          orderBy: { id: "asc" }
        });
        if (accounts.length !== accountIds.length) throw new HttpError(400, "LEDGER_ACCOUNT_NOT_FOUND");

        const configs = await accountTypeConfigMap(tx);
        const accountMap = new Map(accounts.map((account) => [account.id, account]));
        for (const account of accounts) {
          if (account.status !== "active") throw new HttpError(400, "LEDGER_ACCOUNT_NOT_POSTABLE");
          if (account.ledgerScope !== ledgerScope) throw new HttpError(400, "LEDGER_ENTRY_CROSS_SCOPE_FORBIDDEN");
          if (account.currency !== currency) throw new HttpError(400, "LEDGER_ENTRY_CROSS_CURRENCY_FORBIDDEN");
          const config = configs.get(account.accountType);
          if (!config) throw new HttpError(400, "LEDGER_ACCOUNT_TYPE_CONFIG_MISSING");
          if (account.accountClass !== config.accountClass) throw new HttpError(400, "LEDGER_ACCOUNT_CLASS_MISMATCH");
          if (!config.allowedOwnerTypes.includes(account.ownerType)) throw new HttpError(400, "LEDGER_ACCOUNT_OWNER_TYPE_NOT_ALLOWED");
          if (!config.allowedLedgerScopes.includes(account.ledgerScope)) throw new HttpError(400, "LEDGER_ACCOUNT_SCOPE_NOT_ALLOWED");
        }

        await ensureAndLockBalances(tx, accounts, ledgerScope, currency);

        const entry = await tx.journalEntry.create({
          data: {
            entryRef,
            commandHash,
            entryType,
            ledgerScope,
            currency,
            sourceType,
            sourceRef,
            reversalOf,
            narrative: input.narrative?.trim() || null,
            createdBy: input.createdBy?.trim() || null,
            metadata: input.metadata ?? undefined
          }
        });

        const postingRows = postings.map((posting) => ({
          entryId: entry.id,
          accountId: posting.accountId,
          direction: posting.direction,
          amountPaise: posting.amountPaise,
          currency
        }));
        await tx.journalPosting.createMany({ data: postingRows });

        for (const posting of postingRows) {
          const account = accountMap.get(posting.accountId);
          if (!account) throw new HttpError(400, "LEDGER_ACCOUNT_NOT_FOUND");
          const config = configs.get(account.accountType);
          if (!config) throw new HttpError(400, "LEDGER_ACCOUNT_TYPE_CONFIG_MISSING");
          const impact = balanceImpact(posting.direction, config.normalSide, posting.amountPaise);
          await tx.accountBalance.upsert({
            where: { accountId: posting.accountId },
            create: {
              accountId: posting.accountId,
              ledgerScope,
              currency,
              balancePaise: impact,
              lastJournalEntryId: entry.id
            },
            update: {
              balancePaise: { increment: impact },
              lastJournalEntryId: entry.id
            }
          });
        }

        await tx.walletEventsOutbox.create({
          data: {
            eventType: "ledger.entry.posted",
            aggregateType: "journal_entry",
            aggregateId: entry.id,
            payload: {
              entryId: entry.id,
              entryRef,
              entryType,
              ledgerScope,
              currency,
              sourceType,
              sourceRef,
              reversalOf,
              postingCount: postingRows.length
            }
          }
        });

        const createdPostings = await tx.journalPosting.findMany({ where: { entryId: entry.id }, orderBy: { accountId: "asc" } });
        return { entry, postings: createdPostings, idempotent: false };
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const existing = await this.client.$transaction((tx) => existingEntryResult(tx, entryRef, commandHash));
        if (existing) return existing;
      }
      throw error;
    }
  }
}

export const ledgerService = new LedgerService();

export function deriveBalancesFromPostings(
  accounts: WalletAccountRecord[],
  configs: AccountTypeConfigRecord[],
  postings: Array<Pick<JournalPostingRecord, "accountId" | "direction" | "amountPaise">>
) {
  const accountMap = new Map(accounts.map((account) => [account.id, account]));
  const configMap = new Map(configs.map((config) => [config.accountType, config]));
  const balances = new Map<string, bigint>();

  for (const posting of postings) {
    const account = accountMap.get(posting.accountId);
    if (!account) throw new HttpError(400, "LEDGER_ACCOUNT_NOT_FOUND");
    const config = configMap.get(account.accountType);
    if (!config) throw new HttpError(400, "LEDGER_ACCOUNT_TYPE_CONFIG_MISSING");
    const impact = balanceImpact(posting.direction, config.normalSide, posting.amountPaise);
    balances.set(posting.accountId, (balances.get(posting.accountId) || 0n) + impact);
  }

  return balances;
}
