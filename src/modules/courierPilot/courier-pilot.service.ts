import { CourierSandboxVerificationStatus, type Prisma } from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { normalizePincode } from "../../lib/state.js";
import { audit } from "../audit/audit.service.js";
import { getCourierActivationReadiness } from "../taxCompliance/tax-compliance.service.js";

type Db = Prisma.TransactionClient | typeof prisma;

export const COURIER_PILOT_CHECKLIST_ITEMS = [
  { itemKey: "rate_card_ready", label: "Rate card uploaded/manual rates entered" },
  { itemKey: "serviceability_ready", label: "Serviceable pincode list loaded" },
  { itemKey: "cod_policy_confirmed", label: "COD support and remittance policy confirmed" },
  { itemKey: "manual_booking_mode_confirmed", label: "Manual booking mode confirmed" },
  { itemKey: "manual_shipment_tested", label: "Manual shipment dry run tested" },
  { itemKey: "tracking_status_tested", label: "AWB/tracking/status update tested" },
  { itemKey: "seller_handoff_ready", label: "Seller pilot handoff ready" }
] as const;

export type CourierPilotChecklistItemKey = typeof COURIER_PILOT_CHECKLIST_ITEMS[number]["itemKey"];

export type ServiceablePincodePatch = {
  pincodes: string[];
  supportsPickup?: boolean | undefined;
  supportsDelivery?: boolean | undefined;
  supportsCOD?: boolean | undefined;
  active?: boolean | undefined;
  notes?: string | null | undefined;
};

function cleanOptionalText(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizePincodeList(pincodes: string[]) {
  const normalized = pincodes
    .flatMap((value) => String(value || "").split(/[,\n\r\t ]+/))
    .map((value) => value.trim())
    .filter(Boolean)
    .map(normalizePincode);

  return [...new Set(normalized)];
}

function auditMetadataFromChecklistPatch(patch: {
  status?: CourierSandboxVerificationStatus | undefined;
  owner?: string | null | undefined;
  notes?: string | null | undefined;
  evidenceUrl?: string | null | undefined;
}) {
  const metadata: Record<string, unknown> = {
    changed: {
      status: patch.status !== undefined,
      owner: patch.owner !== undefined,
      notes: patch.notes !== undefined,
      evidenceUrl: patch.evidenceUrl !== undefined
    }
  };
  if (patch.status !== undefined) metadata.status = patch.status;

  return metadata;
}

export async function ensureCourierPilotChecklist(courierId: string, client: Db = prisma) {
  await client.courierPilotChecklistItem.createMany({
    data: COURIER_PILOT_CHECKLIST_ITEMS.map((item) => ({
      courierId,
      itemKey: item.itemKey,
      label: item.label
    })),
    skipDuplicates: true
  });

  return client.courierPilotChecklistItem.findMany({
    where: { courierId },
    orderBy: { createdAt: "asc" }
  });
}

export async function getCourierPilotSetup(courierId: string, client: Db = prisma) {
  const [checklist, serviceablePincodes, activationReadiness] = await Promise.all([
    ensureCourierPilotChecklist(courierId, client),
    client.courierServiceablePincode.findMany({
      where: { courierId },
      orderBy: [{ active: "desc" }, { pincode: "asc" }]
    }),
    getCourierActivationReadiness(courierId, client)
  ]);

  return {
    checklist,
    serviceablePincodes,
    activationReadiness
  };
}

export async function upsertCourierServiceablePincodes(input: {
  courierId: string;
  actorId?: string | undefined;
  patch: ServiceablePincodePatch;
}, client: Db = prisma) {
  const pincodes = normalizePincodeList(input.patch.pincodes);
  if (!pincodes.length) throw new HttpError(400, "SERVICEABLE_PINCODES_REQUIRED");

  const data = {
    supportsPickup: input.patch.supportsPickup ?? true,
    supportsDelivery: input.patch.supportsDelivery ?? true,
    supportsCOD: input.patch.supportsCOD ?? true,
    active: input.patch.active ?? true,
    notes: cleanOptionalText(input.patch.notes)
  };

  const records = [];
  for (const pincode of pincodes) {
    const record = await client.courierServiceablePincode.upsert({
      where: {
        courierId_pincode: {
          courierId: input.courierId,
          pincode
        }
      },
      create: {
        courierId: input.courierId,
        pincode,
        ...data
      },
      update: data
    });
    records.push(record);
  }

  const auditInput: Parameters<typeof audit>[0] = {
    action: "COURIER_SERVICEABLE_PINCODES_UPSERTED",
    entityType: "courier_partner",
    entityId: input.courierId,
    metadata: {
      courierId: input.courierId,
      pincodeCount: records.length,
      supportsPickup: data.supportsPickup,
      supportsDelivery: data.supportsDelivery,
      supportsCOD: data.supportsCOD,
      active: data.active
    }
  };
  if (input.actorId) auditInput.actorId = input.actorId;

  await audit(auditInput, client).catch(() => undefined);

  return records;
}

export async function deleteCourierServiceablePincode(input: {
  courierId: string;
  pincodeId: string;
  actorId?: string | undefined;
}, client: Db = prisma) {
  const existing = await client.courierServiceablePincode.findFirst({
    where: { id: input.pincodeId, courierId: input.courierId }
  });
  if (!existing) throw new HttpError(404, "SERVICEABLE_PINCODE_NOT_FOUND");

  const record = await client.courierServiceablePincode.delete({
    where: { id: existing.id }
  });

  const auditInput: Parameters<typeof audit>[0] = {
    action: "COURIER_SERVICEABLE_PINCODE_DELETED",
    entityType: "courier_serviceable_pincode",
    entityId: record.id,
    metadata: {
      courierId: input.courierId,
      pincode: record.pincode
    }
  };
  if (input.actorId) auditInput.actorId = input.actorId;

  await audit(auditInput, client).catch(() => undefined);

  return record;
}

export async function updateCourierPilotChecklistItem(input: {
  courierId: string;
  itemKey: string;
  actorId?: string | undefined;
  patch: {
    status?: CourierSandboxVerificationStatus | undefined;
    owner?: string | null | undefined;
    notes?: string | null | undefined;
    evidenceUrl?: string | null | undefined;
  };
}, client: Db = prisma) {
  await ensureCourierPilotChecklist(input.courierId, client);

  const data: Prisma.CourierPilotChecklistItemUpdateInput = {};
  if (input.patch.status !== undefined) {
    data.status = input.patch.status;
    data.verifiedAt = input.patch.status === CourierSandboxVerificationStatus.PASSED ? new Date() : null;
    data.verifiedBy = input.patch.status === CourierSandboxVerificationStatus.PASSED ? input.actorId || null : null;
  }
  if (input.patch.owner !== undefined) data.owner = cleanOptionalText(input.patch.owner);
  if (input.patch.notes !== undefined) data.notes = cleanOptionalText(input.patch.notes);
  if (input.patch.evidenceUrl !== undefined) data.evidenceUrl = cleanOptionalText(input.patch.evidenceUrl);

  const item = await client.courierPilotChecklistItem.update({
    where: {
      courierId_itemKey: {
        courierId: input.courierId,
        itemKey: input.itemKey
      }
    },
    data
  }).catch(() => null);

  if (!item) throw new HttpError(404, "COURIER_PILOT_CHECKLIST_ITEM_NOT_FOUND");

  const auditInput: Parameters<typeof audit>[0] = {
    action: "COURIER_PILOT_CHECKLIST_UPDATED",
    entityType: "courier_pilot_checklist_item",
    entityId: item.id,
    metadata: {
      courierId: input.courierId,
      itemKey: input.itemKey,
      ...auditMetadataFromChecklistPatch(input.patch)
    }
  };
  if (input.actorId) auditInput.actorId = input.actorId;

  await audit(auditInput, client).catch(() => undefined);

  return item;
}
