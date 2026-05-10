import { CourierPartnerApplicationStatus, type Prisma } from "@prisma/client";
import { logger } from "../../lib/logger.js";
import { normalizeRequiredGstin } from "../../lib/gstin.js";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { createAdminCourierPartner } from "../courierPartnerOnboarding/onboarding.service.js";

type Db = Prisma.TransactionClient | typeof prisma;

export type CourierPartnerApplicationInput = {
  companyName: string;
  contactName: string;
  phone: string;
  email: string;
  website?: string | null | undefined;
  gstin: string;
  registeredState: string;
  registeredCity: string;
  operationalStates: string[];
  serviceablePincodesEstimate: string;
  codSupported: boolean;
  apiAvailable: boolean;
  notes?: string | null | undefined;
};

type CreatePartnerFn = typeof createAdminCourierPartner;

function cleanText(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function cleanOptionalText(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function normalizeOperationalStates(values: string[]) {
  const states = values
    .flatMap((value) => String(value || "").split(/[,\n\r\t]+/))
    .map((value) => cleanText(value))
    .filter(Boolean);

  return [...new Set(states)];
}

function courierCodeFromApplication(application: { id: string; companyName: string }) {
  const slug = application.companyName
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 18) || "COURIER";

  return `${slug}_${application.id.slice(-6).toUpperCase()}`;
}

function applicationResponse(application: {
  id: string;
  companyName: string;
  contactName: string;
  phone: string;
  email: string;
  website: string | null;
  gstin: string;
  registeredState: string;
  registeredCity: string;
  operationalStates: string[];
  serviceablePincodesEstimate: string;
  codSupported: boolean;
  apiAvailable: boolean;
  notes: string | null;
  status: CourierPartnerApplicationStatus;
  convertedCourierId: string | null;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: application.id,
    companyName: application.companyName,
    contactName: application.contactName,
    phone: application.phone,
    email: application.email,
    website: application.website,
    gstin: application.gstin,
    registeredState: application.registeredState,
    registeredCity: application.registeredCity,
    operationalStates: application.operationalStates,
    serviceablePincodesEstimate: application.serviceablePincodesEstimate,
    codSupported: application.codSupported,
    apiAvailable: application.apiAvailable,
    notes: application.notes,
    status: application.status,
    convertedCourierId: application.convertedCourierId,
    reviewedAt: application.reviewedAt,
    reviewedBy: application.reviewedBy,
    createdAt: application.createdAt,
    updatedAt: application.updatedAt
  };
}

export async function createCourierPartnerApplication(input: CourierPartnerApplicationInput, client: Db = prisma) {
  const operationalStates = normalizeOperationalStates(input.operationalStates);
  if (!operationalStates.length) throw new HttpError(400, "OPERATIONAL_STATES_REQUIRED");

  const application = await client.courierPartnerApplication.create({
    data: {
      companyName: cleanText(input.companyName),
      contactName: cleanText(input.contactName),
      phone: cleanText(input.phone),
      email: normalizeEmail(input.email),
      website: cleanOptionalText(input.website),
      gstin: normalizeRequiredGstin(input.gstin),
      registeredState: cleanText(input.registeredState),
      registeredCity: cleanText(input.registeredCity),
      operationalStates,
      serviceablePincodesEstimate: cleanText(input.serviceablePincodesEstimate),
      codSupported: input.codSupported,
      apiAvailable: input.apiAvailable,
      notes: cleanOptionalText(input.notes),
      status: CourierPartnerApplicationStatus.PENDING_REVIEW
    }
  });

  await client.auditLog.create({
    data: {
      action: "COURIER_PARTNER_APPLICATION_RECEIVED",
      entityType: "courier_partner_application",
      entityId: application.id,
      metadata: {
        applicationId: application.id,
        status: application.status,
        operationalStateCount: application.operationalStates.length,
        codSupported: application.codSupported,
        apiAvailable: application.apiAvailable
      }
    }
  });

  logger.info({
    courierPartnerApplication: {
      id: application.id,
      status: application.status,
      operationalStateCount: application.operationalStates.length
    }
  }, "courier_partner_application_received");

  return {
    ok: true,
    applicationId: application.id,
    status: application.status
  };
}

export async function listCourierPartnerApplications(client: Db = prisma) {
  const applications = await client.courierPartnerApplication.findMany({
    orderBy: [{ status: "asc" }, { createdAt: "desc" }]
  });

  return {
    applications: applications.map(applicationResponse)
  };
}

export async function convertCourierPartnerApplication(input: {
  applicationId: string;
  actorId?: string | undefined;
  code?: string | undefined;
}, client: Db = prisma, deps: { createPartner?: CreatePartnerFn } = {}) {
  const application = await client.courierPartnerApplication.findUnique({
    where: { id: input.applicationId }
  });

  if (!application) throw new HttpError(404, "COURIER_PARTNER_APPLICATION_NOT_FOUND");
  if (application.status === CourierPartnerApplicationStatus.CONVERTED) {
    throw new HttpError(400, "COURIER_PARTNER_APPLICATION_ALREADY_CONVERTED");
  }
  if (application.status === CourierPartnerApplicationStatus.REJECTED) {
    throw new HttpError(400, "COURIER_PARTNER_APPLICATION_REJECTED");
  }

  await client.courierPartnerApplication.update({
    where: { id: application.id },
    data: {
      status: CourierPartnerApplicationStatus.IN_REVIEW,
      reviewedAt: new Date(),
      reviewedBy: input.actorId || null
    }
  });

  const createPartner = deps.createPartner || createAdminCourierPartner;
  const created = await createPartner({
    name: application.companyName,
    code: input.code?.trim() || courierCodeFromApplication(application),
    contactName: application.contactName,
    contactEmail: application.email,
    legalName: application.companyName,
    gstin: application.gstin,
    address: `${application.registeredCity}, ${application.registeredState}`,
    actorId: input.actorId
  });

  const converted = await client.courierPartnerApplication.update({
    where: { id: application.id },
    data: {
      status: CourierPartnerApplicationStatus.CONVERTED,
      convertedCourierId: created.partner.id,
      reviewedAt: new Date(),
      reviewedBy: input.actorId || null
    }
  });

  const auditData: Prisma.AuditLogUncheckedCreateInput = {
    action: "COURIER_PARTNER_APPLICATION_CONVERTED",
    entityType: "courier_partner_application",
    entityId: converted.id,
    metadata: {
      applicationId: converted.id,
      courierId: created.partner.id,
      courierCode: created.partner.code
    }
  };
  if (input.actorId) auditData.actorId = input.actorId;

  await client.auditLog.create({ data: auditData });

  return {
    application: applicationResponse(converted),
    partner: created.partner
  };
}
