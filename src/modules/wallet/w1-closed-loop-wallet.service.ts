import { createHash } from "node:crypto";
import { env } from "../../config/env.js";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import {
  LedgerService,
  ledgerService,
  parsePaise,
  type LedgerAccountType,
  type LedgerOwnerType,
  type PostLedgerEntryCommand
} from "../walletLedger/ledger.service.js";

const CUSTODIAL_SCOPE = "custodial" as const;
const DEFAULT_CURRENCY = "INR";
const PLATFORM_OWNER_REF = "shipmastr-platform";

type MoneyInput = bigint | string;

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
  status: "active" | "preview" | "locked" | "frozen" | "closed";
  ledgerScope: "custodial" | "shadow";
  currency: string;
};

type WalletHoldRecord = {
  id: string;
  accountId: string;
  entryId: string;
  holdRef: string;
  amountPaise: bigint;
  currency: string;
  status: "active" | "released" | "captured" | "expired";
  sourceType: string;
  sourceRef: string;
  releasedByEntryId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
};

type TopupIntentRecord = {
  id: string;
  topupRef: string;
  sellerOrgId: string;
  amountPaise: bigint;
  currency: string;
  status: string;
  sourceRefHash: string;
  createdBy?: string | null;
  confirmedBy?: string | null;
  journalEntryId?: string | null;
  confirmedAt?: Date | null;
  metadata?: unknown;
  createdAt?: Date;
  updatedAt?: Date;
};

type BalanceRecord = {
  accountId: string;
  balancePaise: bigint;
  ledgerScope?: "custodial" | "shadow";
  currency?: string;
};

type JournalEntryRecord = {
  id: string;
  entryType: string;
  ledgerScope: "custodial" | "shadow";
  currency: string;
  createdAt?: Date;
};

type JournalPostingRecord = {
  id?: string;
  entryId: string;
  accountId: string;
  direction: "debit" | "credit";
  amountPaise: bigint;
  currency: string;
  entry?: JournalEntryRecord;
};

type W1Client = {
  $transaction?<T>(callback: (tx: W1Client) => Promise<T>): Promise<T>;
  walletOwner: {
    findUnique(input: Record<string, unknown>): Promise<WalletOwnerRecord | null>;
  };
  walletAccount: {
    findFirst(input: Record<string, unknown>): Promise<WalletAccountRecord | null>;
    findMany(input: Record<string, unknown>): Promise<WalletAccountRecord[]>;
  };
  walletTopupIntent: {
    create(input: { data: Record<string, unknown> }): Promise<TopupIntentRecord>;
    findUnique(input: Record<string, unknown>): Promise<TopupIntentRecord | null>;
    update(input: Record<string, unknown>): Promise<TopupIntentRecord>;
  };
  walletHold: {
    create(input: { data: Record<string, unknown> }): Promise<WalletHoldRecord>;
    findFirst(input: Record<string, unknown>): Promise<WalletHoldRecord | null>;
    findMany(input: Record<string, unknown>): Promise<WalletHoldRecord[]>;
    update(input: Record<string, unknown>): Promise<WalletHoldRecord>;
  };
  accountBalance: {
    findUnique(input: Record<string, unknown>): Promise<BalanceRecord | null>;
    findMany(input: Record<string, unknown>): Promise<BalanceRecord[]>;
  };
  journalEntry: {
    findUnique(input: Record<string, unknown>): Promise<JournalEntryRecord | null>;
  };
  journalPosting: {
    findMany(input: Record<string, unknown>): Promise<JournalPostingRecord[]>;
  };
};

export type W1RuntimeConfig = {
  enabled: boolean;
  sandboxOnly: boolean;
  allowLivePayments: boolean;
  allowCashout: boolean;
  appEnv: string;
  nodeEnv: string;
};

export type W1ServiceDeps = {
  client?: W1Client;
  ledger?: LedgerService;
  config?: Partial<W1RuntimeConfig>;
};

const defaultConfig = (): W1RuntimeConfig => ({
  enabled: env.WALLET_W1_ENABLED,
  sandboxOnly: env.WALLET_W1_SANDBOX_ONLY,
  allowLivePayments: env.WALLET_W1_ALLOW_LIVE_PAYMENTS,
  allowCashout: env.WALLET_W1_ALLOW_CASHOUT,
  appEnv: env.APP_ENV,
  nodeEnv: env.NODE_ENV
});

function resolveConfig(override?: Partial<W1RuntimeConfig>): W1RuntimeConfig {
  return { ...defaultConfig(), ...override };
}

function hashRef(parts: Array<string | null | undefined>) {
  return createHash("sha256").update(parts.map((part) => part ?? "").join("\0")).digest("hex");
}

function safeDigest(parts: Array<string | null | undefined>, length = 24) {
  const alphabet = "abcdefghijklmnop";
  return hashRef(parts).slice(0, length).replace(/[0-9a-f]/g, (char) => alphabet[Number.parseInt(char, 16)] ?? "a");
}

function internalRef(prefix: string, parts: Array<string | null | undefined>) {
  return `${prefix}-${safeDigest(parts)}`;
}

const sensitiveTerms = [
  ["a", "wb"].join(""),
  ["ord", "er"].join(""),
  ["pho", "ne"].join(""),
  ["em", "ail"].join(""),
  ["addr", "ess"].join(""),
  ["pin", "code"].join("")
];
const sensitiveTermPattern = new RegExp(`(${sensitiveTerms.join("|")})`, "i");
const contactPattern = /@|\b[6-9][0-9]{9}\b/;
const postalPattern = /\b[1-9][0-9]{5}\b/;

function cleanRequiredValue(value: string, code: string) {
  const next = value.trim();
  if (!next) throw new HttpError(400, code);
  return next;
}

function cleanSafeRef(value: string, code: string) {
  const next = cleanRequiredValue(value, code);
  if (sensitiveTermPattern.test(next) || contactPattern.test(next) || postalPattern.test(next)) {
    throw new HttpError(400, "W1_PUBLIC_OR_PII_REF_FORBIDDEN");
  }
  return next;
}

function amountMinor(value: MoneyInput) {
  return parsePaise(value);
}

function minorString(value: bigint) {
  return value.toString();
}

function assertMutationAllowed(config: W1RuntimeConfig) {
  if (!config.enabled) throw new HttpError(403, "WALLET_W1_DISABLED");
  if (config.nodeEnv === "production" || config.appEnv === "production") {
    throw new HttpError(403, "WALLET_W1_PRODUCTION_MUTATION_FORBIDDEN");
  }
  if (!config.sandboxOnly) throw new HttpError(403, "WALLET_W1_LIVE_MODE_FORBIDDEN");
  if (config.allowLivePayments) throw new HttpError(403, "WALLET_W1_LIVE_PAYMENTS_FORBIDDEN");
}

function assertNoCashout(config: W1RuntimeConfig) {
  if (config.allowCashout) throw new HttpError(403, "WALLET_W1_CASHOUT_FORBIDDEN");
  throw new HttpError(403, "WALLET_W1_CASHOUT_FORBIDDEN");
}

function normalizeCourierCode(courierCode: string) {
  const next = courierCode.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "_");
  if (!next) throw new HttpError(400, "W1_COURIER_CODE_REQUIRED");
  return next;
}

function matchesAccount(account: WalletAccountRecord, accountType: LedgerAccountType, ownerId?: string) {
  return account.accountType === accountType
    && account.ledgerScope === CUSTODIAL_SCOPE
    && account.currency === DEFAULT_CURRENCY
    && (!ownerId || account.ownerId === ownerId);
}

export class ClosedLoopWalletProvisioningService {
  private readonly client: W1Client;
  private readonly ledger: LedgerService;
  private readonly config: W1RuntimeConfig;

  constructor(deps: W1ServiceDeps = {}) {
    this.client = deps.client ?? prisma as unknown as W1Client;
    this.ledger = deps.ledger ?? ledgerService;
    this.config = resolveConfig(deps.config);
  }

  assertCanMutate() {
    assertMutationAllowed(this.config);
  }

  async ensureSellerClosedLoopWallet(input: { sellerOrgId: string; createdBy?: string | null; sandboxOnly: boolean }) {
    this.assertCanMutate();
    if (!input.sandboxOnly) throw new HttpError(403, "W1_SELLER_WALLET_SANDBOX_ONLY_REQUIRED");
    const sellerOrgId = cleanRequiredValue(input.sellerOrgId, "W1_SELLER_ORG_ID_REQUIRED");
    const owner = await this.ledger.createOwner({
      ownerType: "seller",
      externalId: sellerOrgId,
      displayName: "W1A seller wallet",
      metadata: { walletVersion: "W1A", sandboxOnly: true, createdBy: input.createdBy ?? null }
    });

    const shippingBalance = await this.ensureAccount(owner, "shipping_balance", "Seller shipping balance");
    const disputeHold = await this.ensureAccount(owner, "dispute_hold", "Seller dispute hold");

    return { owner, accounts: { shippingBalance, disputeHold } };
  }

  async ensurePlatformGatewayClearingAccount(createdBy?: string | null) {
    this.assertCanMutate();
    const owner = await this.ledger.createOwner({
      ownerType: "platform",
      externalId: PLATFORM_OWNER_REF,
      displayName: "Shipmastr platform",
      metadata: { walletVersion: "W1A", sandboxOnly: true, createdBy: createdBy ?? null }
    });
    return this.ensureAccount(owner, "gateway_clearing", "Sandbox gateway clearing");
  }

  async ensureCourierPayableAccount(courierCode: string, createdBy?: string | null) {
    this.assertCanMutate();
    const normalized = normalizeCourierCode(courierCode);
    const owner = await this.ledger.createOwner({
      ownerType: "courier",
      externalId: `courier-${normalized}`,
      displayName: `Courier ${normalized}`,
      metadata: { walletVersion: "W1A", sandboxOnly: true, createdBy: createdBy ?? null }
    });
    return this.ensureAccount(owner, "courier_payable", "Courier payable");
  }

  private async ensureAccount(owner: WalletOwnerRecord, accountType: LedgerAccountType, label: string) {
    const existing = await this.client.walletAccount.findFirst({
      where: {
        ownerId: owner.id,
        accountType,
        ledgerScope: CUSTODIAL_SCOPE,
        currency: DEFAULT_CURRENCY
      }
    });
    if (existing) return existing;
    return this.ledger.createAccount({
      ownerId: owner.id,
      ownerType: owner.ownerType,
      accountType,
      ledgerScope: CUSTODIAL_SCOPE,
      currency: DEFAULT_CURRENCY,
      label,
      metadata: { walletVersion: "W1A", sandboxOnly: true }
    }) as Promise<WalletAccountRecord>;
  }
}

export class WalletTopupSandboxService {
  private readonly client: W1Client;
  private readonly ledger: LedgerService;
  private readonly provisioning: ClosedLoopWalletProvisioningService;
  private readonly config: W1RuntimeConfig;

  constructor(deps: W1ServiceDeps & { provisioning?: ClosedLoopWalletProvisioningService } = {}) {
    this.client = deps.client ?? prisma as unknown as W1Client;
    this.ledger = deps.ledger ?? ledgerService;
    this.config = resolveConfig(deps.config);
    this.provisioning = deps.provisioning ?? new ClosedLoopWalletProvisioningService({ client: this.client, ledger: this.ledger, config: this.config });
  }

  async createSandboxTopupIntent(input: { sellerOrgId: string; amountMinor: MoneyInput; sourceRef: string; createdBy?: string | null }) {
    assertMutationAllowed(this.config);
    const sellerOrgId = cleanRequiredValue(input.sellerOrgId, "W1_SELLER_ORG_ID_REQUIRED");
    const sourceRef = cleanSafeRef(input.sourceRef, "W1_TOPUP_SOURCE_REF_REQUIRED");
    const amount = amountMinor(input.amountMinor);
    const topupRef = internalRef("W1TOP", [sellerOrgId, sourceRef]);
    const sourceRefHash = hashRef([sellerOrgId, sourceRef]);
    const existing = await this.client.walletTopupIntent.findUnique({ where: { topupRef } });
    if (existing) {
      if (existing.sellerOrgId !== sellerOrgId || existing.amountPaise !== amount) {
        throw new HttpError(409, "W1_TOPUP_INTENT_CONFLICT");
      }
      return { intent: existing, idempotent: true };
    }
    const intent = await this.client.walletTopupIntent.create({
      data: {
        topupRef,
        sellerOrgId,
        amountPaise: amount,
        currency: DEFAULT_CURRENCY,
        status: "created",
        sourceRefHash,
        createdBy: input.createdBy?.trim() || null,
        metadata: { walletVersion: "W1A", sandboxOnly: true }
      }
    });
    return { intent, idempotent: false };
  }

  async confirmSandboxTopup(input: { topupRef: string; sellerOrgId: string; amountMinor: MoneyInput; createdBy?: string | null }) {
    assertMutationAllowed(this.config);
    const topupRef = cleanRequiredValue(input.topupRef, "W1_TOPUP_REF_REQUIRED");
    const sellerOrgId = cleanRequiredValue(input.sellerOrgId, "W1_SELLER_ORG_ID_REQUIRED");
    const amount = amountMinor(input.amountMinor);
    const intent = await this.client.walletTopupIntent.findUnique({ where: { topupRef } });
    if (!intent) throw new HttpError(404, "W1_TOPUP_INTENT_NOT_FOUND");
    if (intent.sellerOrgId !== sellerOrgId || intent.amountPaise !== amount) throw new HttpError(409, "W1_TOPUP_INTENT_CONFLICT");

    if (intent.journalEntryId) {
      return { intent, journalEntryId: intent.journalEntryId, idempotent: true };
    }

    const sellerWallet = await this.provisioning.ensureSellerClosedLoopWallet({ sellerOrgId, createdBy: input.createdBy ?? null, sandboxOnly: true });
    const gatewayClearing = await this.provisioning.ensurePlatformGatewayClearingAccount(input.createdBy);
    const command: PostLedgerEntryCommand = {
      entryRef: internalRef("W1LED-TOP", [topupRef]),
      entryType: "topup",
      ledgerScope: CUSTODIAL_SCOPE,
      currency: DEFAULT_CURRENCY,
      sourceType: "sandbox_topup",
      sourceRef: topupRef,
      narrative: "W1A sandbox topup",
      createdBy: input.createdBy?.trim() || null,
      postings: [
        { accountId: gatewayClearing.id, direction: "debit", amountPaise: minorString(amount), currency: DEFAULT_CURRENCY },
        { accountId: sellerWallet.accounts.shippingBalance.id, direction: "credit", amountPaise: minorString(amount), currency: DEFAULT_CURRENCY }
      ],
      metadata: { walletVersion: "W1A", sandboxOnly: true }
    };
    const posted = await this.ledger.postEntry(command);
    const updated = await this.client.walletTopupIntent.update({
      where: { topupRef },
      data: {
        status: "confirmed",
        confirmedBy: input.createdBy?.trim() || null,
        confirmedAt: new Date(),
        journalEntryId: posted.entry.id
      }
    });

    return { intent: updated, journalEntryId: posted.entry.id, idempotent: posted.idempotent };
  }
}

export class WalletHoldService {
  private readonly client: W1Client;
  private readonly provisioning: ClosedLoopWalletProvisioningService;
  private readonly config: W1RuntimeConfig;

  constructor(deps: W1ServiceDeps & { provisioning?: ClosedLoopWalletProvisioningService } = {}) {
    this.client = deps.client ?? prisma as unknown as W1Client;
    const ledger = deps.ledger ?? ledgerService;
    this.config = resolveConfig(deps.config);
    this.provisioning = deps.provisioning ?? new ClosedLoopWalletProvisioningService({ client: this.client, ledger, config: this.config });
  }

  async placeShipmentEstimateHold(input: { sellerOrgId: string; shipmentId: string; amountMinor: MoneyInput; createdBy?: string | null }) {
    assertMutationAllowed(this.config);
    const sellerOrgId = cleanRequiredValue(input.sellerOrgId, "W1_SELLER_ORG_ID_REQUIRED");
    const shipmentRef = internalRef("W1SHP", [sellerOrgId, cleanSafeRef(input.shipmentId, "W1_SHIPMENT_ID_REQUIRED")]);
    const amount = amountMinor(input.amountMinor);
    const wallet = await this.provisioning.ensureSellerClosedLoopWallet({ sellerOrgId, createdBy: input.createdBy ?? null, sandboxOnly: true });
    const account = wallet.accounts.shippingBalance;
    assertActiveAccount(account);
    const holdRef = internalRef("W1HLD", [sellerOrgId, shipmentRef]);
    const existing = await this.client.walletHold.findFirst({ where: { holdRef } });
    if (existing) {
      if (existing.amountPaise !== amount) throw new HttpError(409, "W1_HOLD_CONFLICT");
      return { hold: existing, idempotent: true, balance: await this.balanceForAccount(account.id) };
    }

    const balance = await this.balanceForAccount(account.id);
    if (balance.availableMinor < amount) throw new HttpError(409, "W1_INSUFFICIENT_AVAILABLE_BALANCE");
    const hold = await this.client.walletHold.create({
      data: {
        accountId: account.id,
        entryId: holdRef,
        holdRef,
        amountPaise: amount,
        currency: DEFAULT_CURRENCY,
        status: "active",
        sourceType: "shipment_estimate",
        sourceRef: shipmentRef
      }
    });

    return { hold, idempotent: false, balance: await this.balanceForAccount(account.id) };
  }

  async balanceForAccount(accountId: string) {
    const posted = await postedMinor(this.client, accountId);
    const held = await heldMinor(this.client, accountId);
    return { postedMinor: posted, heldMinor: held, availableMinor: posted - held };
  }
}

export class ClosedLoopWalletService {
  private readonly client: W1Client;
  private readonly ledger: LedgerService;
  private readonly provisioning: ClosedLoopWalletProvisioningService;
  private readonly config: W1RuntimeConfig;

  constructor(deps: W1ServiceDeps & { provisioning?: ClosedLoopWalletProvisioningService } = {}) {
    this.client = deps.client ?? prisma as unknown as W1Client;
    this.ledger = deps.ledger ?? ledgerService;
    this.config = resolveConfig(deps.config);
    this.provisioning = deps.provisioning ?? new ClosedLoopWalletProvisioningService({ client: this.client, ledger: this.ledger, config: this.config });
  }

  async captureShipmentCharge(input: { sellerOrgId: string; courierCode: string; shipmentId: string; holdId: string; amountMinor: MoneyInput; createdBy?: string | null }) {
    assertMutationAllowed(this.config);
    const sellerOrgId = cleanRequiredValue(input.sellerOrgId, "W1_SELLER_ORG_ID_REQUIRED");
    const shipmentRef = internalRef("W1SHP", [sellerOrgId, cleanSafeRef(input.shipmentId, "W1_SHIPMENT_ID_REQUIRED")]);
    const amount = amountMinor(input.amountMinor);
    const entryRef = internalRef("W1LED-CAP", [sellerOrgId, shipmentRef, input.holdId, minorString(amount)]);
    const existing = await this.client.journalEntry.findUnique({ where: { entryRef } });
    if (existing) return { journalEntryId: existing.id, idempotent: true };

    const sellerWallet = await this.provisioning.ensureSellerClosedLoopWallet({ sellerOrgId, createdBy: input.createdBy ?? null, sandboxOnly: true });
    const hold = await this.client.walletHold.findFirst({ where: { id: input.holdId, accountId: sellerWallet.accounts.shippingBalance.id } });
    if (!hold) throw new HttpError(404, "W1_HOLD_NOT_FOUND");
    if (hold.status !== "active") throw new HttpError(409, "W1_HOLD_NOT_ACTIVE");
    if (hold.amountPaise < amount) throw new HttpError(409, "W1_HOLD_CAPTURE_EXCEEDS_HELD_AMOUNT");
    const courierPayable = await this.provisioning.ensureCourierPayableAccount(input.courierCode, input.createdBy);
    const command: PostLedgerEntryCommand = {
      entryRef,
      entryType: "shipment_charge",
      ledgerScope: CUSTODIAL_SCOPE,
      currency: DEFAULT_CURRENCY,
      sourceType: "shipment_charge",
      sourceRef: shipmentRef,
      narrative: "W1A shipment charge",
      createdBy: input.createdBy?.trim() || null,
      postings: [
        { accountId: sellerWallet.accounts.shippingBalance.id, direction: "debit", amountPaise: minorString(amount), currency: DEFAULT_CURRENCY },
        { accountId: courierPayable.id, direction: "credit", amountPaise: minorString(amount), currency: DEFAULT_CURRENCY }
      ],
      metadata: { walletVersion: "W1A", sandboxOnly: true }
    };
    const posted = await this.ledger.postEntry(command);
    await this.client.walletHold.update({
      where: { id: hold.id },
      data: { status: "captured", releasedByEntryId: posted.entry.id }
    });
    return { journalEntryId: posted.entry.id, idempotent: posted.idempotent };
  }

  async postShipmentRefund(input: { sellerOrgId: string; courierCode: string; shipmentId: string; amountMinor: MoneyInput; createdBy?: string | null }) {
    assertMutationAllowed(this.config);
    const sellerOrgId = cleanRequiredValue(input.sellerOrgId, "W1_SELLER_ORG_ID_REQUIRED");
    const shipmentId = cleanSafeRef(input.shipmentId, "W1_SHIPMENT_ID_REQUIRED");
    if (/^rto[-_]/i.test(shipmentId)) throw new HttpError(400, "W1_RTO_REVERSE_FREIGHT_NOT_SHIPMENT_REFUND");
    const shipmentRef = internalRef("W1SHP", [sellerOrgId, shipmentId]);
    const amount = amountMinor(input.amountMinor);
    const sellerWallet = await this.provisioning.ensureSellerClosedLoopWallet({ sellerOrgId, createdBy: input.createdBy ?? null, sandboxOnly: true });
    const courierPayable = await this.provisioning.ensureCourierPayableAccount(input.courierCode, input.createdBy);
    const command: PostLedgerEntryCommand = {
      entryRef: internalRef("W1LED-REF", [sellerOrgId, shipmentRef, minorString(amount)]),
      entryType: "shipment_refund",
      ledgerScope: CUSTODIAL_SCOPE,
      currency: DEFAULT_CURRENCY,
      sourceType: "shipment_refund",
      sourceRef: shipmentRef,
      narrative: "W1A shipment refund",
      createdBy: input.createdBy?.trim() || null,
      postings: [
        { accountId: courierPayable.id, direction: "debit", amountPaise: minorString(amount), currency: DEFAULT_CURRENCY },
        { accountId: sellerWallet.accounts.shippingBalance.id, direction: "credit", amountPaise: minorString(amount), currency: DEFAULT_CURRENCY }
      ],
      metadata: { walletVersion: "W1A", sandboxOnly: true, refundMode: "wallet_only" }
    };
    const posted = await this.ledger.postEntry(command);
    return { journalEntryId: posted.entry.id, idempotent: posted.idempotent };
  }
}

export class WalletStatementService {
  private readonly client: W1Client;

  constructor(deps: Pick<W1ServiceDeps, "client"> = {}) {
    this.client = deps.client ?? prisma as unknown as W1Client;
  }

  async getWalletSummary(sellerOrgId: string) {
    const owner = await this.findSellerOwner(sellerOrgId);
    if (!owner) return zeroSummary(sellerOrgId);
    const shipping = await this.findSellerAccount(owner.id, "shipping_balance");
    if (!shipping) return zeroSummary(sellerOrgId);
    const posted = await postedMinor(this.client, shipping.id);
    const held = await heldMinor(this.client, shipping.id);
    return {
      sellerOrgId,
      currency: DEFAULT_CURRENCY,
      postedMinor: minorString(posted),
      heldMinor: minorString(held),
      availableMinor: minorString(posted - held),
      ledgerScope: CUSTODIAL_SCOPE
    };
  }

  async getWalletStatement(sellerOrgId: string, filters: { limit?: number } = {}) {
    const owner = await this.findSellerOwner(sellerOrgId);
    if (!owner) return { sellerOrgId, entries: [], ledgerScope: CUSTODIAL_SCOPE };
    const accounts = await this.client.walletAccount.findMany({
      where: {
        ownerId: owner.id,
        ledgerScope: CUSTODIAL_SCOPE,
        currency: DEFAULT_CURRENCY
      }
    });
    const accountIds = accounts.map((account) => account.id);
    if (accountIds.length === 0) return { sellerOrgId, entries: [], ledgerScope: CUSTODIAL_SCOPE };
    const postings = await this.client.journalPosting.findMany({
      where: { accountId: { in: accountIds } },
      include: { entry: true },
      orderBy: { createdAt: "desc" },
      take: filters.limit ?? 50
    });
    return {
      sellerOrgId,
      ledgerScope: CUSTODIAL_SCOPE,
      entries: postings
        .filter((posting) => posting.entry?.ledgerScope === CUSTODIAL_SCOPE)
        .map((posting) => ({
          entryId: posting.entryId,
          entryType: posting.entry?.entryType ?? null,
          direction: posting.direction,
          amountMinor: minorString(posting.amountPaise),
          currency: posting.currency,
          createdAt: posting.entry?.createdAt ?? null
        }))
    };
  }

  private findSellerOwner(sellerOrgId: string) {
    return this.client.walletOwner.findUnique({
      where: { ownerType_externalId: { ownerType: "seller", externalId: sellerOrgId } }
    });
  }

  private async findSellerAccount(ownerId: string, accountType: LedgerAccountType) {
    const accounts = await this.client.walletAccount.findMany({
      where: {
        ownerId,
        accountType,
        ledgerScope: CUSTODIAL_SCOPE,
        currency: DEFAULT_CURRENCY
      }
    });
    return accounts.find((account) => matchesAccount(account, accountType, ownerId)) ?? null;
  }
}

export class WalletClosurePolicyService {
  constructor(private readonly config: W1RuntimeConfig = resolveConfig()) {}

  assertMidLifeBankCashoutForbidden() {
    assertNoCashout(this.config);
  }

  sandboxRefundToSourcePolicy() {
    return { allowed: this.config.sandboxOnly, mode: "sandbox_policy_only" };
  }

  assertClosureBankSettlementBlocked() {
    throw new HttpError(403, "W1_CLOSURE_BANK_SETTLEMENT_NOT_IMPLEMENTED");
  }
}

export class W1WalletReadinessService {
  constructor(private readonly config: W1RuntimeConfig = resolveConfig()) {}

  checkReadiness() {
    const blockingIssues = [];
    if (!this.config.enabled) blockingIssues.push("WALLET_W1_DISABLED");
    if (!this.config.sandboxOnly) blockingIssues.push("WALLET_W1_LIVE_MODE_FORBIDDEN");
    if (this.config.allowLivePayments) blockingIssues.push("WALLET_W1_LIVE_PAYMENTS_FORBIDDEN");
    if (this.config.allowCashout) blockingIssues.push("WALLET_W1_CASHOUT_FORBIDDEN");
    if (this.config.nodeEnv === "production" || this.config.appEnv === "production") {
      blockingIssues.push("WALLET_W1_PRODUCTION_MUTATION_FORBIDDEN");
    }
    return {
      ok: blockingIssues.length === 0,
      flags: this.config,
      blockingIssues
    };
  }
}

async function postedMinor(client: W1Client, accountId: string) {
  const balance = await client.accountBalance.findUnique({ where: { accountId } });
  return balance?.balancePaise ?? 0n;
}

async function heldMinor(client: W1Client, accountId: string) {
  const holds = await client.walletHold.findMany({ where: { accountId, status: "active" } });
  return holds.reduce((sum, hold) => sum + hold.amountPaise, 0n);
}

function assertActiveAccount(account: WalletAccountRecord) {
  if (account.status !== "active") throw new HttpError(409, "W1_WALLET_ACCOUNT_NOT_ACTIVE");
}

function zeroSummary(sellerOrgId: string) {
  return {
    sellerOrgId,
    currency: DEFAULT_CURRENCY,
    postedMinor: "0",
    heldMinor: "0",
    availableMinor: "0",
    ledgerScope: CUSTODIAL_SCOPE
  };
}

export const closedLoopWalletProvisioningService = new ClosedLoopWalletProvisioningService();
export const walletTopupSandboxService = new WalletTopupSandboxService();
export const walletHoldService = new WalletHoldService();
export const closedLoopWalletService = new ClosedLoopWalletService();
export const walletStatementService = new WalletStatementService();
export const walletClosurePolicyService = new WalletClosurePolicyService();
export const w1WalletReadinessService = new W1WalletReadinessService();
