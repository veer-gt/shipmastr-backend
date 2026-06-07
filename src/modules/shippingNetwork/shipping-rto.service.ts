import type { Prisma } from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { serializeRtoCase } from "./shipping-operations-serializers.js";
import { toPrismaJson } from "./shipping-public-serializers.js";
import { getSellerShipment } from "./shipping-shipments.service.js";
import type { ListOperationalCasesQuery } from "./shipping-ndr.service.js";

type Db = Prisma.TransactionClient | typeof prisma;

export type CreateRtoCaseInput = {
  status?: string | undefined;
  reasonCode?: string | undefined;
  reasonLabel?: string | undefined;
  initiatedAt?: Date | undefined;
  forwardFreightPaise?: number | undefined;
  rtoFreightPaise?: number | undefined;
  codLostPaise?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type UpdateRtoStatusInput = {
  status: "initiated" | "in_transit" | "received" | "lost" | "damaged" | "closed";
  receivedAt?: Date | undefined;
  closedAt?: Date | undefined;
  reasonCode?: string | undefined;
  reasonLabel?: string | undefined;
};

function pagination(query: ListOperationalCasesQuery = {}) {
  const page = Math.max(1, query.page ?? 1);
  const perPage = Math.min(50, Math.max(1, query.perPage ?? 20));
  return { page, perPage };
}

function nonNegativeOrNull(value: number | null | undefined) {
  return typeof value === "number" && value >= 0 ? value : null;
}

export function calculateEstimatedRtoLoss(input: {
  forwardFreightPaise?: number | null | undefined;
  rtoFreightPaise?: number | null | undefined;
  codLostPaise?: number | null | undefined;
}) {
  const values = [
    nonNegativeOrNull(input.forwardFreightPaise),
    nonNegativeOrNull(input.rtoFreightPaise),
    nonNegativeOrNull(input.codLostPaise)
  ];
  if (values.every((value) => value === null)) return null;
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

async function shipmentForCase(client: Db, merchantId: string, shipmentId: string) {
  return client.shipment.findFirst({
    where: { id: shipmentId, sellerId: merchantId }
  });
}

export async function createOrUpdateRtoCaseFromShipment(
  merchantId: string,
  shipmentId: string,
  input: CreateRtoCaseInput,
  client: Db = prisma
) {
  const shipment = await getSellerShipment(merchantId, shipmentId, client);
  const existing = await client.rtoCase.findFirst({
    where: {
      merchantId,
      shipmentId: shipment.id,
      status: { in: ["initiated", "in_transit", "received", "lost", "damaged"] }
    },
    orderBy: { createdAt: "desc" }
  });
  const loss = calculateEstimatedRtoLoss(input);
  const data = {
    merchantId,
    shipmentId: shipment.id,
    orderId: shipment.orderId ?? null,
    status: input.status ?? "initiated",
    rtoReasonCode: input.reasonCode ?? null,
    rtoReasonLabel: input.reasonLabel ?? null,
    initiatedAt: input.initiatedAt ?? new Date(),
    forwardFreightPaise: nonNegativeOrNull(input.forwardFreightPaise),
    rtoFreightPaise: nonNegativeOrNull(input.rtoFreightPaise),
    codLostPaise: nonNegativeOrNull(input.codLostPaise),
    estimatedLossPaise: loss,
    metadataJson: toPrismaJson(input.metadata ?? null)
  };
  const row = existing
    ? await client.rtoCase.update({ where: { id: existing.id }, data })
    : await client.rtoCase.create({ data });

  return serializeRtoCase(row, shipment);
}

export async function listRtoCases(
  merchantId: string,
  query: ListOperationalCasesQuery = {},
  client: Db = prisma
) {
  const { page, perPage } = pagination(query);
  const where: Prisma.RtoCaseWhereInput = {
    merchantId,
    ...(query.status ? { status: query.status } : {})
  };
  const [cases, total] = await Promise.all([
    client.rtoCase.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage
    }),
    client.rtoCase.count({ where })
  ]);
  const rows = [];
  for (const caseRow of cases) {
    rows.push(serializeRtoCase(caseRow, await shipmentForCase(client, merchantId, caseRow.shipmentId)));
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

export async function getRtoCase(merchantId: string, caseId: string, client: Db = prisma) {
  const caseRow = await client.rtoCase.findFirst({
    where: { id: caseId, merchantId }
  });
  if (!caseRow) throw new HttpError(404, "RTO_CASE_NOT_FOUND");
  return serializeRtoCase(caseRow, await shipmentForCase(client, merchantId, caseRow.shipmentId));
}

export async function updateRtoStatus(
  merchantId: string,
  caseId: string,
  input: UpdateRtoStatusInput,
  client: Db = prisma
) {
  const caseRow = await client.rtoCase.findFirst({
    where: { id: caseId, merchantId }
  });
  if (!caseRow) throw new HttpError(404, "RTO_CASE_NOT_FOUND");
  const now = new Date();
  const updated = await client.rtoCase.update({
    where: { id: caseRow.id },
    data: {
      status: input.status,
      rtoReasonCode: input.reasonCode ?? caseRow.rtoReasonCode ?? null,
      rtoReasonLabel: input.reasonLabel ?? caseRow.rtoReasonLabel ?? null,
      receivedAt: input.status === "received" ? input.receivedAt ?? now : caseRow.receivedAt ?? null,
      closedAt: input.status === "closed" ? input.closedAt ?? now : caseRow.closedAt ?? null
    }
  });

  return serializeRtoCase(updated, await shipmentForCase(client, merchantId, updated.shipmentId));
}
