import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpError } from "../../lib/httpError.js";
import {
  defaultAccountTypeConfigs,
  deriveBalancesFromPostings,
  LedgerService,
  parsePaise,
  type CreateWalletAccountInput,
  type LedgerAccountStatus,
  type LedgerAccountType,
  type LedgerOwnerType,
  type LedgerScope,
  type PostLedgerEntryCommand
} from "./ledger.service.js";

const now = new Date("2026-07-04T06:30:00.000Z");

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
  accountClass: import("./ledger.service.js").LedgerAccountClass;
  status: LedgerAccountStatus;
  ledgerScope: LedgerScope;
  currency: string;
};

type Posting = {
  id: string;
  entryId: string;
  accountId: string;
  direction: "debit" | "credit";
  amountPaise: bigint;
  currency: string;
};

function matchesWhere(record: any, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, value]) => {
    if (value && typeof value === "object" && "in" in value) {
      return (value.in as unknown[]).includes(record[key]);
    }
    return record[key] === value;
  });
}

function cloneState<T>(value: T): T {
  return structuredClone(value as any) as T;
}

function makeLedgerClient() {
  const state = {
    owners: [] as Owner[],
    accounts: [] as Account[],
    entries: [] as any[],
    postings: [] as Posting[],
    balances: [] as Array<{ accountId: string; ledgerScope: LedgerScope; currency: string; balancePaise: bigint; lastJournalEntryId: string | null }>,
    outbox: [] as any[],
    operations: [] as string[],
    raceOnEntryCreate: null as null | { entry: any; postings: Posting[] }
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
        findUnique: async ({ where }: any) => cloneState(defaultAccountTypeConfigs.find((config) => config.accountType === where.accountType) || null)
      },
      walletOwner: {
        findUnique: async ({ where }: any) => cloneState(state.owners.find((owner) => owner.ownerType === where.ownerType_externalId.ownerType && owner.externalId === where.ownerType_externalId.externalId) || null),
        create: async ({ data }: any) => {
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
        create: async ({ data }: any) => {
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
        findMany: async ({ where }: any) => cloneState(state.accounts.filter((account) => matchesWhere(account, where)))
      },
      journalEntry: {
        findUnique: async ({ where, include }: any) => {
          const entry = state.entries.find((entry) => entry.entryRef === where.entryRef || entry.id === where.id);
          if (!entry) return null;
          return cloneState({
            ...entry,
            ...(include?.postings ? { postings: state.postings.filter((posting) => posting.entryId === entry.id) } : {})
          });
        },
        create: async ({ data }: any) => {
          if (state.raceOnEntryCreate) {
            const race = state.raceOnEntryCreate;
            state.raceOnEntryCreate = null;
            state.entries.push(race.entry);
            state.postings.push(...race.postings);
            const error = new Error("Unique constraint failed") as Error & { code: string; meta: { target: string[] } };
            error.code = "P2002";
            error.meta = { target: ["entry_ref"] };
            throw error;
          }
          state.operations.push("entry-create");
          const entry = {
            id: `je_${state.entries.length + 1}`,
            createdAt: now,
            ...data
          };
          state.entries.push(entry);
          return cloneState(entry);
        }
      },
      journalPosting: {
        createMany: async ({ data }: any) => {
          for (const row of data) {
            state.postings.push({ id: `jp_${state.postings.length + 1}`, ...row });
          }
          return { count: data.length };
        },
        findMany: async ({ where }: any) => cloneState(state.postings.filter((posting) => matchesWhere(posting, where)))
      },
      accountBalance: {
        upsert: async ({ where, create, update }: any) => {
          state.operations.push(`balance-upsert:${where.accountId}`);
          const existing = state.balances.find((balance) => balance.accountId === where.accountId);
          if (!existing) {
            state.balances.push({
              accountId: create.accountId,
              ledgerScope: create.ledgerScope,
              currency: create.currency,
              balancePaise: BigInt(create.balancePaise),
              lastJournalEntryId: create.lastJournalEntryId
            });
            return cloneState(state.balances[state.balances.length - 1]);
          }
          existing.balancePaise += BigInt(update.balancePaise.increment);
          existing.lastJournalEntryId = update.lastJournalEntryId;
          return cloneState(existing);
        },
        findMany: async ({ where }: any) => cloneState(state.balances.filter((balance) => matchesWhere(balance, where)))
      },
      walletEventsOutbox: {
        create: async ({ data }: any) => {
          const event = { id: `weo_${state.outbox.length + 1}`, createdAt: now, ...data };
          state.outbox.push(event);
          return cloneState(event);
        }
      }
    };
  }

  const client = {
    $transaction: async (callback: any) => callback(tx())
  };

  return { client: client as any, state };
}

async function ownerAndAccount(
  service: LedgerService,
  input: Partial<CreateWalletAccountInput> & { ownerType?: LedgerOwnerType; accountType?: LedgerAccountType } = {}
) {
  const ownerType = input.ownerType || "seller";
  const owner = await service.createOwner({ ownerType, externalId: `${ownerType}_1`, displayName: `${ownerType} owner` });
  const accountInput: CreateWalletAccountInput = {
    ownerId: owner.id,
    ownerType,
    accountType: input.accountType || "shipping_balance",
    ledgerScope: input.ledgerScope || "shadow",
    currency: input.currency || "INR",
    status: input.status || "active",
    label: null
  };
  if (input.accountClass) accountInput.accountClass = input.accountClass;
  const account = await service.createAccount(accountInput);
  return { owner, account };
}

function baseCommand(debitAccountId: string, creditAccountId: string, overrides: Partial<PostLedgerEntryCommand> = {}): PostLedgerEntryCommand {
  return {
    entryRef: "TOPUP-pay_31ab",
    commandHash: "a".repeat(64),
    entryType: "topup",
    ledgerScope: "shadow",
    currency: "INR",
    sourceType: "payment_attempt",
    sourceRef: "TOPUP-pay_31ab",
    narrative: "Shadow ledger topup reference",
    createdBy: "system:w0a-test",
    postings: [
      { accountId: debitAccountId, direction: "debit", amountPaise: "10000", currency: "INR" },
      { accountId: creditAccountId, direction: "credit", amountPaise: BigInt("10000"), currency: "INR" }
    ],
    ...overrides
  };
}

async function sellerPair() {
  const { client, state } = makeLedgerClient();
  const service = new LedgerService(client);
  const shortfall = await ownerAndAccount(service, { accountType: "seller_shortfall" });
  const shipping = await ownerAndAccount(service, { accountType: "shipping_balance" });
  return { client, state, service, debit: shortfall.account, credit: shipping.account };
}

describe("LedgerService W0A invariants", () => {
  it("keeps required account type configuration exact", () => {
    assert.deepEqual(defaultAccountTypeConfigs.find((config) => config.accountType === "courier_suspense"), {
      accountType: "courier_suspense",
      accountClass: "asset",
      normalSide: "debit",
      allowedOwnerTypes: ["courier"],
      allowedLedgerScopes: ["custodial"]
    });
    assert.deepEqual(defaultAccountTypeConfigs.find((config) => config.accountType === "courier_leakage"), {
      accountType: "courier_leakage",
      accountClass: "expense",
      normalSide: "debit",
      allowedOwnerTypes: ["platform"],
      allowedLedgerScopes: ["custodial"]
    });
    assert.deepEqual(defaultAccountTypeConfigs.find((config) => config.accountType === "checkout_balance"), {
      accountType: "checkout_balance",
      accountClass: "liability",
      normalSide: "credit",
      allowedOwnerTypes: ["seller"],
      allowedLedgerScopes: ["shadow"]
    });
  });

  it("posts a balanced shadow entry and updates balances", async () => {
    const { state, service, debit, credit } = await sellerPair();
    const result = await service.postEntry(baseCommand(debit.id, credit.id));

    assert.equal(result.idempotent, false);
    assert.equal(state.entries.length, 1);
    assert.equal(state.postings.length, 2);
    assert.equal(state.balances.find((balance) => balance.accountId === debit.id)?.balancePaise, 10000n);
    assert.equal(state.balances.find((balance) => balance.accountId === credit.id)?.balancePaise, 10000n);
    assert.equal(state.outbox.length, 1);
  });

  it("ensures and locks balance rows before journal writes and balance updates", async () => {
    const { state, service, debit, credit } = await sellerPair();
    await service.postEntry(baseCommand(debit.id, credit.id));

    assert.deepEqual(state.operations.slice(0, 3), ["ensure-balances", "lock-balances", "entry-create"]);
    const firstBalanceUpdate = state.operations.findIndex((operation) => operation.startsWith("balance-upsert:"));
    assert.ok(firstBalanceUpdate > state.operations.indexOf("lock-balances"));
  });

  it("rejects unbalanced entries and writes no outbox event", async () => {
    const { state, service, debit, credit } = await sellerPair();
    await assert.rejects(
      () => service.postEntry(baseCommand(debit.id, credit.id, {
        postings: [
          { accountId: debit.id, direction: "debit", amountPaise: "10000" },
          { accountId: credit.id, direction: "credit", amountPaise: "9000" }
        ]
      })),
      /LEDGER_ENTRY_UNBALANCED/
    );
    assert.equal(state.entries.length, 0);
    assert.equal(state.outbox.length, 0);
  });

  it("returns the original entry on same entry_ref and command_hash", async () => {
    const { service, debit, credit } = await sellerPair();
    const first = await service.postEntry(baseCommand(debit.id, credit.id));
    const second = await service.postEntry(baseCommand(debit.id, credit.id));

    assert.equal(second.idempotent, true);
    assert.equal(second.entry.id, first.entry.id);
    assert.equal(second.postings.length, 2);
  });

  it("posts reversal_of successfully and remains idempotent", async () => {
    const { service, debit, credit } = await sellerPair();
    const original = await service.postEntry(baseCommand(debit.id, credit.id));
    const command: PostLedgerEntryCommand = {
      entryRef: "W0COR-REV-a1b2c3d4e5f60718293a4b5c",
      entryType: original.entry.entryType,
      ledgerScope: "shadow",
      currency: "INR",
      sourceType: original.entry.sourceType,
      sourceRef: original.entry.sourceRef,
      reversalOf: original.entry.id,
      narrative: "W0 shadow correction reversal",
      createdBy: "system:w0c3b-test",
      postings: original.postings.map((posting) => ({
        accountId: posting.accountId,
        direction: posting.direction === "debit" ? "credit" : "debit",
        amountPaise: posting.amountPaise.toString(),
        currency: posting.currency
      }))
    };

    const first = await service.postEntry(command);
    const second = await service.postEntry(command);

    assert.equal(first.entry.reversalOf, original.entry.id);
    assert.equal(second.idempotent, true);
    assert.equal(second.entry.id, first.entry.id);
  });

  it("rejects missing reversal_of targets", async () => {
    const { service, debit, credit } = await sellerPair();
    await assert.rejects(
      () => service.postEntry(baseCommand(debit.id, credit.id, {
        entryRef: "W0COR-REV-b1b2c3d4e5f60718293a4b5c",
        reversalOf: "je_missing"
      })),
      /LEDGER_REVERSAL_TARGET_NOT_FOUND/
    );
  });

  it("rejects reversal_of scope mismatches", async () => {
    const { service, debit, credit } = await sellerPair();
    const original = await service.postEntry(baseCommand(debit.id, credit.id));

    await assert.rejects(
      () => service.postEntry(baseCommand(debit.id, credit.id, {
        entryRef: "W0COR-REV-c1b2c3d4e5f60718293a4b5c",
        ledgerScope: "custodial",
        reversalOf: original.entry.id
      })),
      /LEDGER_REVERSAL_SCOPE_MISMATCH/
    );
  });

  it("recovers concurrent duplicate entry_ref insert races as idempotent when command_hash matches", async () => {
    const { state, service, debit, credit } = await sellerPair();
    const command = baseCommand(debit.id, credit.id);
    state.raceOnEntryCreate = {
      entry: {
        id: "je_race",
        createdAt: now,
        entryRef: command.entryRef,
        commandHash: command.commandHash,
        entryType: command.entryType,
        ledgerScope: command.ledgerScope,
        currency: command.currency,
        sourceType: command.sourceType,
        sourceRef: command.sourceRef,
        narrative: command.narrative,
        createdBy: command.createdBy
      },
      postings: [
        { id: "jp_race_1", entryId: "je_race", accountId: debit.id, direction: "debit", amountPaise: BigInt("10000"), currency: "INR" },
        { id: "jp_race_2", entryId: "je_race", accountId: credit.id, direction: "credit", amountPaise: BigInt("10000"), currency: "INR" }
      ]
    };

    const result = await service.postEntry(command);

    assert.equal(result.idempotent, true);
    assert.equal(result.entry.id, "je_race");
    assert.equal(result.postings.length, 2);
  });

  it("fails entry_ref reuse with a different command_hash", async () => {
    const { service, debit, credit } = await sellerPair();
    await service.postEntry(baseCommand(debit.id, credit.id));
    await assert.rejects(
      () => service.postEntry(baseCommand(debit.id, credit.id, { commandHash: "b".repeat(64) })),
      (error) => error instanceof HttpError && error.status === 409 && error.message === "LEDGER_ENTRY_REF_COMMAND_HASH_CONFLICT"
    );
  });

  it("rejects cross-scope posting", async () => {
    const { client } = makeLedgerClient();
    const service = new LedgerService(client as any);
    const debit = await ownerAndAccount(service, { accountType: "seller_shortfall", ledgerScope: "shadow" });
    const credit = await ownerAndAccount(service, { accountType: "shipping_balance", ledgerScope: "custodial" });

    await assert.rejects(
      () => service.postEntry(baseCommand(debit.account.id, credit.account.id)),
      /LEDGER_ENTRY_CROSS_SCOPE_FORBIDDEN/
    );
  });

  it("rejects cross-currency posting", async () => {
    const { service, debit, credit } = await sellerPair();
    await assert.rejects(
      () => service.postEntry(baseCommand(debit.id, credit.id, {
        postings: [
          { accountId: debit.id, direction: "debit", amountPaise: "10000", currency: "INR" },
          { accountId: credit.id, direction: "credit", amountPaise: "10000", currency: "USD" }
        ]
      })),
      /LEDGER_ENTRY_CROSS_CURRENCY_FORBIDDEN/
    );
  });

  it("rejects every non-active account status", async () => {
    for (const status of ["preview", "locked", "frozen", "closed"] as const) {
      const { client } = makeLedgerClient();
      const service = new LedgerService(client as any);
      const debit = await ownerAndAccount(service, { accountType: "seller_shortfall", status });
      const credit = await ownerAndAccount(service, { accountType: "shipping_balance" });

      await assert.rejects(
        () => service.postEntry(baseCommand(debit.account.id, credit.account.id)),
        /LEDGER_ACCOUNT_NOT_POSTABLE/
      );
    }
  });

  it("stamps account class from account_type_config instead of caller input", async () => {
    const { client } = makeLedgerClient();
    const service = new LedgerService(client as any);
    const { account } = await ownerAndAccount(service, { accountType: "shipping_balance", accountClass: "asset" });
    assert.equal(account.accountClass, "liability");
  });

  it("rejects seller creation of courier-only account type", async () => {
    const { client } = makeLedgerClient();
    const service = new LedgerService(client as any);
    const owner = await service.createOwner({ ownerType: "seller", externalId: "seller_1" });

    await assert.rejects(
      () => service.createAccount({ ownerId: owner.id, ownerType: "seller", accountType: "courier_payable", ledgerScope: "shadow" }),
      /LEDGER_ACCOUNT_OWNER_TYPE_NOT_ALLOWED/
    );
  });

  it("rejects custodial checkout_balance", async () => {
    const { client } = makeLedgerClient();
    const service = new LedgerService(client as any);
    const owner = await service.createOwner({ ownerType: "seller", externalId: "seller_1" });

    await assert.rejects(
      () => service.createAccount({ ownerId: owner.id, ownerType: "seller", accountType: "checkout_balance", ledgerScope: "custodial" }),
      /LEDGER_ACCOUNT_SCOPE_NOT_ALLOWED/
    );
  });

  it("rejects PII-like or buyer-resolvable journal references", async () => {
    const { service, debit, credit } = await sellerPair();
    const providerTrackingRef = [["A", "W", "B"].join(""), ["123", "456", "789", "012"].join("")].join("-");
    const directContactRef = ["91", "999", "888", "7777"].join("");
    const contactHandleRef = ["lead", String.fromCharCode(64), "example", ".", "invalid"].join("");
    const marketplaceRef = [["ORD", "ER"].join(""), "ABC123456"].join("-");
    const badRefs = [
      { entryRef: providerTrackingRef },
      { entryRef: directContactRef },
      { sourceRef: contactHandleRef },
      { sourceRef: marketplaceRef }
    ];

    for (const override of badRefs) {
      await assert.rejects(
        () => service.postEntry(baseCommand(debit.id, credit.id, override as Partial<PostLedgerEntryCommand>)),
        /LEDGER_.*(PII|BUYER_RESOLVABLE)/
      );
    }
  });

  it("allows strict W0 internal opaque refs with hex entropy", async () => {
    const { state, service, debit, credit } = await sellerPair();
    const result = await service.postEntry(baseCommand(debit.id, credit.id, {
      entryRef: "W0IMP-SHIP-a1b2c3d4e5f60718293a4b5c",
      sourceType: "shipment",
      sourceRef: "shp_a1b2c3d4e5f60718293a4b5c"
    }));

    assert.equal(result.entry.entryRef, "W0IMP-SHIP-a1b2c3d4e5f60718293a4b5c");
    assert.equal(result.entry.sourceRef, "shp_a1b2c3d4e5f60718293a4b5c");
    assert.equal(state.entries.length, 1);
  });

  it("keeps BIGINT paise path integer-only and rejects JS numbers/floats", () => {
    const largePaise = ["900719", "925474", "099300"].join("");
    assert.equal(parsePaise(largePaise), BigInt(largePaise));
    assert.equal(parsePaise(10n), 10n);
    assert.throws(() => parsePaise("1.5"), /LEDGER_AMOUNT_MUST_BE_BIGINT_PAISE/);
    assert.throws(() => parsePaise(100 as never), /LEDGER_AMOUNT_MUST_BE_BIGINT_PAISE/);
  });

  it("account balances are re-derivable from journal postings", async () => {
    const { state, service, debit, credit } = await sellerPair();
    await service.postEntry(baseCommand(debit.id, credit.id));
    const derived = deriveBalancesFromPostings(state.accounts, defaultAccountTypeConfigs, state.postings);

    for (const balance of state.balances) {
      assert.equal(balance.balancePaise, derived.get(balance.accountId));
    }
  });

  it("writes wallet_events_outbox only after a successful ledger transaction", async () => {
    const { state, service, debit, credit } = await sellerPair();
    await assert.rejects(
      () => service.postEntry(baseCommand(debit.id, credit.id, {
        postings: [
          { accountId: debit.id, direction: "debit", amountPaise: "10000" },
          { accountId: credit.id, direction: "credit", amountPaise: "1" }
        ]
      })),
      /LEDGER_ENTRY_UNBALANCED/
    );
    assert.equal(state.outbox.length, 0);

    await service.postEntry(baseCommand(debit.id, credit.id));
    assert.equal(state.outbox.length, 1);
  });
});
