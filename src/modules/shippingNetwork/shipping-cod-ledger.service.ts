import type { Prisma } from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { serializeCodLedgerEntry } from "./shipping-operations-serializers.js";
import { toPrismaJson } from "./shipping-public-serializers.js";
import { getSellerShipment } from "./shipping-shipments.service.js";

type Db = Prisma.TransactionClient | typeof prisma;

export type ListCodLedgerQuery = {
  status?: string | undefined;
  entryType?: string | undefined;
  page?: number | undefined;
  perPage?: number | undefined;
};

export type CodLedgerEntryInput = {
  amountPaise?: number | undefined;
  reference?: string | undefined;
  notes?: string | undefined;
  occurredAt?: Date | undefined;
  metadata?: Record<string, unknown> | undefined;
};

function pagination(query: ListCodLedgerQuery = {}) {
  const page = Math.max(1, query.page ?? 1);
  const perPage = Math.min(50, Math.max(1, query.perPage ?? 20));
  return { page, perPage };
}

function assertNonNegativeAmount(amountPaise: number) {
  if (!Number.isInteger(amountPaise) || amountPaise < 0) {
    throw new HttpError(400, "COD_LEDGER_AMOUNT_INVALID");
  }
}

function inputAmountOrShipmentCod(input: CodLedgerEntryInput, shipment: { codAmountPaise?: number | null }) {
  const amountPaise = input.amountPaise ?? shipment.codAmountPaise ?? 0;
  assertNonNegativeAmount(amountPaise);
  return amountPaise;
}

async function shipmentForEntry(client: Db, merchantId: string, shipmentId: string | null | undefined) {
  if (!shipmentId) return null;
  return client.shipment.findFirst({
    where: { id: shipmentId, sellerId: merchantId }
  });
}

async function createLedgerEntry(client: Db, input: {
  merchantId: string;
  shipmentId: string;
  orderId?: string | null;
  entryType: string;
  status: string;
  amountPaise: number;
  reference?: string | null | undefined;
  notes?: string | null | undefined;
  metadata?: Record<string, unknown> | null | undefined;
  expectedCollectionAt?: Date | null | undefined;
  collectedAt?: Date | null | undefined;
  remittanceDueAt?: Date | null | undefined;
  remittedAt?: Date | null | undefined;
}) {
  return client.codLedgerEntry.create({
    data: {
      merchantId: input.merchantId,
      shipmentId: input.shipmentId,
      orderId: input.orderId ?? null,
      entryType: input.entryType,
      status: input.status,
      amountPaise: input.amountPaise,
      currency: "INR",
      reference: input.reference ?? null,
      notes: input.notes ?? null,
      metadataJson: toPrismaJson(input.metadata ?? null),
      expectedCollectionAt: input.expectedCollectionAt ?? null,
      collectedAt: input.collectedAt ?? null,
      remittanceDueAt: input.remittanceDueAt ?? null,
      remittedAt: input.remittedAt ?? null
    }
  });
}

export async function createExpectedCodEntryForCodShipment(
  merchantId: string,
  shipmentId: string,
  input: CodLedgerEntryInput = {},
  client: Db = prisma
) {
  const shipment = await getSellerShipment(merchantId, shipmentId, client);
  if (String(shipment.paymentMode) !== "cod") {
    throw new HttpError(409, "COD_LEDGER_PREPAID_SHIPMENT");
  }

  const amountPaise = inputAmountOrShipmentCod(input, shipment);
  const existing = await client.codLedgerEntry.findFirst({
    where: {
      merchantId,
      shipmentId: shipment.id,
      entryType: "expected_collection"
    }
  });
  if (existing) {
    return serializeCodLedgerEntry(existing, shipment);
  }

  const row = await createLedgerEntry(client, {
    merchantId,
    shipmentId: shipment.id,
    orderId: shipment.orderId ?? null,
    entryType: "expected_collection",
    status: "pending",
    amountPaise,
    reference: input.reference,
    notes: input.notes,
    metadata: input.metadata ?? null,
    expectedCollectionAt: input.occurredAt ?? null
  });

  return serializeCodLedgerEntry(row, shipment);
}

export async function recordCodCollected(
  merchantId: string,
  shipmentId: string,
  input: CodLedgerEntryInput,
  client: Db = prisma
) {
  const shipment = await getSellerShipment(merchantId, shipmentId, client);
  const amountPaise = inputAmountOrShipmentCod(input, shipment);
  const row = await createLedgerEntry(client, {
    merchantId,
    shipmentId: shipment.id,
    orderId: shipment.orderId ?? null,
    entryType: "collected",
    status: "collected",
    amountPaise,
    reference: input.reference,
    notes: input.notes,
    metadata: input.metadata ?? null,
    collectedAt: input.occurredAt ?? new Date()
  });

  return serializeCodLedgerEntry(row, shipment);
}

export async function recordCodRemittanceDue(
  merchantId: string,
  shipmentId: string,
  input: CodLedgerEntryInput,
  client: Db = prisma
) {
  const shipment = await getSellerShipment(merchantId, shipmentId, client);
  const amountPaise = inputAmountOrShipmentCod(input, shipment);
  const row = await createLedgerEntry(client, {
    merchantId,
    shipmentId: shipment.id,
    orderId: shipment.orderId ?? null,
    entryType: "remittance_due",
    status: "due",
    amountPaise,
    reference: input.reference,
    notes: input.notes,
    metadata: input.metadata ?? null,
    remittanceDueAt: input.occurredAt ?? new Date()
  });

  return serializeCodLedgerEntry(row, shipment);
}

export async function recordCodRemitted(
  merchantId: string,
  shipmentId: string,
  input: CodLedgerEntryInput,
  client: Db = prisma
) {
  const shipment = await getSellerShipment(merchantId, shipmentId, client);
  const amountPaise = inputAmountOrShipmentCod(input, shipment);
  const row = await createLedgerEntry(client, {
    merchantId,
    shipmentId: shipment.id,
    orderId: shipment.orderId ?? null,
    entryType: "remitted",
    status: "remitted",
    amountPaise,
    reference: input.reference,
    notes: input.notes,
    metadata: input.metadata ?? null,
    remittedAt: input.occurredAt ?? new Date()
  });

  return serializeCodLedgerEntry(row, shipment);
}

export async function listCodLedger(
  merchantId: string,
  query: ListCodLedgerQuery = {},
  client: Db = prisma
) {
  const { page, perPage } = pagination(query);
  const where: Prisma.CodLedgerEntryWhereInput = {
    merchantId,
    ...(query.status ? { status: query.status } : {}),
    ...(query.entryType ? { entryType: query.entryType } : {})
  };
  const [entries, total] = await Promise.all([
    client.codLedgerEntry.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage
    }),
    client.codLedgerEntry.count({ where })
  ]);
  const rows = [];
  for (const entry of entries) {
    rows.push(serializeCodLedgerEntry(entry, await shipmentForEntry(client, merchantId, entry.shipmentId)));
  }

  return {
    entries: rows,
    pagination: {
      page,
      per_page: perPage,
      total,
      has_more: page * perPage < total
    }
  };
}

export async function getCodLedgerSummary(
  merchantId: string,
  query: Pick<ListCodLedgerQuery, "status" | "entryType"> = {},
  client: Db = prisma
) {
  const entries = await client.codLedgerEntry.findMany({
    where: {
      merchantId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.entryType ? { entryType: query.entryType } : {})
    }
  });
  const sum = (predicate: (entry: typeof entries[number]) => boolean) =>
    entries.filter(predicate).reduce((total, entry) => total + entry.amountPaise, 0);
  const adjustmentPaise = sum((entry) => entry.entryType === "adjustment") - sum((entry) => entry.entryType === "reversal");
  const expectedCollectionPaise = sum((entry) => entry.entryType === "expected_collection");
  const remittedPaise = sum((entry) => entry.entryType === "remitted");

  return {
    expected_collection_paise: expectedCollectionPaise,
    collected_paise: sum((entry) => entry.entryType === "collected"),
    remittance_due_paise: sum((entry) => entry.entryType === "remittance_due"),
    remitted_paise: remittedPaise,
    adjustment_paise: adjustmentPaise,
    pending_paise: Math.max(0, expectedCollectionPaise + adjustmentPaise - remittedPaise)
  };
}
