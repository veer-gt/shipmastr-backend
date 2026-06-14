import type { Prisma } from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import {
  serializeNdrActionAttempt,
  serializeNdrCase
} from "./shipping-operations-serializers.js";
import { toPrismaJson } from "./shipping-public-serializers.js";
import { getSellerShipment } from "./shipping-shipments.service.js";

type Db = Prisma.TransactionClient | typeof prisma;

export type ListOperationalCasesQuery = {
  status?: string | undefined;
  page?: number | undefined;
  perPage?: number | undefined;
};

export type CreateNdrCaseInput = {
  reasonCode?: string | undefined;
  reasonLabel?: string | undefined;
  buyerIssueType?: string | undefined;
  latestAttemptAt?: Date | undefined;
  nextActionBy?: Date | undefined;
  sellerAction?: string | undefined;
};

export type RecordNdrActionInput = {
  action: string;
  payload?: Record<string, unknown> | undefined;
};

export type ResolveNdrCaseInput = {
  status?: "resolved" | "failed" | "cancelled" | undefined;
  resolutionNote?: string | undefined;
};

function pagination(query: ListOperationalCasesQuery = {}) {
  const page = Math.max(1, query.page ?? 1);
  const perPage = Math.min(50, Math.max(1, query.perPage ?? 20));
  return { page, perPage };
}

async function shipmentForCase(client: Db, merchantId: string, shipmentId: string) {
  return client.shipment.findFirst({
    where: { id: shipmentId, sellerId: merchantId }
  });
}

export async function createOrUpdateNdrCaseFromShipment(
  merchantId: string,
  shipmentId: string,
  input: CreateNdrCaseInput,
  client: Db = prisma
) {
  const shipment = await getSellerShipment(merchantId, shipmentId, client);
  const existing = await client.ndrCase.findFirst({
    where: {
      merchantId,
      shipmentId: shipment.id,
      status: { in: ["open", "action_required", "action_submitted", "failed"] }
    },
    orderBy: { createdAt: "desc" }
  });
  const data = {
    merchantId,
    shipmentId: shipment.id,
    orderId: shipment.orderId ?? null,
    status: input.sellerAction ? "action_required" : "open",
    reasonCode: input.reasonCode ?? null,
    reasonLabel: input.reasonLabel ?? null,
    buyerIssueType: input.buyerIssueType ?? null,
    latestAttemptAt: input.latestAttemptAt ?? null,
    nextActionBy: input.nextActionBy ?? null,
    sellerAction: input.sellerAction ?? null
  };
  const row = existing
    ? await client.ndrCase.update({ where: { id: existing.id }, data })
    : await client.ndrCase.create({ data });

  return serializeNdrCase(row, shipment);
}

export async function listNdrCases(
  merchantId: string,
  query: ListOperationalCasesQuery = {},
  client: Db = prisma
) {
  const { page, perPage } = pagination(query);
  const where: Prisma.NdrCaseWhereInput = {
    merchantId,
    ...(query.status ? { status: query.status } : {})
  };
  const [cases, total] = await Promise.all([
    client.ndrCase.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage
    }),
    client.ndrCase.count({ where })
  ]);
  const rows = [];
  for (const caseRow of cases) {
    rows.push(serializeNdrCase(caseRow, await shipmentForCase(client, merchantId, caseRow.shipmentId)));
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

export async function getNdrCase(merchantId: string, caseId: string, client: Db = prisma) {
  const caseRow = await client.ndrCase.findFirst({
    where: { id: caseId, merchantId }
  });
  if (!caseRow) throw new HttpError(404, "NDR_CASE_NOT_FOUND");
  const shipment = await shipmentForCase(client, merchantId, caseRow.shipmentId);
  const actions = await client.ndrActionAttempt.findMany({
    where: { merchantId, ndrCaseId: caseRow.id },
    orderBy: { createdAt: "desc" }
  });

  return {
    ...serializeNdrCase(caseRow, shipment),
    actions: actions.map(serializeNdrActionAttempt)
  };
}

export async function recordNdrAction(
  merchantId: string,
  caseId: string,
  input: RecordNdrActionInput,
  client: Db = prisma
) {
  const caseRow = await client.ndrCase.findFirst({
    where: { id: caseId, merchantId }
  });
  if (!caseRow) throw new HttpError(404, "NDR_CASE_NOT_FOUND");

  const action = await client.ndrActionAttempt.create({
    data: {
      merchantId,
      ndrCaseId: caseRow.id,
      shipmentId: caseRow.shipmentId,
      action: input.action,
      status: "recorded",
      payloadJson: toPrismaJson(input.payload ?? null)
    }
  });
  const updated = await client.ndrCase.update({
    where: { id: caseRow.id },
    data: {
      status: "action_submitted",
      sellerAction: input.action,
      actionPayloadJson: toPrismaJson(input.payload ?? null)
    }
  });
  const shipment = await shipmentForCase(client, merchantId, updated.shipmentId);

  return {
    case: serializeNdrCase(updated, shipment),
    action: serializeNdrActionAttempt(action)
  };
}

export async function resolveNdrCase(
  merchantId: string,
  caseId: string,
  input: ResolveNdrCaseInput,
  client: Db = prisma
) {
  const caseRow = await client.ndrCase.findFirst({
    where: { id: caseId, merchantId }
  });
  if (!caseRow) throw new HttpError(404, "NDR_CASE_NOT_FOUND");

  const updated = await client.ndrCase.update({
    where: { id: caseRow.id },
    data: {
      status: input.status ?? "resolved",
      internalNotes: input.resolutionNote ?? caseRow.internalNotes ?? null
    }
  });
  const shipment = await shipmentForCase(client, merchantId, updated.shipmentId);

  return serializeNdrCase(updated, shipment);
}
