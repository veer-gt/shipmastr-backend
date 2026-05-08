import {
  FirstShipmentRequestStatus,
  MerchantOnboardingStepStatus,
  PaymentMode,
  type Prisma
} from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../audit/audit.service.js";
import { updateMerchantOnboarding } from "../onboarding/onboarding.service.js";

type Db = Prisma.TransactionClient | typeof prisma;

export type FirstShipmentRequestInput = {
  merchantId: string;
  requesterUserId: string;
  pickupName: string;
  pickupPhone: string;
  pickupAddress: string;
  pickupPincode: string;
  deliveryCity: string;
  deliveryPincode: string;
  packageWeight: number;
  paymentMode: PaymentMode;
  codAmount?: number;
  notes?: string | null;
};

export type FirstShipmentRequestPatch = {
  status?: FirstShipmentRequestStatus;
  notes?: string | null;
};

function clean(value: string) {
  return value.trim();
}

function cleanOptional(value?: string | null) {
  const next = value?.trim();
  return next ? next : null;
}

function onboardingStatusForRequest(status: FirstShipmentRequestStatus) {
  if (status === FirstShipmentRequestStatus.COMPLETED) return MerchantOnboardingStepStatus.COMPLETED;
  if (status === FirstShipmentRequestStatus.CANCELLED) return MerchantOnboardingStepStatus.BLOCKED;
  return MerchantOnboardingStepStatus.IN_PROGRESS;
}

const requestInclude = {
  merchant: {
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      onboardingStatus: true,
      firstShipmentStatus: true
    }
  },
  requester: {
    select: {
      id: true,
      name: true,
      email: true
    }
  }
} satisfies Prisma.FirstShipmentRequestInclude;

async function createInClient(input: FirstShipmentRequestInput, client: Db) {
  const request = await client.firstShipmentRequest.create({
    data: {
      merchantId: input.merchantId,
      requesterUserId: input.requesterUserId,
      pickupName: clean(input.pickupName),
      pickupPhone: clean(input.pickupPhone),
      pickupAddress: clean(input.pickupAddress),
      pickupPincode: clean(input.pickupPincode),
      deliveryCity: clean(input.deliveryCity),
      deliveryPincode: clean(input.deliveryPincode),
      packageWeight: input.packageWeight,
      paymentMode: input.paymentMode,
      codAmount: input.paymentMode === PaymentMode.COD ? input.codAmount ?? 0 : 0,
      notes: cleanOptional(input.notes),
      status: FirstShipmentRequestStatus.NEW
    },
    include: requestInclude
  });

  await updateMerchantOnboarding({
    merchantId: input.merchantId,
    actorId: input.requesterUserId,
    patch: {
      firstShipmentStatus: MerchantOnboardingStepStatus.IN_PROGRESS
    }
  }, client);

  await audit({
    merchantId: input.merchantId,
    actorId: input.requesterUserId,
    action: "FIRST_SHIPMENT_REQUEST_CREATED",
    entityType: "first_shipment_request",
    entityId: request.id,
    metadata: {
      paymentMode: request.paymentMode,
      deliveryPincode: request.deliveryPincode,
      packageWeight: request.packageWeight
    }
  }, client).catch(() => undefined);

  return request;
}

export async function createFirstShipmentRequest(input: FirstShipmentRequestInput, client: Db = prisma) {
  if ("$transaction" in client && typeof (client as typeof prisma).$transaction === "function") {
    return (client as typeof prisma).$transaction((tx) => createInClient(input, tx));
  }

  return createInClient(input, client);
}

export async function listSellerFirstShipmentRequests(merchantId: string, client: Db = prisma) {
  const requests = await client.firstShipmentRequest.findMany({
    where: { merchantId },
    include: requestInclude,
    orderBy: { createdAt: "desc" }
  });

  return {
    requests,
    latestRequest: requests[0] ?? null
  };
}

export async function listAdminFirstShipmentRequests(client: Db = prisma) {
  const requests = await client.firstShipmentRequest.findMany({
    include: requestInclude,
    orderBy: { createdAt: "desc" }
  });

  return { requests };
}

async function updateInClient(input: {
  id: string;
  patch: FirstShipmentRequestPatch;
  actorId?: string;
}, client: Db) {
  const existing = await client.firstShipmentRequest.findUnique({
    where: { id: input.id },
    include: requestInclude
  });

  if (!existing) return null;

  const data: Prisma.FirstShipmentRequestUpdateInput = {};
  if (input.patch.status !== undefined) data.status = input.patch.status;
  if (input.patch.notes !== undefined) data.notes = cleanOptional(input.patch.notes);

  const request = await client.firstShipmentRequest.update({
    where: { id: input.id },
    data,
    include: requestInclude
  });

  if (input.patch.status !== undefined && input.patch.status !== existing.status) {
    const onboardingInput: Parameters<typeof updateMerchantOnboarding>[0] = {
      merchantId: request.merchantId,
      patch: {
        firstShipmentStatus: onboardingStatusForRequest(request.status)
      }
    };
    if (input.actorId) onboardingInput.actorId = input.actorId;

    await updateMerchantOnboarding(onboardingInput, client);
  }

  const auditInput: Parameters<typeof audit>[0] = {
    merchantId: request.merchantId,
    action: "FIRST_SHIPMENT_REQUEST_UPDATED",
    entityType: "first_shipment_request",
    entityId: request.id,
    metadata: {
      fromStatus: existing.status,
      toStatus: request.status,
      notesUpdated: input.patch.notes !== undefined
    }
  };
  if (input.actorId) auditInput.actorId = input.actorId;

  await audit(auditInput, client).catch(() => undefined);

  return request;
}

export async function updateFirstShipmentRequest(input: {
  id: string;
  patch: FirstShipmentRequestPatch;
  actorId?: string;
}, client: Db = prisma) {
  if ("$transaction" in client && typeof (client as typeof prisma).$transaction === "function") {
    return (client as typeof prisma).$transaction((tx) => updateInClient(input, tx));
  }

  return updateInClient(input, client);
}
