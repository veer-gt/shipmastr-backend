import {
  FirstShipmentRequestStatus,
  MerchantOnboardingStepStatus,
  PaymentMode,
  type Prisma
} from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
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
  buyerName?: string | null;
  buyerPhone?: string | null;
  buyerAddress?: string | null;
  packageDescription?: string | null;
  packageWeight: number;
  paymentMode: PaymentMode;
  codAmount?: number;
  courierPreference?: string | null;
  notes?: string | null;
};

export type FirstShipmentRequestPatch = {
  status?: FirstShipmentRequestStatus;
  courierPreference?: string | null;
  assignedCourierId?: string | null;
  freightEstimate?: number | null;
  codAmount?: number | null;
  awb?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  opsNotes?: string | null;
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
  if (status === FirstShipmentRequestStatus.DELIVERED) return MerchantOnboardingStepStatus.COMPLETED;
  if (status === FirstShipmentRequestStatus.CANCELLED || status === FirstShipmentRequestStatus.RTO) {
    return MerchantOnboardingStepStatus.BLOCKED;
  }

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
  },
  manualShipment: {
    include: {
      courier: {
        select: {
          id: true,
          name: true,
          code: true,
          apiMode: true,
          bookingMode: true
        }
      }
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
      buyerName: cleanOptional(input.buyerName),
      buyerPhone: cleanOptional(input.buyerPhone),
      buyerAddress: cleanOptional(input.buyerAddress),
      packageDescription: cleanOptional(input.packageDescription),
      packageWeight: input.packageWeight,
      paymentMode: input.paymentMode,
      codAmount: input.paymentMode === PaymentMode.COD ? input.codAmount ?? 0 : 0,
      courierPreference: cleanOptional(input.courierPreference),
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
      buyerPincode: request.deliveryPincode,
      deliveryPincode: request.deliveryPincode,
      packageWeight: request.packageWeight,
      courierPreference: request.courierPreference
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
  if (input.patch.courierPreference !== undefined) data.courierPreference = cleanOptional(input.patch.courierPreference);
  if (input.patch.assignedCourierId !== undefined) data.assignedCourierId = cleanOptional(input.patch.assignedCourierId);
  if (input.patch.freightEstimate !== undefined) data.freightEstimate = input.patch.freightEstimate;
  if (input.patch.codAmount !== undefined) data.codAmount = input.patch.codAmount ?? 0;
  if (input.patch.awb !== undefined) data.awb = cleanOptional(input.patch.awb);
  if (input.patch.trackingNumber !== undefined) data.trackingNumber = cleanOptional(input.patch.trackingNumber);
  if (input.patch.trackingUrl !== undefined) data.trackingUrl = cleanOptional(input.patch.trackingUrl);
  if (input.patch.opsNotes !== undefined) data.opsNotes = cleanOptional(input.patch.opsNotes);
  if (input.patch.notes !== undefined) data.notes = cleanOptional(input.patch.notes);
  if (
    input.patch.status === FirstShipmentRequestStatus.READY_TO_BOOK &&
    existing.status !== FirstShipmentRequestStatus.READY_TO_BOOK
  ) {
    data.adminApprovedAt = new Date();
    data.adminApprovedBy = input.actorId || null;
  }

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
      changed: {
        status: input.patch.status !== undefined && existing.status !== request.status,
        courierPreference: input.patch.courierPreference !== undefined && existing.courierPreference !== request.courierPreference,
        assignedCourierId: input.patch.assignedCourierId !== undefined && existing.assignedCourierId !== request.assignedCourierId,
        freightEstimate: input.patch.freightEstimate !== undefined && existing.freightEstimate !== request.freightEstimate,
        codAmount: input.patch.codAmount !== undefined && existing.codAmount !== request.codAmount,
        awb: input.patch.awb !== undefined && existing.awb !== request.awb,
        trackingNumber: input.patch.trackingNumber !== undefined && existing.trackingNumber !== request.trackingNumber,
        trackingUrl: input.patch.trackingUrl !== undefined && existing.trackingUrl !== request.trackingUrl,
        opsNotes: input.patch.opsNotes !== undefined,
        notes: input.patch.notes !== undefined
      }
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

async function convertInClient(input: {
  requestId: string;
  actorId?: string | undefined;
  courierId: string;
  awbNumber: string;
  freightEstimate?: number | undefined;
  codAmount?: number | undefined;
  status?: string | undefined;
  trackingUrl?: string | null | undefined;
  opsNotes?: string | null | undefined;
}, client: Db) {
  const request = await client.firstShipmentRequest.findUnique({
    where: { id: input.requestId },
    include: requestInclude
  });

  if (!request) return null;

  const courier = await client.courierPartner.findUnique({
    where: { id: input.courierId },
    select: { id: true, name: true, code: true }
  });
  if (!courier) throw new HttpError(404, "COURIER_NOT_FOUND");

  const awbNumber = clean(input.awbNumber).toUpperCase();
  const shipmentData = {
    courierId: input.courierId,
    firstShipmentRequestId: request.id,
    orderId: request.id,
    awbNumber,
    fromPincode: request.pickupPincode,
    toPincode: request.deliveryPincode,
    status: input.status || "pickup_scheduled",
    weightGrams: request.packageWeight,
    paymentMode: request.paymentMode,
    codAmount: input.codAmount ?? request.codAmount,
    freightEstimate: input.freightEstimate ?? null,
    trackingUrl: cleanOptional(input.trackingUrl),
    opsNotes: cleanOptional(input.opsNotes),
    lastEvent: "Manual shipment booked by admin"
  };

  const shipment = request.manualShipment
    ? await client.courierShipment.update({
      where: { id: request.manualShipment.id },
      data: shipmentData,
      include: { courier: true }
    })
    : await client.courierShipment.create({
      data: {
        ...shipmentData,
        events: {
          create: {
            courierId: input.courierId,
            courierUserId: input.actorId || null,
            eventType: "manual_first_shipment_booked",
            status: shipmentData.status,
            remarks: "Manual first shipment booked by admin"
          }
        }
      },
      include: { courier: true, events: true }
    });

  const updatedRequest = await client.firstShipmentRequest.update({
    where: { id: request.id },
    data: {
      assignedCourierId: input.courierId,
      freightEstimate: shipment.freightEstimate,
      codAmount: shipment.codAmount,
      awb: shipment.awbNumber,
      trackingNumber: shipment.awbNumber,
      trackingUrl: shipment.trackingUrl,
      opsNotes: shipment.opsNotes,
      status: FirstShipmentRequestStatus.AWB_ADDED
    },
    include: requestInclude
  });

  const onboardingInput: Parameters<typeof updateMerchantOnboarding>[0] = {
    merchantId: request.merchantId,
    patch: {
      firstShipmentStatus: onboardingStatusForRequest(updatedRequest.status)
    }
  };
  if (input.actorId) onboardingInput.actorId = input.actorId;

  await updateMerchantOnboarding(onboardingInput, client);

  const auditInput: Parameters<typeof audit>[0] = {
    merchantId: request.merchantId,
    action: request.manualShipment ? "FIRST_SHIPMENT_MANUAL_SHIPMENT_UPDATED" : "FIRST_SHIPMENT_MANUAL_SHIPMENT_CREATED",
    entityType: "courier_shipment",
    entityId: shipment.id,
    metadata: {
      requestId: request.id,
      courierId: shipment.courierId,
      courierCode: courier.code,
      awbNumber: shipment.awbNumber,
      freightEstimate: shipment.freightEstimate,
      codAmount: shipment.codAmount,
      status: shipment.status
    }
  };
  if (input.actorId) auditInput.actorId = input.actorId;

  await audit(auditInput, client).catch(() => undefined);

  return { request: updatedRequest, shipment };
}

export async function convertFirstShipmentRequestToManualShipment(input: {
  requestId: string;
  actorId?: string | undefined;
  courierId: string;
  awbNumber: string;
  freightEstimate?: number | undefined;
  codAmount?: number | undefined;
  status?: string | undefined;
  trackingUrl?: string | null | undefined;
  opsNotes?: string | null | undefined;
}, client: Db = prisma) {
  if ("$transaction" in client && typeof (client as typeof prisma).$transaction === "function") {
    return (client as typeof prisma).$transaction((tx) => convertInClient(input, tx));
  }

  return convertInClient(input, client);
}
