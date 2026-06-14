import type { Prisma } from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { serializeWeightDiscrepancyCase } from "./shipping-operations-serializers.js";
import { decimalToNumber, toPrismaJson } from "./shipping-public-serializers.js";
import { getSellerShipment } from "./shipping-shipments.service.js";
import type { ListOperationalCasesQuery } from "./shipping-ndr.service.js";

type Db = Prisma.TransactionClient | typeof prisma;

export type DetectWeightDiscrepancyInput = {
  billedWeightGrams: number;
  expectedChargePaise?: number | undefined;
  billedChargePaise?: number | undefined;
  reasonCode?: string | undefined;
  reasonLabel?: string | undefined;
};

export type WeightEvidenceInput = {
  productPhotos?: string[] | undefined;
  packagePhotos?: string[] | undefined;
  invoiceUrl?: string | undefined;
  sellerNote?: string | undefined;
  measurementProof?: string | undefined;
};

export type WeightDisputeStatusInput = {
  providerRef?: string | undefined;
  note?: string | undefined;
};

function pagination(query: ListOperationalCasesQuery = {}) {
  const page = Math.max(1, query.page ?? 1);
  const perPage = Math.min(50, Math.max(1, query.perPage ?? 20));
  return { page, perPage };
}

function kgToGrams(value: unknown) {
  const number = decimalToNumber(value);
  return number && number > 0 ? Math.round(number * 1000) : null;
}

function nonNegativeOrNull(value: number | null | undefined) {
  return typeof value === "number" && value >= 0 ? value : null;
}

function billableWeightGrams(shipment: {
  deadWeightKg?: unknown;
  volumetricWeightKg?: unknown;
  chargeableWeightKg?: unknown;
}) {
  const physical = kgToGrams(shipment.deadWeightKg);
  const volumetric = kgToGrams(shipment.volumetricWeightKg);
  if (physical === null && volumetric === null) {
    return kgToGrams(shipment.chargeableWeightKg) ?? 0;
  }
  return Math.max(physical ?? 0, volumetric ?? 0);
}

function discrepancyReason(input: {
  declaredWeightGrams: number | null;
  volumetricWeightGrams: number | null;
  billedChargePaise: number | null;
  expectedChargePaise: number | null;
}) {
  if (!input.declaredWeightGrams) return {
    code: "MISSING_DECLARED_WEIGHT",
    label: "Missing declared package weight"
  };
  if (!input.volumetricWeightGrams) return {
    code: "MISSING_DIMENSIONS",
    label: "Missing package dimensions"
  };
  if ((input.billedChargePaise ?? 0) > (input.expectedChargePaise ?? Number.POSITIVE_INFINITY)) {
    return {
      code: "BILLING_CHARGE_HIGHER",
      label: "Courier billed charge is higher"
    };
  }
  if (input.volumetricWeightGrams > input.declaredWeightGrams) {
    return {
      code: "VOLUMETRIC_WEIGHT_HIGHER",
      label: "Volumetric weight is higher"
    };
  }
  return {
    code: "BILLED_WEIGHT_HIGHER",
    label: "Billed weight is higher than Shipmastr weight"
  };
}

async function shipmentForCase(client: Db, merchantId: string, shipmentId: string) {
  return client.shipment.findFirst({
    where: { id: shipmentId, sellerId: merchantId }
  });
}

export async function detectWeightDiscrepancy(
  merchantId: string,
  shipmentId: string,
  input: DetectWeightDiscrepancyInput,
  client: Db = prisma
) {
  if (!Number.isInteger(input.billedWeightGrams) || input.billedWeightGrams < 0) {
    throw new HttpError(400, "BILLED_WEIGHT_INVALID");
  }
  const shipment = await getSellerShipment(merchantId, shipmentId, client);
  const declaredWeightGrams = kgToGrams(shipment.deadWeightKg);
  const volumetricWeightGrams = kgToGrams(shipment.volumetricWeightKg);
  const expectedBillableWeightGrams = billableWeightGrams(shipment);
  const differenceGrams = input.billedWeightGrams - expectedBillableWeightGrams;

  if (differenceGrams <= 0) {
    return {
      created: false,
      case: null,
      difference_grams: 0,
      expected_billable_weight_grams: expectedBillableWeightGrams
    };
  }

  const expectedChargePaise = nonNegativeOrNull(input.expectedChargePaise);
  const billedChargePaise = nonNegativeOrNull(input.billedChargePaise);
  const differencePaise = billedChargePaise !== null && expectedChargePaise !== null
    ? Math.max(0, billedChargePaise - expectedChargePaise)
    : null;
  const reason = discrepancyReason({
    declaredWeightGrams,
    volumetricWeightGrams,
    expectedChargePaise,
    billedChargePaise
  });
  const existing = await client.weightDiscrepancyCase.findFirst({
    where: {
      merchantId,
      shipmentId: shipment.id,
      status: { in: ["detected", "evidence_needed", "dispute_ready", "submitted"] }
    },
    orderBy: { createdAt: "desc" }
  });
  const data = {
    merchantId,
    shipmentId: shipment.id,
    orderId: shipment.orderId ?? null,
    status: "detected",
    declaredWeightGrams,
    volumetricWeightGrams,
    billedWeightGrams: input.billedWeightGrams,
    differenceGrams,
    expectedChargePaise,
    billedChargePaise,
    differencePaise,
    reasonCode: input.reasonCode ?? reason.code,
    reasonLabel: input.reasonLabel ?? reason.label
  };
  const row = existing
    ? await client.weightDiscrepancyCase.update({ where: { id: existing.id }, data })
    : await client.weightDiscrepancyCase.create({ data });

  return {
    created: !existing,
    case: serializeWeightDiscrepancyCase(row, shipment),
    difference_grams: differenceGrams,
    expected_billable_weight_grams: expectedBillableWeightGrams
  };
}

export async function listWeightDiscrepancyCases(
  merchantId: string,
  query: ListOperationalCasesQuery = {},
  client: Db = prisma
) {
  const { page, perPage } = pagination(query);
  const where: Prisma.WeightDiscrepancyCaseWhereInput = {
    merchantId,
    ...(query.status ? { status: query.status } : {})
  };
  const [cases, total] = await Promise.all([
    client.weightDiscrepancyCase.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage
    }),
    client.weightDiscrepancyCase.count({ where })
  ]);
  const rows = [];
  for (const caseRow of cases) {
    rows.push(serializeWeightDiscrepancyCase(caseRow, await shipmentForCase(client, merchantId, caseRow.shipmentId)));
  }

  return {
    cases: rows,
    pagination: {
      page,
      per_page: perPage,
      total,
      has_more: page * perPage < total
    }
  };
}

export async function getWeightDiscrepancyCase(merchantId: string, caseId: string, client: Db = prisma) {
  const caseRow = await client.weightDiscrepancyCase.findFirst({
    where: { id: caseId, merchantId }
  });
  if (!caseRow) throw new HttpError(404, "WEIGHT_DISCREPANCY_CASE_NOT_FOUND");
  return serializeWeightDiscrepancyCase(caseRow, await shipmentForCase(client, merchantId, caseRow.shipmentId));
}

export async function updateWeightDisputeEvidence(
  merchantId: string,
  caseId: string,
  evidence: WeightEvidenceInput,
  client: Db = prisma
) {
  const caseRow = await client.weightDiscrepancyCase.findFirst({
    where: { id: caseId, merchantId }
  });
  if (!caseRow) throw new HttpError(404, "WEIGHT_DISCREPANCY_CASE_NOT_FOUND");
  const updated = await client.weightDiscrepancyCase.update({
    where: { id: caseRow.id },
    data: {
      status: "dispute_ready",
      evidenceJson: toPrismaJson(evidence)
    }
  });

  return serializeWeightDiscrepancyCase(updated, await shipmentForCase(client, merchantId, updated.shipmentId));
}

export async function markWeightDisputeSubmitted(
  merchantId: string,
  caseId: string,
  input: WeightDisputeStatusInput,
  client: Db = prisma
) {
  const caseRow = await client.weightDiscrepancyCase.findFirst({
    where: { id: caseId, merchantId }
  });
  if (!caseRow) throw new HttpError(404, "WEIGHT_DISCREPANCY_CASE_NOT_FOUND");
  const updated = await client.weightDiscrepancyCase.update({
    where: { id: caseRow.id },
    data: {
      status: "submitted",
      providerRef: input.providerRef ?? null,
      internalNotes: input.note ?? caseRow.internalNotes ?? null,
      submittedAt: new Date()
    }
  });

  return serializeWeightDiscrepancyCase(updated, await shipmentForCase(client, merchantId, updated.shipmentId));
}

export async function closeWeightDispute(
  merchantId: string,
  caseId: string,
  input: WeightDisputeStatusInput,
  client: Db = prisma
) {
  const caseRow = await client.weightDiscrepancyCase.findFirst({
    where: { id: caseId, merchantId }
  });
  if (!caseRow) throw new HttpError(404, "WEIGHT_DISCREPANCY_CASE_NOT_FOUND");
  const updated = await client.weightDiscrepancyCase.update({
    where: { id: caseRow.id },
    data: {
      status: "closed",
      internalNotes: input.note ?? caseRow.internalNotes ?? null,
      closedAt: new Date()
    }
  });

  return serializeWeightDiscrepancyCase(updated, await shipmentForCase(client, merchantId, updated.shipmentId));
}
