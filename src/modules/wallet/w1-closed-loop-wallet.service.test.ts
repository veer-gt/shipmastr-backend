import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { env } from "../../config/env.js";
import { HttpError } from "../../lib/httpError.js";
import {
  defaultAccountTypeConfigs,
  LedgerService,
  type LedgerAccountStatus,
  type LedgerAccountType,
  type LedgerOwnerType,
  type LedgerScope
} from "../walletLedger/ledger.service.js";
import {
  ClosedLoopWalletProvisioningService,
  ClosedLoopWalletService,
  W1WalletReadinessService,
  WalletClosurePolicyService,
  WalletHoldService,
  WalletStatementService,
  WalletTopupSandboxService,
  type W1RuntimeConfig
} from "./w1-closed-loop-wallet.service.js";
import { sellerOrgIdFromAuth } from "./w1-wallet-read.routes.js";
import { W1SandboxSmokeService } from "./w1c-sandbox-smoke.service.js";

const now = new Date("2026-07-05T06:30:00.000Z");
const enabledConfig: W1RuntimeConfig = {
  enabled: true,
  sandboxOnly: true,
  allowLivePayments: false,
  allowCashout: false,
  appEnv: "test",
  nodeEnv: "test"
};

type Owner = {
  id: string;
  ownerType: LedgerOwnerType;
  externalId: string | null;
  displayName: string | null;
};

type Account = {
  id: string;
  ownerId: string;
  ownerType: LedgerOwnerType;
  accountType: LedgerAccountType;
  accountClass: string;
  status: LedgerAccountStatus;
  ledgerScope: LedgerScope;
  currency: string;
};

type Entry = {
  id: string;
  entryRef: string;
  commandHash: string;
  entryType: string;
  ledgerScope: LedgerScope;
  currency: string;
  sourceType: string;
  sourceRef: string;
  narrative: string | null;
  createdBy: string | null;
  createdAt: Date;
  reversalOf?: string | null;
  metadata?: unknown;
};

type Posting = {
  id: string;
  entryId: string;
  accountId: string;
  direction: "debit" | "credit";
  amountPaise: bigint;
  currency: string;
};

function cloneState<T>(value: T): T {
  return structuredClone(value as never) as T;
}

function matchesWhere(record: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, value]) => {
    if (value && typeof value === "object" && "in" in value) {
      return (value.in as unknown[]).includes(record[key]);
    }
    return record[key] === value;
  });
}

function makeClient() {
  const state = {
    owners: [] as Owner[],
    accounts: [] as Account[],
    topups: [] as Array<{
      id: string;
      topupRef: string;
      sellerOrgId: string;
      amountPaise: bigint;
      currency: string;
      status: string;
      sourceRefHash: string;
      createdBy: string | null;
      confirmedBy: string | null;
      journalEntryId: string | null;
      confirmedAt: Date | null;
      metadata?: unknown;
      createdAt: Date;
      updatedAt: Date;
    }>,
    holds: [] as Array<{
      id: string;
      accountId: string;
      entryId: string;
      holdRef: string;
      amountPaise: bigint;
      currency: string;
      status: "active" | "released" | "captured" | "expired";
      sourceType: string;
      sourceRef: string;
      releasedByEntryId: string | null;
      createdAt: Date;
      updatedAt: Date;
    }>,
    entries: [] as Entry[],
    postings: [] as Posting[],
    balances: [] as Array<{ accountId: string; ledgerScope: LedgerScope; currency: string; balancePaise: bigint; lastJournalEntryId: string | null }>,
    outbox: [] as Array<Record<string, unknown>>,
    operations: [] as string[]
  };

  function tx() {
    return {
      $executeRaw: async () => {
        state.operations.push("ensure-balances");
        return { count: 0 };
      },
      $queryRaw: async () => {
        state.operations.push("lock-balances");
        return [];
      },
      accountTypeConfig: {
        findMany: async () => cloneState(defaultAccountTypeConfigs),
        findUnique: async ({ where }: { where: { accountType: LedgerAccountType } }) => cloneState(defaultAccountTypeConfigs.find((config) => config.accountType === where.accountType) ?? null)
      },
      walletOwner: {
        findUnique: async ({ where }: Record<string, any>) => {
          const key = where.ownerType_externalId;
          return cloneState(state.owners.find((owner) => owner.ownerType === key.ownerType && owner.externalId === key.externalId) ?? null);
        },
        create: async ({ data }: Record<string, any>) => {
          const owner = {
            id: `wo_${state.owners.length + 1}`,
            ownerType: data.ownerType,
            externalId: data.externalId ?? null,
            displayName: data.displayName ?? null
          };
          state.owners.push(owner);
          return cloneState(owner);
        }
      },
      walletAccount: {
        create: async ({ data }: Record<string, any>) => {
          const account = {
            id: `wa_${state.accounts.length + 1}`,
            ownerId: data.ownerId,
            ownerType: data.ownerType,
            accountType: data.accountType,
            accountClass: data.accountClass,
            status: data.status,
            ledgerScope: data.ledgerScope,
            currency: data.currency
          };
          state.accounts.push(account);
          return cloneState(account);
        },
        findFirst: async ({ where }: Record<string, any>) => cloneState(state.accounts.find((account) => matchesWhere(account as never, where)) ?? null),
        findMany: async ({ where }: Record<string, any>) => cloneState(state.accounts.filter((account) => matchesWhere(account as never, where)))
      },
      walletTopupIntent: {
        create: async ({ data }: Record<string, any>) => {
          const topup = {
            id: `wti_${state.topups.length + 1}`,
            topupRef: data.topupRef,
            sellerOrgId: data.sellerOrgId,
            amountPaise: BigInt(data.amountPaise),
            currency: data.currency,
            status: data.status,
            sourceRefHash: data.sourceRefHash,
            createdBy: data.createdBy ?? null,
            confirmedBy: null,
            journalEntryId: null,
            confirmedAt: null,
            metadata: data.metadata,
            createdAt: now,
            updatedAt: now
          };
          state.topups.push(topup);
          return cloneState(topup);
        },
        findUnique: async ({ where }: Record<string, any>) => cloneState(state.topups.find((topup) => topup.topupRef === where.topupRef || topup.id === where.id) ?? null),
        update: async ({ where, data }: Record<string, any>) => {
          const topup = state.topups.find((item) => item.topupRef === where.topupRef || item.id === where.id);
          if (!topup) throw new Error("topup missing");
          Object.assign(topup, data, { updatedAt: now });
          return cloneState(topup);
        }
      },
      walletHold: {
        create: async ({ data }: Record<string, any>) => {
          const hold = {
            id: `wh_${state.holds.length + 1}`,
            accountId: data.accountId,
            entryId: data.entryId,
            holdRef: data.holdRef,
            amountPaise: BigInt(data.amountPaise),
            currency: data.currency,
            status: data.status,
            sourceType: data.sourceType,
            sourceRef: data.sourceRef,
            releasedByEntryId: null,
            createdAt: now,
            updatedAt: now
          };
          state.holds.push(hold);
          return cloneState(hold);
        },
        findFirst: async ({ where }: Record<string, any>) => cloneState(state.holds.find((hold) => matchesWhere(hold as never, where)) ?? null),
        findMany: async ({ where }: Record<string, any>) => cloneState(state.holds.filter((hold) => matchesWhere(hold as never, where))),
        update: async ({ where, data }: Record<string, any>) => {
          const hold = state.holds.find((item) => item.id === where.id || item.holdRef === where.holdRef);
          if (!hold) throw new Error("hold missing");
          Object.assign(hold, data, { updatedAt: now });
          return cloneState(hold);
        }
      },
      journalEntry: {
        findUnique: async ({ where, include }: Record<string, any>) => {
          const entry = state.entries.find((item) => item.entryRef === where.entryRef || item.id === where.id);
          if (!entry) return null;
          return cloneState({
            ...entry,
            ...(include?.postings ? { postings: state.postings.filter((posting) => posting.entryId === entry.id) } : {})
          });
        },
        create: async ({ data }: Record<string, any>) => {
          if (state.entries.some((entry) => entry.entryRef === data.entryRef)) {
            const error = new Error("Unique constraint failed") as Error & { code: string };
            error.code = "P2002";
            throw error;
          }
          state.operations.push("entry-create");
          const entry = { id: `je_${state.entries.length + 1}`, createdAt: now, ...data };
          state.entries.push(entry);
          return cloneState(entry);
        }
      },
      journalPosting: {
        createMany: async ({ data }: Record<string, any>) => {
          for (const row of data) {
            state.postings.push({ id: `jp_${state.postings.length + 1}`, ...row });
          }
          return { count: data.length };
        },
        findMany: async ({ where, include }: Record<string, any>) => {
          const rows = state.postings.filter((posting) => matchesWhere(posting as never, where));
          return cloneState(rows.map((posting) => ({
            ...posting,
            ...(include?.entry ? { entry: state.entries.find((entry) => entry.id === posting.entryId) ?? null } : {})
          })));
        }
      },
      accountBalance: {
        upsert: async ({ where, create, update }: Record<string, any>) => {
          state.operations.push(`balance-upsert:${where.accountId}`);
          const existing = state.balances.find((balance) => balance.accountId === where.accountId);
          if (!existing) {
            const balance = {
              accountId: create.accountId,
              ledgerScope: create.ledgerScope,
              currency: create.currency,
              balancePaise: BigInt(create.balancePaise),
              lastJournalEntryId: create.lastJournalEntryId
            };
            state.balances.push(balance);
            return cloneState(balance);
          }
          existing.balancePaise += BigInt(update.balancePaise.increment);
          existing.lastJournalEntryId = update.lastJournalEntryId;
          return cloneState(existing);
        },
        findUnique: async ({ where }: Record<string, any>) => cloneState(state.balances.find((balance) => balance.accountId === where.accountId) ?? null),
        findMany: async ({ where }: Record<string, any>) => cloneState(state.balances.filter((balance) => matchesWhere(balance as never, where)))
      },
      walletEventsOutbox: {
        create: async ({ data }: Record<string, any>) => {
          const event = { id: `weo_${state.outbox.length + 1}`, createdAt: now, ...data };
          state.outbox.push(event);
          return cloneState(event);
        }
      }
    };
  }

  const client = {
    $transaction: async (callback: any) => callback(tx()),
    ...tx()
  };
  return { client: client as any, state };
}

function services(config: Partial<W1RuntimeConfig> = {}) {
  const { client, state } = makeClient();
  const ledger = new LedgerService(client);
  const mergedConfig = { ...enabledConfig, ...config };
  const provisioning = new ClosedLoopWalletProvisioningService({ client, ledger, config: mergedConfig });
  const topup = new WalletTopupSandboxService({ client, ledger, config: mergedConfig, provisioning });
  const hold = new WalletHoldService({ client, ledger, config: mergedConfig, provisioning });
  const wallet = new ClosedLoopWalletService({ client, ledger, config: mergedConfig, provisioning });
  const statement = new WalletStatementService({ client });
  return { client, state, ledger, provisioning, topup, hold, wallet, statement };
}

function smokeServices(config: Partial<W1RuntimeConfig> = {}) {
  const { client, state } = makeClient();
  const ledger = new LedgerService(client);
  const mergedConfig = { ...enabledConfig, ...config };
  const smoke = new W1SandboxSmokeService({ client, ledger, config: mergedConfig });
  return { client, state, ledger, smoke };
}

async function confirmedTopup(amountMinor = "10000") {
  const setup = services();
  const intent = await setup.topup.createSandboxTopupIntent({
    sellerOrgId: "seller_alpha",
    amountMinor,
    sourceRef: "sandbox_seed_alpha",
    createdBy: "internal_w1a"
  });
  await setup.topup.confirmSandboxTopup({
    sellerOrgId: "seller_alpha",
    topupRef: intent.intent.topupRef,
    amountMinor,
    createdBy: "internal_w1a"
  });
  return setup;
}

describe("W1A closed-loop shipping wallet foundation", () => {
  it("keeps safe feature flag defaults disabled and sandbox-only", () => {
    assert.equal(env.WALLET_W1_ENABLED, false);
    assert.equal(env.WALLET_W1_SANDBOX_ONLY, true);
    assert.equal(env.WALLET_W1_ALLOW_LIVE_PAYMENTS, false);
    assert.equal(env.WALLET_W1_ALLOW_CASHOUT, false);
  });

  it("refuses mutating commands in production or live mode", async () => {
    await assert.rejects(
      () => services({ appEnv: "production" }).provisioning.ensureSellerClosedLoopWallet({ sellerOrgId: "seller_alpha", createdBy: "internal", sandboxOnly: true }),
      /WALLET_W1_PRODUCTION_MUTATION_FORBIDDEN/
    );
    await assert.rejects(
      () => services({ sandboxOnly: false }).provisioning.ensureSellerClosedLoopWallet({ sellerOrgId: "seller_alpha", createdBy: "internal", sandboxOnly: true }),
      /WALLET_W1_LIVE_MODE_FORBIDDEN/
    );
    await assert.rejects(
      () => services({ allowLivePayments: true }).topup.createSandboxTopupIntent({ sellerOrgId: "seller_alpha", amountMinor: "100", sourceRef: "safe_ref", createdBy: "internal" }),
      /WALLET_W1_LIVE_PAYMENTS_FORBIDDEN/
    );
  });

  it("provisions seller shipping and dispute accounts idempotently without checkout or COD custody accounts", async () => {
    const { state, provisioning } = services();
    const first = await provisioning.ensureSellerClosedLoopWallet({ sellerOrgId: "seller_alpha", createdBy: "internal_w1a", sandboxOnly: true });
    const second = await provisioning.ensureSellerClosedLoopWallet({ sellerOrgId: "seller_alpha", createdBy: "internal_w1a", sandboxOnly: true });

    assert.equal(first.owner.id, second.owner.id);
    assert.equal(first.accounts.shippingBalance.id, second.accounts.shippingBalance.id);
    assert.equal(first.accounts.disputeHold.id, second.accounts.disputeHold.id);
    assert.deepEqual(state.accounts.map((account) => account.accountType).sort(), ["dispute_hold", "shipping_balance"]);
    assert.equal(state.accounts.some((account) => account.accountType === "checkout_balance"), false);
    assert.equal(state.accounts.some((account) => account.accountType === "cod_receivable" || account.accountType === "courier_cod_due"), false);
  });

  it("creates sandbox topup intents without posting ledger entries and detects amount conflicts", async () => {
    const { state, topup } = services();
    const first = await topup.createSandboxTopupIntent({ sellerOrgId: "seller_alpha", amountMinor: "5000", sourceRef: "sandbox_seed_alpha", createdBy: "internal_w1a" });
    const second = await topup.createSandboxTopupIntent({ sellerOrgId: "seller_alpha", amountMinor: "5000", sourceRef: "sandbox_seed_alpha", createdBy: "internal_w1a" });

    assert.equal(first.idempotent, false);
    assert.equal(second.idempotent, true);
    assert.equal(first.intent.topupRef, second.intent.topupRef);
    assert.equal(state.entries.length, 0);
    await assert.rejects(
      () => topup.createSandboxTopupIntent({ sellerOrgId: "seller_alpha", amountMinor: "6000", sourceRef: "sandbox_seed_alpha", createdBy: "internal_w1a" }),
      /W1_TOPUP_INTENT_CONFLICT/
    );
  });

  it("confirms sandbox topups through LedgerService and stays idempotent", async () => {
    const { state, topup } = services();
    const intent = await topup.createSandboxTopupIntent({ sellerOrgId: "seller_alpha", amountMinor: "7000", sourceRef: "sandbox_seed_alpha", createdBy: "internal_w1a" });
    const first = await topup.confirmSandboxTopup({ sellerOrgId: "seller_alpha", topupRef: intent.intent.topupRef, amountMinor: "7000", createdBy: "internal_w1a" });
    const second = await topup.confirmSandboxTopup({ sellerOrgId: "seller_alpha", topupRef: intent.intent.topupRef, amountMinor: "7000", createdBy: "internal_w1a" });

    assert.equal(first.idempotent, false);
    assert.equal(second.idempotent, true);
    assert.equal(first.journalEntryId, second.journalEntryId);
    assert.equal(state.entries.length, 1);
    assert.equal(state.entries[0]?.entryType, "topup");
    assert.equal(state.entries[0]?.ledgerScope, "custodial");
    assert.equal(state.entries[0]?.sourceType, "sandbox_topup");
    assert.equal(state.postings.length, 2);
    assert.equal(state.outbox.length, 1);
    assert.ok(state.operations.includes("entry-create"));
  });

  it("places shipment estimate holds, reduces available balance, and rejects insufficient holds", async () => {
    const { hold, statement } = await confirmedTopup("10000");
    const placed = await hold.placeShipmentEstimateHold({ sellerOrgId: "seller_alpha", shipmentId: "shipment_alpha", amountMinor: "4000", createdBy: "internal_w1a" });
    const summary = await statement.getWalletSummary("seller_alpha");

    assert.equal(placed.idempotent, false);
    assert.equal(summary.postedMinor, "10000");
    assert.equal(summary.heldMinor, "4000");
    assert.equal(summary.availableMinor, "6000");
    await assert.rejects(
      () => hold.placeShipmentEstimateHold({ sellerOrgId: "seller_alpha", shipmentId: "shipment_beta", amountMinor: "7000", createdBy: "internal_w1a" }),
      /W1_INSUFFICIENT_AVAILABLE_BALANCE/
    );
  });

  it("enforces account status guards before placing holds", async () => {
    for (const status of ["preview", "locked", "frozen", "closed"] as const) {
      const { state, hold, provisioning } = services();
      const wallet = await provisioning.ensureSellerClosedLoopWallet({ sellerOrgId: "seller_alpha", createdBy: "internal_w1a", sandboxOnly: true });
      const account = state.accounts.find((item) => item.id === wallet.accounts.shippingBalance.id);
      assert.ok(account);
      account.status = status;
      await assert.rejects(
        () => hold.placeShipmentEstimateHold({ sellerOrgId: "seller_alpha", shipmentId: `shipment_${status}`, amountMinor: "100", createdBy: "internal_w1a" }),
        /W1_WALLET_ACCOUNT_NOT_ACTIVE/
      );
    }
  });

  it("captures shipment charges, credits courier payable, and releases hold remainder", async () => {
    const { state, hold, wallet, statement } = await confirmedTopup("10000");
    const placed = await hold.placeShipmentEstimateHold({ sellerOrgId: "seller_alpha", shipmentId: "shipment_alpha", amountMinor: "4000", createdBy: "internal_w1a" });
    const capture = await wallet.captureShipmentCharge({
      sellerOrgId: "seller_alpha",
      courierCode: "BIGSHIP_SYNTHETIC",
      shipmentId: "shipment_alpha",
      holdId: placed.hold.id,
      amountMinor: "2500",
      createdBy: "internal_w1a"
    });
    const summary = await statement.getWalletSummary("seller_alpha");
    const captureEntry = state.entries.find((entry) => entry.id === capture.journalEntryId);
    const courierAccount = state.accounts.find((account) => account.accountType === "courier_payable");

    assert.equal(captureEntry?.entryType, "shipment_charge");
    assert.ok(courierAccount);
    assert.equal(state.postings.some((posting) => posting.accountId === courierAccount.id && posting.direction === "credit" && posting.amountPaise === 2500n), true);
    assert.equal(state.holds.find((item) => item.id === placed.hold.id)?.status, "captured");
    assert.equal(summary.postedMinor, "7500");
    assert.equal(summary.heldMinor, "0");
    assert.equal(summary.availableMinor, "7500");
  });

  it("rejects charge captures that exceed the held amount", async () => {
    const { hold, wallet } = await confirmedTopup("10000");
    const placed = await hold.placeShipmentEstimateHold({ sellerOrgId: "seller_alpha", shipmentId: "shipment_alpha", amountMinor: "1000", createdBy: "internal_w1a" });
    await assert.rejects(
      () => wallet.captureShipmentCharge({
        sellerOrgId: "seller_alpha",
        courierCode: "BIGSHIP_SYNTHETIC",
        shipmentId: "shipment_alpha",
        holdId: placed.hold.id,
        amountMinor: "2000",
        createdBy: "internal_w1a"
      }),
      /W1_HOLD_CAPTURE_EXCEEDS_HELD_AMOUNT/
    );
  });

  it("posts shipment refunds back to wallet only and does not treat RTO reverse freight as refund", async () => {
    const { state, wallet, statement } = await confirmedTopup("5000");
    const refund = await wallet.postShipmentRefund({
      sellerOrgId: "seller_alpha",
      courierCode: "BIGSHIP_SYNTHETIC",
      shipmentId: "shipment_alpha",
      amountMinor: "1200",
      createdBy: "internal_w1a"
    });
    const summary = await statement.getWalletSummary("seller_alpha");
    const entry = state.entries.find((item) => item.id === refund.journalEntryId);

    assert.equal(entry?.entryType, "shipment_refund");
    assert.equal(summary.postedMinor, "6200");
    assert.equal(state.entries.some((item) => item.entryType === "closure_bank_settlement" || item.entryType === "topup_refund"), false);
    await assert.rejects(
      () => wallet.postShipmentRefund({
        sellerOrgId: "seller_alpha",
        courierCode: "BIGSHIP_SYNTHETIC",
        shipmentId: "rto_reverse_alpha",
        amountMinor: "100",
        createdBy: "internal_w1a"
      }),
      /W1_RTO_REVERSE_FREIGHT_NOT_SHIPMENT_REFUND/
    );
  });

  it("returns string wallet balances and custodial-only statements while excluding shadow balances", async () => {
    const { state, ledger, statement } = await confirmedTopup("5000");
    const owner = await ledger.createOwner({ ownerType: "seller", externalId: "seller_alpha" });
    const shortfall = await ledger.createAccount({ ownerId: owner.id, ownerType: "seller", accountType: "seller_shortfall", ledgerScope: "shadow" });
    const shadowShipping = await ledger.createAccount({ ownerId: owner.id, ownerType: "seller", accountType: "shipping_balance", ledgerScope: "shadow" });
    await ledger.postEntry({
      entryRef: "shadow-alpha-control",
      entryType: "adjustment",
      ledgerScope: "shadow",
      currency: "INR",
      sourceType: "internal_shadow_test",
      sourceRef: "shadow-alpha-control",
      postings: [
        { accountId: shortfall.id, direction: "debit", amountPaise: "9000" },
        { accountId: shadowShipping.id, direction: "credit", amountPaise: "9000" }
      ]
    });

    const summary = await statement.getWalletSummary("seller_alpha");
    const ledgerStatement = await statement.getWalletStatement("seller_alpha");

    assert.equal(summary.postedMinor, "5000");
    assert.equal(summary.heldMinor, "0");
    assert.equal(summary.availableMinor, "5000");
    assert.equal(typeof summary.postedMinor, "string");
    assert.equal(ledgerStatement.entries.length, 1);
    assert.equal(ledgerStatement.entries[0]?.entryType, "topup");
    assert.equal(String(ledgerStatement.entries[0]?.sourceRef).startsWith("W1TOP-"), true);
    assert.equal(ledgerStatement.entries[0]?.narrative, "W1A sandbox topup");
    assert.equal(state.balances.some((balance) => balance.ledgerScope === "shadow" && balance.balancePaise === 9000n), true);
  });

  it("keeps closure and cashout policy blocked for W1A", () => {
    const policy = new WalletClosurePolicyService(enabledConfig);
    assert.throws(() => policy.assertMidLifeBankCashoutForbidden(), /WALLET_W1_CASHOUT_FORBIDDEN/);
    assert.deepEqual(policy.sandboxRefundToSourcePolicy(), { allowed: true, mode: "sandbox_policy_only" });
    assert.throws(() => policy.assertClosureBankSettlementBlocked(), /W1_CLOSURE_BANK_SETTLEMENT_NOT_IMPLEMENTED/);
  });

  it("reports readiness blockers for unsafe flags", () => {
    const readiness = new W1WalletReadinessService({
      enabled: false,
      sandboxOnly: false,
      allowLivePayments: true,
      allowCashout: true,
      appEnv: "production",
      nodeEnv: "production"
    });
    const result = readiness.checkReadiness();
    assert.equal(result.ok, false);
    assert.deepEqual(result.blockingIssues, [
      "WALLET_W1_DISABLED",
      "WALLET_W1_LIVE_MODE_FORBIDDEN",
      "WALLET_W1_LIVE_PAYMENTS_FORBIDDEN",
      "WALLET_W1_CASHOUT_FORBIDDEN",
      "WALLET_W1_PRODUCTION_MUTATION_FORBIDDEN"
    ]);
  });

  it("rejects public or buyer-resolvable refs before holds, topups, or ledger outbox payloads", async () => {
    const { state, topup, hold } = await confirmedTopup("2000");
    const buyerResolvableRefs = [
      ["a", "wb_123"].join(""),
      ["ord", "er_alpha"].join(""),
      ["buyer", "@", "example.invalid"].join(""),
      "9876543210",
      "110001"
    ];
    for (const sourceRef of buyerResolvableRefs) {
      await assert.rejects(
        () => topup.createSandboxTopupIntent({ sellerOrgId: "seller_alpha", amountMinor: "100", sourceRef, createdBy: "internal_w1a" }),
        /W1_PUBLIC_OR_PII_REF_FORBIDDEN/
      );
    }
    const buyerFacingShipmentRef = ["ord", "er_alpha"].join("");
    await assert.rejects(
      () => hold.placeShipmentEstimateHold({ sellerOrgId: "seller_alpha", shipmentId: buyerFacingShipmentRef, amountMinor: "100", createdBy: "internal_w1a" }),
      /W1_PUBLIC_OR_PII_REF_FORBIDDEN/
    );
    const payload = state.outbox[0]?.payload as Record<string, unknown>;
    assert.equal(String(payload.sourceRef).startsWith("W1TOP-"), true);
    const leakedRefPattern = new RegExp([
      ["a", "wb_"].join(""),
      ["ord", "er_"].join(""),
      "@",
      "9876543210",
      "110001"
    ].join("|"), "i");
    assert.equal(leakedRefPattern.test(JSON.stringify(state.outbox)), false);
  });

  it("keeps W1A source free of direct journal writes, float conversion, public controllers, and live integrations", () => {
    const source = readFileSync("src/modules/wallet/w1-closed-loop-wallet.service.ts", "utf8");
    const directWritePattern = new RegExp([
      ["journalEntry", "create"].join("\\."),
      ["journalPosting", "create"].join("\\."),
      ["accountBalance", "update"].join("\\."),
      ["walletEventsOutbox", "create"].join("\\.")
    ].join("|"));
    const floatPattern = new RegExp([
      ["parse", "Float"].join(""),
      ["Math", "round"].join("\\."),
      ["Num", "ber\\("].join("")
    ].join("|"));
    const liveIntegrationPattern = new RegExp([
      ["razor", "pay"].join(""),
      ["cash", "free"].join(""),
      ["settlement", "api"].join(" "),
      ["n", "8", "n"].join(""),
      ["cloud", "run"].join(" ")
    ].join("|"), "i");
    assert.equal(directWritePattern.test(source), false);
    assert.equal(floatPattern.test(source), false);
    assert.equal(/router|Router\(|express\(/.test(source), false);
    assert.equal(liveIntegrationPattern.test(source), false);
  });
});

describe("W1B wallet read surfaces", () => {
  it("mounts internal, admin, and seller W1 read routers behind the expected guards", () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");

    assert.match(routes, /apiRouter\.use\("\/internal\/wallet\/w1", requireInternalSecret, internalW1WalletRouter\);/);
    assert.match(routes, /apiRouter\.use\("\/admin\/wallets\/w1", requireAdminJwt, adminW1WalletRouter\);/);
    assert.match(routes, /apiRouter\.use\("\/seller\/wallet\/w1", requireJwtAuth, sellerW1WalletRouter\);/);
    assert.ok(routes.indexOf("apiRouter.use(\"/admin/wallets/w1\"") < routes.indexOf("apiRouter.use(\"/admin/wallets\""));
  });

  it("adds no mutating W1B wallet routes or cash movement actions", () => {
    const routeSource = readFileSync("src/modules/wallet/w1-wallet-read.routes.ts", "utf8");
    const mutatingRoutePattern = /\.(post|put|patch|delete)\(/;
    const movementTermPattern = new RegExp([
      "topup",
      "hold",
      "capture",
      "refund",
      "cashout",
      "payout",
      "settlement"
    ].join("|"), "i");

    assert.equal(mutatingRoutePattern.test(routeSource), false);
    assert.equal(movementTermPattern.test(routeSource), false);
  });

  it("derives seller wallet reads from authenticated seller scope only", () => {
    assert.equal(sellerOrgIdFromAuth({ userId: "user_1", merchantId: "seller_alpha", role: "SELLER" }), "seller_alpha");
    assert.throws(() => sellerOrgIdFromAuth(undefined), /Required|invalid_type/i);
  });

  it("reports disabled W1 readiness without throwing", () => {
    const readiness = new W1WalletReadinessService({
      enabled: false,
      sandboxOnly: true,
      allowLivePayments: false,
      allowCashout: false,
      appEnv: "test",
      nodeEnv: "test"
    }).checkReadiness();

    assert.equal(readiness.ok, false);
    assert.equal(readiness.flags.enabled, false);
    assert.deepEqual(readiness.blockingIssues, ["WALLET_W1_DISABLED"]);
  });

  it("blocks seller W1 reads when the feature is disabled", () => {
    const { client } = makeClient();
    const statement = new WalletStatementService({
      client: client as any,
      config: { ...enabledConfig, enabled: false }
    });

    assert.throws(() => statement.assertSellerReadAllowed(), /WALLET_W1_DISABLED/);
  });

  it("returns seller-safe string money summary when enabled", async () => {
    const { client } = await confirmedTopup("7000");
    const enabledStatement = new WalletStatementService({
      client: client as any,
      config: enabledConfig
    });

    enabledStatement.assertSellerReadAllowed();
    const summary = await enabledStatement.getWalletSummary("seller_alpha");

    assert.equal(summary.sellerOrgId, "seller_alpha");
    assert.equal(summary.scope, "custodial");
    assert.equal(summary.enabled, true);
    assert.equal(summary.sandboxOnly, true);
    assert.equal(summary.postedMinor, "7000");
    assert.equal(summary.heldMinor, "0");
    assert.equal(summary.availableMinor, "7000");
    assert.equal(summary.disputeHeldMinor, "0");
    assert.equal(summary.currency, "INR");
    assert.equal(summary.accountStatus, "active");
    assert.ok(summary.lastLedgerAt instanceof Date);
    assert.equal(typeof summary.postedMinor, "string");
    assert.equal(typeof summary.availableMinor, "string");
  });

  it("returns custodial statement entries only and excludes shadow balances from spendable reads", async () => {
    const { client, ledger } = await confirmedTopup("5000");
    const owner = await ledger.createOwner({ ownerType: "seller", externalId: "seller_alpha", displayName: "Shadow seller" });
    const shadow = await ledger.createAccount({
      ownerId: owner.id,
      ownerType: "seller",
      accountType: "shipping_balance",
      ledgerScope: "shadow",
      currency: "INR",
      label: "Shadow read exclusion"
    });
    await ledger.postEntry({
      entryRef: "W0-READSURFACE-SHADOW-A",
      entryType: "topup",
      ledgerScope: "shadow",
      currency: "INR",
      sourceType: "shadow_probe",
      sourceRef: "W0-READSURFACE-SHADOW-SRC",
      postings: [
        { accountId: shadow.id, direction: "debit", amountPaise: "9000" },
        { accountId: shadow.id, direction: "credit", amountPaise: "9000" }
      ]
    });

    const statement = new WalletStatementService({ client: client as any, config: enabledConfig });
    const summary = await statement.getWalletSummary("seller_alpha");
    const page = await statement.getWalletStatement("seller_alpha");

    assert.equal(summary.postedMinor, "5000");
    assert.equal(page.scope, "custodial");
    assert.equal(page.entries.length, 1);
    assert.equal(page.entries[0]?.amountMinor, "5000");
    assert.equal(page.entries.every((entry) => typeof entry.amountMinor === "string"), true);
  });

  it("sanitizes public refs and narratives from W1B statement output", async () => {
    const { client, state, ledger } = await confirmedTopup("1000");
    const sellerOwner = state.owners.find((owner) => owner.ownerType === "seller" && owner.externalId === "seller_alpha");
    assert.ok(sellerOwner);
    const shipping = state.accounts.find((account) => account.ownerId === sellerOwner.id && account.accountType === "shipping_balance");
    assert.ok(shipping);
    const unsafeEntry = {
      id: "je_public_ref",
      entryRef: "W1LED-PUBLICREF-aaaaaaaa",
      commandHash: "cmd_public_ref",
      entryType: "shipment_charge",
      ledgerScope: "custodial" as const,
      currency: "INR",
      sourceType: "shipment_charge",
      sourceRef: ["ord", "er_public"].join(""),
      narrative: ["buyer", " ", "em", "ail"].join(""),
      createdBy: "internal_w1b",
      createdAt: new Date("2026-07-05T07:00:00.000Z"),
      reversalOf: null,
      metadata: null
    };
    state.entries.push(unsafeEntry);
    state.postings.push({
      id: "jp_public_ref",
      entryId: unsafeEntry.id,
      accountId: shipping.id,
      direction: "debit",
      amountPaise: 100n,
      currency: "INR"
    });

    const statement = new WalletStatementService({ client: client as any, config: enabledConfig });
    const page = await statement.getWalletStatement("seller_alpha", { limit: 10 });
    const unsafe = page.entries.find((entry) => entry.entryId === unsafeEntry.id);

    assert.ok(unsafe);
    assert.equal(unsafe.sourceRef, null);
    assert.equal(unsafe.narrative, null);
    assert.equal(/@|9876543210|110001/i.test(JSON.stringify(page)), false);
  });

  it("keeps W1B read source free of direct writes, floats, public APIs, and live integrations", () => {
    const source = [
      readFileSync("src/modules/wallet/w1-wallet-read.routes.ts", "utf8"),
      readFileSync("src/modules/wallet/w1-closed-loop-wallet.service.ts", "utf8")
    ].join("\n");
    const directWritePattern = new RegExp([
      ["journalEntry", "create"].join("\\."),
      ["journalPosting", "create"].join("\\."),
      ["accountBalance", "update"].join("\\."),
      ["walletEventOutbox", "create"].join("\\.")
    ].join("|"));
    const floatPattern = new RegExp([
      ["parse", "Float"].join(""),
      ["Math", "round"].join("\\."),
      ["Num", "ber\\("].join("")
    ].join("|"));
    const liveIntegrationPattern = new RegExp([
      ["razor", "pay"].join(""),
      ["cash", "free"].join(""),
      ["bank", "payout"].join(" "),
      ["settlement", "api"].join(" "),
      ["n", "8", "n"].join(""),
      ["cloud", "run"].join(" ")
    ].join("|"), "i");

    assert.equal(directWritePattern.test(source), false);
    assert.equal(floatPattern.test(source), false);
    assert.equal(/Router\(\)\.(post|put|patch|delete)/.test(source), false);
    assert.equal(liveIntegrationPattern.test(source), false);
  });
});

describe("W1C sandbox operations smoke", () => {
  it("plans a dry-run without writing wallet rows", async () => {
    const { state, smoke } = smokeServices();
    const report = await smoke.run({ dryRun: true }) as any;

    assert.equal(report.dryRun, true);
    assert.equal(report.execute, false);
    assert.deepEqual(report.writes, { accounts: 0, intents: 0, holds: 0, entries: 0 });
    assert.equal(state.accounts.length, 0);
    assert.equal(state.topups.length, 0);
    assert.equal(state.holds.length, 0);
    assert.equal(state.entries.length, 0);
  });

  it("refuses execute in disabled, production, or live-like runtime", async () => {
    await assert.rejects(() => smokeServices({ enabled: false }).smoke.run({ execute: true }), /WALLET_W1_DISABLED/);
    await assert.rejects(() => smokeServices({ appEnv: "production" }).smoke.run({ execute: true }), /W1C_PRODUCTION_EXECUTE_FORBIDDEN/);
    await assert.rejects(() => smokeServices({ appEnv: "staging" }).smoke.run({ execute: true }), /W1C_LOCAL_TEST_EXECUTE_REQUIRED/);
    await assert.rejects(() => smokeServices({ sandboxOnly: false }).smoke.run({ execute: true }), /WALLET_W1_LIVE_MODE_FORBIDDEN/);
    await assert.rejects(() => smokeServices({ allowLivePayments: true }).smoke.run({ execute: true }), /WALLET_W1_LIVE_PAYMENTS_FORBIDDEN/);
  });

  it("executes the full sandbox flow and verifies final balances", async () => {
    const { state, smoke } = smokeServices();
    const report = await smoke.run({ execute: true }) as any;

    assert.equal(report.ok, true);
    assert.equal(report.dryRun, false);
    assert.equal(report.summaries.final.postedMinor, "65000");
    assert.equal(report.summaries.final.heldMinor, "0");
    assert.equal(report.summaries.final.availableMinor, "65000");
    assert.equal(report.amounts.releasedUnusedMinor, "3000");
    assert.equal(report.steps.refundMode, "wallet_only");
    assert.equal(state.holds.find((hold) => hold.id === report.steps.holdId)?.status, "captured");
    assert.deepEqual(report.blockers.map((blocker: { refused: boolean }) => blocker.refused), [true, true]);
    assert.equal(state.entries.map((entry) => entry.entryType).sort().join(","), "shipment_charge,shipment_refund,topup");
  });

  it("reruns idempotently without double posting", async () => {
    const { state, smoke } = smokeServices();
    const first = await smoke.run({ execute: true }) as any;
    const second = await smoke.run({ execute: true }) as any;

    assert.equal(first.summaries.final.availableMinor, "65000");
    assert.equal(second.summaries.final.availableMinor, "65000");
    assert.equal(second.idempotency.topupIntent, true);
    assert.equal(second.idempotency.topupConfirmation, true);
    assert.equal(second.idempotency.hold, true);
    assert.equal(second.idempotency.capture, true);
    assert.equal(second.idempotency.refund, true);
    assert.equal(state.entries.length, 3);
    assert.equal(state.outbox.length, 3);
  });

  it("detects conflicting deterministic amount reuse", async () => {
    const { smoke } = smokeServices();
    await smoke.run({ execute: true });

    await assert.rejects(
      () => smoke.run({ execute: true, amounts: { topupMinor: "100001" } }),
      /W1_TOPUP_INTENT_CONFLICT/
    );
  });

  it("keeps W1C statement custodial-only and excludes shadow rows", async () => {
    const { state, ledger, smoke } = smokeServices();
    await smoke.run({ execute: true });

    const owner = await ledger.createOwner({ ownerType: "seller", externalId: "org_w1c_sandbox_seller", displayName: "Shadow probe" });
    const shortfall = await ledger.createAccount({ ownerId: owner.id, ownerType: "seller", accountType: "seller_shortfall", ledgerScope: "shadow" });
    const shadowShipping = await ledger.createAccount({ ownerId: owner.id, ownerType: "seller", accountType: "shipping_balance", ledgerScope: "shadow" });
    await ledger.postEntry({
      entryRef: "W0-W1C-SHADOW-PROBE",
      entryType: "adjustment",
      ledgerScope: "shadow",
      currency: "INR",
      sourceType: "shadow_probe",
      sourceRef: "W0-W1C-SHADOW-SRC",
      postings: [
        { accountId: shortfall.id, direction: "debit", amountPaise: "9000" },
        { accountId: shadowShipping.id, direction: "credit", amountPaise: "9000" }
      ]
    });

    const report = await smoke.run({ execute: true }) as any;
    assert.equal(report.statement.scope, "custodial");
    assert.equal(report.statement.entries.length, 3);
    assert.equal(report.summaries.final.postedMinor, "65000");
    assert.equal(state.balances.some((balance) => balance.ledgerScope === "shadow"), true);
  });

  it("keeps generated report refs internal-safe", async () => {
    const { smoke } = smokeServices();
    const report = await smoke.run({ execute: true }) as any;
    const unsafePattern = new RegExp([
      ["a", "wb"].join(""),
      ["ord", "er_"].join(""),
      ["pho", "ne"].join(""),
      ["em", "ail"].join(""),
      ["addr", "ess"].join(""),
      ["pin", "code"].join(""),
      "@",
      "9876543210",
      "110001"
    ].join("|"), "i");

    assert.equal(unsafePattern.test(JSON.stringify(report)), false);
  });

  it("keeps W1C source free of direct ledger writes, float conversion, routes, and live integrations", () => {
    const source = [
      readFileSync("src/modules/wallet/w1c-sandbox-smoke.service.ts", "utf8"),
      readFileSync("scripts/wallet-w1c-sandbox-smoke.mjs", "utf8")
    ].join("\n");
    const directWritePattern = new RegExp([
      ["journalEntry", "create"].join("\\."),
      ["journalPosting", "create"].join("\\."),
      ["accountBalance", "update"].join("\\."),
      ["walletEventOutbox", "create"].join("\\.")
    ].join("|"));
    const floatPattern = new RegExp([
      ["parse", "Float"].join(""),
      ["Math", "round"].join("\\."),
      ["Num", "ber\\("].join("")
    ].join("|"));
    const liveIntegrationPattern = new RegExp([
      ["razor", "pay"].join(""),
      ["cash", "free"].join(""),
      ["bank", "payout"].join(" "),
      ["settlement", "api"].join(" "),
      ["n", "8", "n"].join(""),
      ["cloud", "run"].join(" ")
    ].join("|"), "i");

    assert.equal(directWritePattern.test(source), false);
    assert.equal(floatPattern.test(source), false);
    assert.equal(/Router\(|\.(post|put|patch|delete)\(/.test(source), false);
    assert.equal(liveIntegrationPattern.test(source), false);
  });
});
