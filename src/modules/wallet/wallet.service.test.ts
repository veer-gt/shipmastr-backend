import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Prisma } from "@prisma/client";
import {
  appendLedgerEntry,
  deriveWalletBalanceFromLedger,
  getBalance,
  listMerchantWallets,
  listLedgerEntries,
  reconcileBalance
} from "./wallet.service.js";
import { serializeWalletLedgerEntry } from "./wallet.serializer.js";

const now = new Date("2026-06-17T12:00:00.000Z");

function makeLedgerEntry(input: any) {
  return {
    id: String(input.id ?? `ledger_${Math.random().toString(16).slice(2)}`),
    merchantId: String(input.merchantId ?? "merchant_1"),
    orderId: input.orderId ?? null,
    awb: input.awb ?? null,
    entryType: String(input.entryType ?? "TEST"),
    direction: String(input.direction ?? "CREDIT"),
    amount: new Prisma.Decimal(String(input.amount ?? "0")),
    currency: String(input.currency ?? "INR"),
    status: String(input.status ?? "POSTED"),
    balanceBefore: input.balanceBefore == null ? null : new Prisma.Decimal(String(input.balanceBefore)),
    balanceAfter: input.balanceAfter == null ? null : new Prisma.Decimal(String(input.balanceAfter)),
    referenceType: input.referenceType ?? null,
    referenceId: input.referenceId ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    description: input.description ?? null,
    metadata: input.metadata ?? null,
    createdBy: input.createdBy ?? null,
    postedAt: input.postedAt ?? now,
    reversedByLedgerId: input.reversedByLedgerId ?? null,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now
  };
}

function makeClient(seed: Array<Record<string, unknown>> = []) {
  const state = {
    merchants: [
      { id: "merchant_1", name: "Merchant One", email: "merchant-one@example.test", onboardingStatus: "READY_TO_SHIP", createdAt: now },
      { id: "merchant_2", name: "Merchant Two", email: "merchant-two@example.test", onboardingStatus: "PENDING", createdAt: now }
    ],
    entries: seed.map(makeLedgerEntry),
    auditLogs: [] as any[]
  };

  const client = {
    merchant: {
      findUnique: async ({ where }: any) => state.merchants.find((merchant) => merchant.id === where.id) ?? null,
      findMany: async ({ take, where }: any = {}) => {
        const search = where?.OR?.[0]?.id?.contains;
        const rows = search
          ? state.merchants.filter((merchant) => merchant.id.includes(search) || merchant.name.includes(search) || merchant.email.includes(search))
          : state.merchants;
        return rows.slice(0, take ?? rows.length);
      }
    },
    sellerWalletLedger: {
      findMany: async ({ where, orderBy, take, cursor, skip, select }: any = {}) => {
        let rows = state.entries.filter((entry) => !where?.merchantId || entry.merchantId === where.merchantId);
        if (where?.direction) rows = rows.filter((entry) => entry.direction === where.direction);
        if (where?.status) rows = rows.filter((entry) => entry.status === where.status);
        if (where?.entryType) rows = rows.filter((entry) => entry.entryType === where.entryType);
        if (where?.createdAt?.gte) rows = rows.filter((entry) => new Date(entry.createdAt) >= new Date(where.createdAt.gte));
        if (where?.createdAt?.lte) rows = rows.filter((entry) => new Date(entry.createdAt) <= new Date(where.createdAt.lte));
        if (cursor?.id) {
          const index = rows.findIndex((entry) => entry.id === cursor.id);
          rows = index >= 0 ? rows.slice(index + (skip ?? 0)) : rows;
        }
        const desc = Array.isArray(orderBy) && Object.values(orderBy[0] ?? {})[0] === "desc";
        rows = [...rows].sort((left, right) => {
          const byTime = new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
          return desc ? -byTime : byTime;
        });
        if (take) rows = rows.slice(0, take);
        if (select) {
          return rows.map((entry) => Object.fromEntries(Object.keys(select).map((key) => [key, (entry as any)[key]])));
        }
        return rows;
      },
      findUnique: async ({ where }: any) => {
        const unique = where.merchantId_idempotencyKey;
        return state.entries.find((entry) => entry.merchantId === unique.merchantId && entry.idempotencyKey === unique.idempotencyKey) ?? null;
      },
      findFirst: async ({ where }: any = {}) =>
        state.entries.find((entry) =>
          (!where?.id || entry.id === where.id) &&
          (!where?.merchantId || entry.merchantId === where.merchantId) &&
          (where?.balanceAfter?.not !== null || entry.balanceAfter !== null)
        ) ?? null,
      create: async ({ data }: any) => {
        const entry = makeLedgerEntry({
          id: `ledger_${state.entries.length + 1}`,
          createdAt: new Date(now.getTime() + state.entries.length * 1000),
          updatedAt: new Date(now.getTime() + state.entries.length * 1000),
          ...data
        });
        state.entries.push(entry);
        return entry;
      },
      update: async ({ where, data }: any) => {
        const index = state.entries.findIndex((entry) => entry.id === where.id);
        if (index < 0) throw new Error("not found");
        state.entries[index] = { ...state.entries[index]!, ...data, updatedAt: now };
        return state.entries[index];
      }
    },
    auditLog: {
      create: async ({ data }: any) => {
        const row = { id: `audit_${state.auditLogs.length + 1}`, createdAt: now, ...data };
        state.auditLogs.push(row);
        return row;
      }
    }
  };

  return { client: client as any, state };
}

describe("wallet ledger service", () => {
  it("derives current, hold, and available balances from append-only entries", () => {
    const balance = deriveWalletBalanceFromLedger("merchant_1", [
      makeLedgerEntry({ direction: "CREDIT", amount: "1000" }),
      makeLedgerEntry({ direction: "DEBIT", amount: "250" }),
      makeLedgerEntry({ direction: "HOLD", amount: "100" })
    ]);

    assert.equal(balance.currentBalance, 750);
    assert.equal(balance.holdBalance, 100);
    assert.equal(balance.availableBalance, 650);
    assert.equal(balance.sourceOfTruth, "SELLER_WALLET_LEDGER");
  });

  it("uses decimal-safe ledger math for small money increments", async () => {
    const { client } = makeClient();

    await appendLedgerEntry({
      merchantId: "merchant_1",
      direction: "CREDIT",
      amount: "0.10",
      entryType: "TEST_CREDIT",
      description: "Tiny credit one"
    }, client);
    await appendLedgerEntry({
      merchantId: "merchant_1",
      direction: "CREDIT",
      amount: "0.20",
      entryType: "TEST_CREDIT",
      description: "Tiny credit two"
    }, client);

    const balance = await getBalance("merchant_1", client);
    assert.equal(balance.currentBalance, 0.3);
    assert.equal(balance.availableBalance, 0.3);
  });

  it("credits through an idempotency key without double-crediting", async () => {
    const { client, state } = makeClient();

    const first = await appendLedgerEntry({
      merchantId: "merchant_1",
      direction: "CREDIT",
      amount: "500.00",
      entryType: "SELLER_SETTLEMENT",
      referenceType: "SellerSettlement",
      referenceId: "settlement_1",
      idempotencyKey: "seller-settlement:settlement_1",
      description: "Settlement release"
    }, client);
    const second = await appendLedgerEntry({
      merchantId: "merchant_1",
      direction: "CREDIT",
      amount: "500.00",
      entryType: "SELLER_SETTLEMENT",
      referenceType: "SellerSettlement",
      referenceId: "settlement_1",
      idempotencyKey: "seller-settlement:settlement_1",
      description: "Settlement release"
    }, client);

    assert.equal(first.idempotent, false);
    assert.equal(second.idempotent, true);
    assert.equal(state.entries.length, 1);
    assert.equal(state.auditLogs.length, 1);
    assert.equal(state.auditLogs[0]?.action, "WALLET_LEDGER_CREDIT");
    assert.equal(second.balance.currentBalance, 500);
  });

  it("debits through the ledger and stores a new append-only row", async () => {
    const { client, state } = makeClient([
      { merchantId: "merchant_1", direction: "CREDIT", amount: "750.00", id: "seed_credit" }
    ]);

    const result = await appendLedgerEntry({
      merchantId: "merchant_1",
      direction: "DEBIT",
      amount: "125.00",
      entryType: "SHIPMENT_CHARGE",
      referenceType: "Shipment",
      referenceId: "shipment_1",
      idempotencyKey: "shipment-charge:shipment_1",
      description: "Shipment charge debit"
    }, client);

    assert.equal(result.entry.direction, "DEBIT");
    assert.equal(result.entry.entryType, "SHIPMENT_CHARGE");
    assert.equal(result.balance.currentBalance, 625);
    assert.equal(state.entries.length, 2);
    assert.equal(state.entries[1]?.balanceBefore?.toString(), "750");
    assert.equal(state.entries[1]?.balanceAfter?.toString(), "625");
  });

  it("filters and paginates ledger entries safely", async () => {
    const { client } = makeClient([
      { merchantId: "merchant_1", direction: "CREDIT", status: "POSTED", entryType: "SELLER_SETTLEMENT", amount: "100", id: "ledger_one", createdAt: new Date("2026-06-16T12:00:00.000Z") },
      { merchantId: "merchant_1", direction: "DEBIT", status: "POSTED", entryType: "SHIPMENT_CHARGE", amount: "25", id: "ledger_two", createdAt: new Date("2026-06-17T12:00:00.000Z") },
      { merchantId: "merchant_1", direction: "CREDIT", status: "PENDING", entryType: "ADJUSTMENT", amount: "10", id: "ledger_three", createdAt: new Date("2026-06-18T12:00:00.000Z") }
    ]);

    const firstPage = await listLedgerEntries("merchant_1", { limit: 1 }, client);
    assert.equal(firstPage.entries.length, 1);
    assert.equal(firstPage.hasMore, true);
    assert.equal(firstPage.nextCursor, "ledger_two");

    const filtered = await listLedgerEntries("merchant_1", {
      direction: "CREDIT",
      status: "POSTED",
      dateFrom: new Date("2026-06-16T00:00:00.000Z"),
      dateTo: new Date("2026-06-17T00:00:00.000Z")
    }, client);
    assert.equal(filtered.entries.length, 1);
    assert.equal(filtered.entries[0]?.id, "ledger_one");
  });

  it("blocks debits that would make the ledger-derived balance negative", async () => {
    const { client } = makeClient();

    await assert.rejects(
      appendLedgerEntry({
        merchantId: "merchant_1",
        direction: "DEBIT",
        amount: "1.00",
        entryType: "MANUAL_DEBIT",
        description: "Unsafe debit"
      }, client),
      /WALLET_INSUFFICIENT_BALANCE/
    );
  });

  it("keeps seller ledger access merchant-scoped", async () => {
    const { client } = makeClient([
      { merchantId: "merchant_1", direction: "CREDIT", amount: "200", id: "ledger_one" },
      { merchantId: "merchant_2", direction: "CREDIT", amount: "900", id: "ledger_two" }
    ]);

    const merchantOne = await getBalance("merchant_1", client);
    const merchantTwoLedger = await listLedgerEntries("merchant_2", {}, client);

    assert.equal(merchantOne.currentBalance, 200);
    assert.equal(merchantTwoLedger.entries.length, 1);
    assert.equal(merchantTwoLedger.entries[0]?.merchantId, "merchant_2");
  });

  it("reports mismatch when legacy user.walletBalance differs from ledger-derived balance", async () => {
    const { client } = makeClient([
      { merchantId: "merchant_1", direction: "CREDIT", amount: "300", id: "ledger_one", balanceAfter: "300" }
    ]);

    const result = await reconcileBalance("merchant_1", client, {
      legacyCachedBalance: 125,
      legacyCachedBalanceSource: "user.walletBalance"
    });

    assert.equal(result.ledgerDerivedBalance, 300);
    assert.equal(result.latestCachedBalance, 300);
    assert.equal(result.matchesLatestCachedBalance, true);
    assert.equal(result.legacyCachedBalance, 125);
    assert.equal(result.legacyCachedBalanceSource, "user.walletBalance");
    assert.equal(result.matchesLegacyCachedBalance, false);
  });

  it("redacts wallet ledger references in public serializers", () => {
    const serialized = serializeWalletLedgerEntry(makeLedgerEntry({
      referenceType: "SellerSettlement",
      referenceId: "settlement_sensitive_reference_12345",
      awb: "AWB1234567890",
      orderId: "ORDER1234567890"
    }) as any);

    assert.equal(serialized.reference.redacted, true);
    assert.equal(serialized.reference.id?.includes("sensitive_reference"), false);
    assert.equal(serialized.reference.awb, "AWB1...7890");
    assert.equal(serialized.reference.orderId, "ORDE...7890");
  });

  it("lists admin wallets with safe reconciliation status filters", async () => {
    const { client } = makeClient([
      { merchantId: "merchant_1", direction: "CREDIT", amount: "300", id: "ledger_one", balanceAfter: "125" },
      { merchantId: "merchant_2", direction: "CREDIT", amount: "900", id: "ledger_two", balanceAfter: "900" }
    ]);

    const mismatched = await listMerchantWallets({ reconcileStatus: "MISMATCHED" }, client);
    assert.equal(mismatched.wallets.length, 1);
    assert.equal(mismatched.wallets[0]?.merchant.id, "merchant_1");
    assert.equal(mismatched.wallets[0]?.reconciliation.status, "MISMATCHED");

    const matched = await listMerchantWallets({ status: "ACTIVE", reconcileStatus: "MATCHED" }, client);
    assert.equal(matched.wallets.length, 1);
    assert.equal(matched.wallets[0]?.merchant.id, "merchant_2");
  });

  it("keeps wallet routes scoped to authenticated merchant/admin guards", () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");
    const walletRoutes = readFileSync("src/modules/wallet/wallet.routes.ts", "utf8");

    assert.match(routes, /apiRouter\.use\("\/wallet", requireJwtAuth, walletRouter\);/);
    assert.match(routes, /apiRouter\.use\("\/admin\/wallets", requireAdminJwt, adminWalletRouter\);/);
    assert.match(walletRoutes, /walletRouter\.get\("\/"/);
    assert.match(walletRoutes, /walletRouter\.get\("\/ledger"/);
    assert.match(walletRoutes, /walletRouter\.get\("\/reconcile"/);
    assert.match(walletRoutes, /req\.auth!\.merchantId/);
    assert.match(walletRoutes, /adminWalletRouter\.get\("\/:merchantId"/);
    assert.doesNotMatch(walletRoutes, /adminWalletRouter\.post/);
  });
});
