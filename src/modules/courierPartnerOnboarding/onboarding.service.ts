import {
  CourierPartnerOnboardingStatus,
  CourierSandboxVerificationStatus,
  Prisma
} from "@prisma/client";
import bcrypt from "bcryptjs";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from "node:crypto";
import { env } from "../../config/env.js";
import {
  COURIER_SERVICE_CODE_OPTIONS,
  normalizeCourierServiceTaxClassification
} from "../../lib/courierServiceTax.js";
import { normalizeRequiredGstin } from "../../lib/gstin.js";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { createCourierInvite } from "../auth/password-reset.service.js";
import { getCourierActivationReadiness } from "../taxCompliance/tax-compliance.service.js";

type Db = Prisma.TransactionClient | typeof prisma;

export const ONBOARDING_SECTIONS = [
  "companyLegal",
  "commercial",
  "serviceability",
  "codRemittance",
  "api",
  "webhookSecurity",
  "escalation"
] as const;

export const SANDBOX_VERIFICATION_ITEMS = [
  { itemKey: "api_docs_reviewed", label: "API docs reviewed" },
  { itemKey: "sandbox_credentials_verified", label: "Sandbox creds verified" },
  { itemKey: "quote_tested", label: "Quote tested" },
  { itemKey: "shipment_create_tested", label: "Shipment create tested" },
  { itemKey: "awb_label_tested", label: "AWB/label tested" },
  { itemKey: "pickup_cancel_tested", label: "Pickup/cancel tested" },
  { itemKey: "tracking_tested", label: "Tracking tested" },
  { itemKey: "webhook_signature_tested", label: "Webhook signature tested" },
  { itemKey: "webhook_retry_tested", label: "Webhook retry tested" },
  { itemKey: "ndr_tested", label: "NDR tested" },
  { itemKey: "cod_remittance_reviewed", label: "COD/remittance reviewed" },
  { itemKey: "production_approval_ready", label: "Production approval ready" }
] as const;

type OnboardingSection = (typeof ONBOARDING_SECTIONS)[number];
type SandboxVerificationItemKey = (typeof SANDBOX_VERIFICATION_ITEMS)[number]["itemKey"];

export type CourierSandboxVerificationPatch = {
  status?: CourierSandboxVerificationStatus | undefined;
  owner?: string | null | undefined;
  notes?: string | null | undefined;
  evidenceUrl?: string | null | undefined;
};

export type CourierCredentialInput = {
  sandbox?: Record<string, unknown> | undefined;
  prod?: Record<string, unknown> | undefined;
};

export type CourierOnboardingPatch = Partial<Record<OnboardingSection, unknown>> & {
  credentials?: CourierCredentialInput | undefined;
};

const editableStatuses = new Set<CourierPartnerOnboardingStatus>([
  CourierPartnerOnboardingStatus.DRAFT,
  CourierPartnerOnboardingStatus.REOPENED
]);

const sandboxVerificationItemKeys = new Set<string>(
  SANDBOX_VERIFICATION_ITEMS.map((item) => item.itemKey)
);

const credentialLabels: Record<string, string> = {
  apiKey: "API key",
  token: "Token",
  clientSecret: "Client secret",
  password: "Password",
  webhookSecret: "Webhook secret"
};

const sensitiveKeyPattern = /(api[_-]?key|password|passwd|pwd|token|secret|credential|authorization|bearer)/i;
const sensitiveValuePatterns = [
  /\b(api[_\s-]?key|password|passwd|pwd|token|secret|credential|bearer)\b\s*[:=]\s*[^\s,;}]+/gi,
  /\bbearer\s+[a-z0-9._~+/=-]+/gi,
  /\b(sk|pk)_[a-z0-9_]{12,}/gi
];

async function runTransaction<T>(
  client: Db,
  callback: (tx: Prisma.TransactionClient) => Promise<T>
) {
  if ("$transaction" in client && typeof (client as typeof prisma).$transaction === "function") {
    return (client as typeof prisma).$transaction(callback);
  }

  return callback(client as Prisma.TransactionClient);
}

function encryptionKey() {
  return createHash("sha256")
    .update(`${env.APP_SECRET_PEPPER}:${env.JWT_SECRET}:courier-partner-secret-v1`)
    .digest();
}

export function encryptSecretValue(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);

  return {
    encryptedValue: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64")
  };
}

export function decryptSecretValue(input: {
  encryptedValue: string;
  iv: string;
  authTag: string;
}) {
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(input.iv, "base64"));
  decipher.setAuthTag(Buffer.from(input.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(input.encryptedValue, "base64")),
    decipher.final()
  ]).toString("utf8");
}

export function maskSecretValue(value: string) {
  const normalized = value.trim();
  if (!normalized) return "";
  const suffix = normalized.slice(-4);
  return `****${suffix}`;
}

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        sensitiveKeyPattern.test(key) ? "[redacted]" : redactSecrets(entry)
      ])
    );
  }

  if (typeof value === "string") {
    let next = value;
    for (const pattern of sensitiveValuePatterns) {
      next = next.replace(pattern, "[redacted]");
    }
    return next;
  }

  return value;
}

function jsonObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return redactSecrets(value) as Prisma.InputJsonObject;
}

function normalizeCompanyLegalSection(section: OnboardingSection, value: unknown) {
  const next = jsonObject(value);
  if (section !== "companyLegal") {
    return { value: next };
  }

  const rawGstin = next.gstin ?? next.gstNumber;
  const normalizedGstin = rawGstin === undefined
    ? undefined
    : normalizeRequiredGstin(typeof rawGstin === "string" ? rawGstin : String(rawGstin ?? ""));
  const serviceTax = normalizeCourierServiceTaxClassification(next);

  return {
    value: {
      ...next,
      ...(normalizedGstin !== undefined ? {
        gstin: normalizedGstin,
        gstNumber: normalizedGstin
      } : {}),
      ...serviceTax
    },
    gstin: normalizedGstin,
    serviceTax
  };
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function normalizeCode(code: string) {
  return code.trim().toUpperCase();
}

function secretRef(courierId: string, environment: string, fieldKey: string) {
  return [
    "courier-partner",
    courierId,
    environment.toLowerCase(),
    fieldKey,
    randomBytes(8).toString("hex")
  ].join("/");
}

async function writeOnboardingAudit(input: {
  client: Db;
  onboardingId: string;
  courierId: string;
  actorType: "ADMIN" | "COURIER" | "SYSTEM";
  actorId?: string | undefined;
  action: string;
  metadata?: unknown | undefined;
}) {
  const metadata = input.metadata === undefined
    ? undefined
    : redactSecrets(input.metadata) as Prisma.InputJsonValue;

  const onboardingAuditData: Prisma.CourierPartnerOnboardingAuditUncheckedCreateInput = {
    onboardingId: input.onboardingId,
    courierId: input.courierId,
    actorType: input.actorType,
    action: input.action
  };
  if (input.actorId) onboardingAuditData.actorId = input.actorId;
  if (metadata !== undefined) onboardingAuditData.metadata = metadata;

  await input.client.courierPartnerOnboardingAudit.create({
    data: onboardingAuditData
  });

  const auditData: Prisma.AuditLogUncheckedCreateInput = {
    action: input.action,
    entityType: "courier_partner_onboarding",
    entityId: input.onboardingId,
    metadata: {
      courierId: input.courierId,
      ...(metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata as Prisma.InputJsonObject : {})
    }
  };
  if (input.actorId) auditData.actorId = input.actorId;

  await input.client.auditLog.create({
    data: auditData
  });
}

async function storeCredentials(input: {
  client: Db;
  onboardingId: string;
  courierId: string;
  credentials?: CourierCredentialInput | undefined;
}) {
  const stored: Array<{ environment: string; fieldKey: string }> = [];

  for (const environment of ["sandbox", "prod"] as const) {
    const envCredentials = input.credentials?.[environment];
    if (!envCredentials || typeof envCredentials !== "object" || Array.isArray(envCredentials)) {
      continue;
    }

    for (const [fieldKey, rawValue] of Object.entries(envCredentials)) {
      const label = credentialLabels[fieldKey];
      if (!label || typeof rawValue !== "string") {
        continue;
      }

      const value = rawValue.trim();
      if (!value) continue;

      const encrypted = encryptSecretValue(value);
      const ref = secretRef(input.courierId, environment, fieldKey);

      await input.client.courierPartnerSecret.create({
        data: {
          courierId: input.courierId,
          secretRef: ref,
          ...encrypted
        }
      });

      await input.client.courierPartnerCredential.upsert({
        where: {
          onboardingId_environment_fieldKey: {
            onboardingId: input.onboardingId,
            environment,
            fieldKey
          }
        },
        update: {
          label,
          maskedValue: maskSecretValue(value),
          secretRef: ref,
          secretStatus: "STORED",
          providedAt: new Date()
        },
        create: {
          onboardingId: input.onboardingId,
          courierId: input.courierId,
          environment,
          fieldKey,
          label,
          maskedValue: maskSecretValue(value),
          secretRef: ref,
          secretStatus: "STORED"
        }
      });

      stored.push({ environment, fieldKey });
    }
  }

  return stored;
}

function credentialResponse(credentials: Array<{
  environment: string;
  fieldKey: string;
  label: string;
  maskedValue: string;
  secretRef: string;
  secretStatus: string;
  updatedAt: Date;
}>) {
  return credentials.map((credential) => ({
    environment: credential.environment,
    fieldKey: credential.fieldKey,
    label: credential.label,
    maskedValue: credential.maskedValue,
    secretRef: credential.secretRef,
    secretStatus: credential.secretStatus,
    updatedAt: credential.updatedAt
  }));
}

function auditResponse(audits: Array<{
  id: string;
  actorType: string;
  actorId: string | null;
  action: string;
  metadata: Prisma.JsonValue | null;
  createdAt: Date;
}>) {
  return audits.map((audit) => ({
    id: audit.id,
    actorType: audit.actorType,
    actorId: audit.actorId,
    action: audit.action,
    metadata: audit.metadata,
    createdAt: audit.createdAt
  }));
}

type SandboxVerificationChecklistRecord = {
  id: string;
  courierId: string;
  itemKey: string;
  label: string;
  status: CourierSandboxVerificationStatus;
  owner: string | null;
  notes: string | null;
  evidenceUrl: string | null;
  verifiedAt: Date | null;
  verifiedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function sandboxChecklistData(courierId: string) {
  return SANDBOX_VERIFICATION_ITEMS.map((item) => ({
    courierId,
    itemKey: item.itemKey,
    label: item.label,
    status: CourierSandboxVerificationStatus.PENDING
  }));
}

function sortSandboxVerificationChecklist<T extends { itemKey: string }>(items: T[]) {
  const order = new Map<string, number>(
    SANDBOX_VERIFICATION_ITEMS.map((item, index) => [item.itemKey, index])
  );
  return [...items].sort((left, right) => (
    (order.get(left.itemKey) ?? 999) - (order.get(right.itemKey) ?? 999)
  ));
}

async function ensureSandboxVerificationChecklist(courierId: string, client: Db = prisma) {
  const existing = await client.courierSandboxVerificationChecklistItem.findMany({
    where: { courierId }
  });
  const existingKeys = new Set(existing.map((item) => item.itemKey));
  const missing = SANDBOX_VERIFICATION_ITEMS.filter((item) => !existingKeys.has(item.itemKey));

  if (missing.length > 0) {
    await client.courierSandboxVerificationChecklistItem.createMany({
      data: missing.map((item) => ({
        courierId,
        itemKey: item.itemKey,
        label: item.label,
        status: CourierSandboxVerificationStatus.PENDING
      })),
      skipDuplicates: true
    });

    return sortSandboxVerificationChecklist(await client.courierSandboxVerificationChecklistItem.findMany({
      where: { courierId }
    }));
  }

  return sortSandboxVerificationChecklist(existing);
}

function sandboxVerificationResponse(items: SandboxVerificationChecklistRecord[]) {
  return sortSandboxVerificationChecklist(items).map((item) => ({
    id: item.id,
    itemKey: item.itemKey,
    label: item.label,
    status: item.status,
    owner: item.owner,
    notes: item.notes,
    evidenceUrl: item.evidenceUrl,
    verifiedAt: item.verifiedAt,
    verifiedBy: item.verifiedBy,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  }));
}

function isSandboxVerificationComplete(items: Array<{ status: CourierSandboxVerificationStatus }>) {
  return items.length === SANDBOX_VERIFICATION_ITEMS.length &&
    items.every((item) => item.status === CourierSandboxVerificationStatus.PASSED);
}

function sanitizedText(value: string | null | undefined, maxLength: number) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const redacted = redactSecrets(value);
  if (typeof redacted !== "string") return null;
  const trimmed = redacted.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function companyLegalResponse(record: Prisma.CourierPartnerOnboardingGetPayload<{
  include: { courier: true };
}>) {
  return {
    ...jsonObject(record.companyLegal),
    gstin: record.courier.gstin || "",
    gstNumber: record.courier.gstin || "",
    serviceCodeType: record.courier.serviceCodeType,
    serviceCode: record.courier.serviceCode,
    serviceDescription: record.courier.serviceDescription,
    gstRate: record.courier.gstRate
  };
}

function onboardingResponse(record: Prisma.CourierPartnerOnboardingGetPayload<{
  include: {
    courier: true;
    credentials: true;
    audits: { orderBy: { createdAt: "desc" } };
  };
}>) {
  return {
    id: record.id,
    status: record.status,
    companyLegal: companyLegalResponse(record),
    commercial: record.commercial,
    serviceability: record.serviceability,
    codRemittance: record.codRemittance,
    api: record.api,
    webhookSecurity: record.webhookSecurity,
    escalation: record.escalation,
    changeRequest: record.changeRequest,
    submittedAt: record.submittedAt,
    reviewedAt: record.reviewedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    courier: {
      id: record.courier.id,
      name: record.courier.name,
      code: record.courier.code,
      gstin: record.courier.gstin,
      serviceCodeType: record.courier.serviceCodeType,
      serviceCode: record.courier.serviceCode,
      serviceDescription: record.courier.serviceDescription,
      gstRate: record.courier.gstRate,
      active: record.courier.active,
      apiMode: record.courier.apiMode,
      supportsCOD: record.courier.supportsCOD,
      supportsPrepaid: record.courier.supportsPrepaid,
      supportsPickup: record.courier.supportsPickup,
      trackingUrlTemplate: record.courier.trackingUrlTemplate
    },
    serviceCodeOptions: COURIER_SERVICE_CODE_OPTIONS,
    credentials: credentialResponse(record.credentials),
    audits: auditResponse(record.audits)
  };
}

async function findOnboardingByCourierId(courierId: string, client: Db = prisma) {
  return client.courierPartnerOnboarding.findUnique({
    where: { courierId },
    include: {
      courier: true,
      credentials: { orderBy: [{ environment: "asc" }, { fieldKey: "asc" }] },
      audits: { orderBy: { createdAt: "desc" } }
    }
  });
}

export async function getCourierOnboarding(courierId: string, client: Db = prisma) {
  const record = await findOnboardingByCourierId(courierId, client);
  if (!record) throw new HttpError(404, "COURIER_ONBOARDING_NOT_FOUND");
  return onboardingResponse(record);
}

export async function saveCourierOnboardingDraft(input: {
  courierId: string;
  actorId: string;
  patch: CourierOnboardingPatch;
}, client: Db = prisma) {
  const existing = await client.courierPartnerOnboarding.findUnique({
    where: { courierId: input.courierId }
  });

  if (!existing) throw new HttpError(404, "COURIER_ONBOARDING_NOT_FOUND");
  if (!editableStatuses.has(existing.status)) {
    throw new HttpError(409, "COURIER_ONBOARDING_READ_ONLY");
  }

  const data: Prisma.CourierPartnerOnboardingUpdateInput = {};
  const courierData: Prisma.CourierPartnerUpdateInput = {};
  for (const section of ONBOARDING_SECTIONS) {
    if (input.patch[section] !== undefined) {
      const normalized = normalizeCompanyLegalSection(section, input.patch[section]);
      data[section] = normalized.value;
      if (section === "companyLegal") {
        if ("gstin" in normalized && normalized.gstin !== undefined) {
          courierData.gstin = normalized.gstin;
        }
        if ("serviceTax" in normalized && normalized.serviceTax) {
          courierData.serviceCodeType = normalized.serviceTax.serviceCodeType;
          courierData.serviceCode = normalized.serviceTax.serviceCode;
          courierData.serviceDescription = normalized.serviceTax.serviceDescription;
          courierData.gstRate = normalized.serviceTax.gstRate;
        }
      }
    }
  }

  await runTransaction(client, async (tx) => {
    if (Object.keys(data).length) {
      await tx.courierPartnerOnboarding.update({
        where: { id: existing.id },
        data
      });
    }

    if (Object.keys(courierData).length) {
      await tx.courierPartner.update({
        where: { id: input.courierId },
        data: courierData
      });
    }

    const storedCredentials = await storeCredentials({
      client: tx,
      onboardingId: existing.id,
      courierId: input.courierId,
      credentials: input.patch.credentials
    });

    await writeOnboardingAudit({
      client: tx,
      onboardingId: existing.id,
      courierId: input.courierId,
      actorType: "COURIER",
      actorId: input.actorId,
      action: "COURIER_PARTNER_ONBOARDING_UPDATED",
      metadata: {
        sections: ONBOARDING_SECTIONS.filter((section) => input.patch[section] !== undefined),
        credentialCount: storedCredentials.length,
        credentialKeys: storedCredentials
      }
    });
  });

  return getCourierOnboarding(input.courierId, client);
}

export async function submitCourierOnboarding(input: {
  courierId: string;
  actorId: string;
 }, client: Db = prisma) {
  const existing = await client.courierPartnerOnboarding.findUnique({
    where: { courierId: input.courierId },
    include: { courier: true }
  });

  if (!existing) throw new HttpError(404, "COURIER_ONBOARDING_NOT_FOUND");
  if (!editableStatuses.has(existing.status)) {
    throw new HttpError(409, "COURIER_ONBOARDING_READ_ONLY");
  }
  if (!existing.courier.gstin) {
    throw new HttpError(400, "GSTIN_REQUIRED");
  }

  await runTransaction(client, async (tx) => {
    await tx.courierPartnerOnboarding.update({
      where: { id: existing.id },
      data: {
        status: CourierPartnerOnboardingStatus.SUBMITTED,
        submittedAt: new Date(),
        changeRequest: null
      }
    });

    await writeOnboardingAudit({
      client: tx,
      onboardingId: existing.id,
      courierId: input.courierId,
      actorType: "COURIER",
      actorId: input.actorId,
      action: "COURIER_PARTNER_ONBOARDING_SUBMITTED",
      metadata: { status: CourierPartnerOnboardingStatus.SUBMITTED }
    });
  });

  return getCourierOnboarding(input.courierId, client);
}

export async function requestCourierOnboardingChange(input: {
  courierId: string;
  actorId: string;
  reason: string;
}, client: Db = prisma) {
  const existing = await client.courierPartnerOnboarding.findUnique({
    where: { courierId: input.courierId }
  });

  if (!existing) throw new HttpError(404, "COURIER_ONBOARDING_NOT_FOUND");

  await writeOnboardingAudit({
    client,
    onboardingId: existing.id,
    courierId: input.courierId,
    actorType: "COURIER",
    actorId: input.actorId,
    action: "COURIER_PARTNER_ONBOARDING_CHANGE_REQUESTED",
    metadata: { reason: redactSecrets(input.reason) }
  });

  return { ok: true };
}

export async function createAdminCourierPartner(input: {
  name: string;
  code: string;
  contactName: string;
  contactEmail: string;
  legalName?: string | undefined;
  gstin?: string | undefined;
  gstNumber?: string | undefined;
  serviceCodeType?: string | undefined;
  serviceCode?: string | undefined;
  serviceDescription?: string | undefined;
  gstRate?: number | string | undefined;
  address?: string | undefined;
  accountManager?: string | undefined;
  actorId?: string | undefined;
}, client: Db = prisma) {
  const email = normalizeEmail(input.contactEmail);
  const code = normalizeCode(input.code);
  const gstin = normalizeRequiredGstin(input.gstin ?? input.gstNumber);
  const serviceTax = normalizeCourierServiceTaxClassification(input);
  const passwordHash = await bcrypt.hash(randomBytes(32).toString("base64url"), 12);

  const created = await runTransaction(client, async (tx) => {
    const courier = await tx.courierPartner.create({
      data: {
        name: input.name.trim(),
        code,
        gstin,
        serviceCodeType: serviceTax.serviceCodeType,
        serviceCode: serviceTax.serviceCode,
        serviceDescription: serviceTax.serviceDescription,
        gstRate: serviceTax.gstRate,
        active: true,
        apiMode: "manual",
        supportsCOD: true,
        supportsPrepaid: true,
        supportsPickup: true
      }
    });

    const user = await tx.courierUser.create({
      data: {
        courierId: courier.id,
        name: input.contactName.trim(),
        email,
        passwordHash,
        active: true
      }
    });

    const onboarding = await tx.courierPartnerOnboarding.create({
      data: {
        courierId: courier.id,
        companyLegal: {
          companyName: input.name.trim(),
          legalName: input.legalName?.trim() || input.name.trim(),
          gstin,
          gstNumber: gstin,
          ...serviceTax,
          registeredAddress: input.address?.trim() || "",
          primaryContactName: input.contactName.trim(),
          primaryContactEmail: email,
          accountManager: input.accountManager?.trim() || ""
        }
      }
    });

    await tx.courierSandboxVerificationChecklistItem.createMany({
      data: sandboxChecklistData(courier.id),
      skipDuplicates: true
    });

    await writeOnboardingAudit({
      client: tx,
      onboardingId: onboarding.id,
      courierId: courier.id,
      actorType: "ADMIN",
      actorId: input.actorId,
      action: "COURIER_PARTNER_ONBOARDING_CREATED",
      metadata: { courierCode: courier.code, contactEmail: email }
    });

    return { courier, user, onboarding };
  });

  const invite = await createCourierInvite({
    courierUserId: created.user.id,
    actorId: input.actorId
  }).catch((err) => ({
    ok: false,
    emailSent: false,
    inviteLink: "",
    error: err instanceof Error ? err.message : "COURIER_INVITE_FAILED"
  }));

  return {
    partner: {
      id: created.courier.id,
      name: created.courier.name,
      code: created.courier.code,
      gstin: created.courier.gstin,
      serviceCodeType: created.courier.serviceCodeType,
      serviceCode: created.courier.serviceCode,
      serviceDescription: created.courier.serviceDescription,
      gstRate: created.courier.gstRate,
      active: created.courier.active,
      apiMode: created.courier.apiMode,
      onboardingStatus: created.onboarding.status,
      contactEmail: created.user.email
    },
    invite
  };
}

export async function listAdminCourierPartners(client: Db = prisma) {
  const partners = await client.courierPartner.findMany({
    include: {
      onboarding: {
        include: { credentials: true }
      },
      users: {
        orderBy: { createdAt: "asc" },
        take: 1
      }
    },
    orderBy: { createdAt: "desc" }
  });

  return {
    partners: partners.map((partner) => ({
      id: partner.id,
      name: partner.name,
      code: partner.code,
      gstin: partner.gstin,
      serviceCodeType: partner.serviceCodeType,
      serviceCode: partner.serviceCode,
      serviceDescription: partner.serviceDescription,
      gstRate: partner.gstRate,
      active: partner.active,
      apiMode: partner.apiMode,
      createdAt: partner.createdAt,
      updatedAt: partner.updatedAt,
      onboardingStatus: partner.onboarding?.status || null,
      submittedAt: partner.onboarding?.submittedAt || null,
      credentialCount: partner.onboarding?.credentials.length || 0,
      contactName: partner.users[0]?.name || "",
      contactEmail: partner.users[0]?.email || ""
    }))
  };
}

export async function getAdminCourierPartner(id: string, client: Db = prisma) {
  const record = await client.courierPartnerOnboarding.findFirst({
    where: {
      OR: [
        { id },
        { courierId: id },
        { courier: { is: { code: normalizeCode(id) } } }
      ]
    },
    include: {
      courier: {
        include: {
          users: {
            orderBy: { createdAt: "asc" }
          }
        }
      },
      credentials: { orderBy: [{ environment: "asc" }, { fieldKey: "asc" }] },
      audits: { orderBy: { createdAt: "desc" } }
    }
  });

  if (!record) throw new HttpError(404, "COURIER_PARTNER_NOT_FOUND");

  const sandboxVerificationChecklist = await ensureSandboxVerificationChecklist(record.courierId, client);

  return {
    partner: {
      ...onboardingResponse(record),
      sandboxVerificationChecklist: sandboxVerificationResponse(sandboxVerificationChecklist),
      users: record.courier.users.map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        active: user.active,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt
      }))
    }
  };
}

export async function updateCourierSandboxVerificationItem(input: {
  courierIdOrOnboardingId: string;
  itemKey: string;
  actorId?: string | undefined;
  patch: CourierSandboxVerificationPatch;
}, client: Db = prisma) {
  if (!sandboxVerificationItemKeys.has(input.itemKey)) {
    throw new HttpError(400, "COURIER_SANDBOX_VERIFICATION_ITEM_INVALID");
  }

  const current = await client.courierPartnerOnboarding.findFirst({
    where: {
      OR: [
        { id: input.courierIdOrOnboardingId },
        { courierId: input.courierIdOrOnboardingId },
        { courier: { is: { code: normalizeCode(input.courierIdOrOnboardingId) } } }
      ]
    }
  });

  if (!current) throw new HttpError(404, "COURIER_PARTNER_NOT_FOUND");

  await ensureSandboxVerificationChecklist(current.courierId, client);

  const existingItem = await client.courierSandboxVerificationChecklistItem.findFirst({
    where: {
      courierId: current.courierId,
      itemKey: input.itemKey
    }
  });

  if (!existingItem) throw new HttpError(404, "COURIER_SANDBOX_VERIFICATION_ITEM_NOT_FOUND");

  const data: Prisma.CourierSandboxVerificationChecklistItemUncheckedUpdateInput = {};
  const nextStatus = input.patch.status;
  if (nextStatus !== undefined) {
    data.status = nextStatus;
    if (nextStatus === CourierSandboxVerificationStatus.PASSED) {
      if (existingItem.status !== CourierSandboxVerificationStatus.PASSED || !existingItem.verifiedAt) {
        data.verifiedAt = new Date();
        data.verifiedBy = input.actorId || null;
      }
    } else {
      data.verifiedAt = null;
      data.verifiedBy = null;
    }
  }

  const owner = sanitizedText(input.patch.owner, 160);
  if (owner !== undefined) data.owner = owner;

  const notes = sanitizedText(input.patch.notes, 4000);
  if (notes !== undefined) data.notes = notes;

  const evidenceUrl = sanitizedText(input.patch.evidenceUrl, 2000);
  if (evidenceUrl !== undefined) data.evidenceUrl = evidenceUrl;

  const itemDefinition = SANDBOX_VERIFICATION_ITEMS.find((item) => item.itemKey === input.itemKey)!;

  await runTransaction(client, async (tx) => {
    const updatedItem = await tx.courierSandboxVerificationChecklistItem.update({
      where: {
        courierId_itemKey: {
          courierId: current.courierId,
          itemKey: input.itemKey
        }
      },
      data
    });

    await writeOnboardingAudit({
      client: tx,
      onboardingId: current.id,
      courierId: current.courierId,
      actorType: "ADMIN",
      actorId: input.actorId,
      action: "COURIER_SANDBOX_VERIFICATION_ITEM_UPDATED",
      metadata: {
        itemKey: input.itemKey,
        label: itemDefinition.label,
        fromStatus: existingItem.status,
        toStatus: updatedItem.status,
        owner: updatedItem.owner,
        evidenceUrl: updatedItem.evidenceUrl,
        notes: updatedItem.notes,
        verifiedAt: updatedItem.verifiedAt?.toISOString() || null,
        verifiedBy: updatedItem.verifiedBy
      }
    });
  });

  return getAdminCourierPartner(current.courierId, client);
}

export async function setAdminCourierPartnerStatus(input: {
  courierIdOrOnboardingId: string;
  actorId?: string | undefined;
  status: CourierPartnerOnboardingStatus;
  note?: string | undefined;
}, client: Db = prisma) {
  const current = await client.courierPartnerOnboarding.findFirst({
    where: {
      OR: [
        { id: input.courierIdOrOnboardingId },
        { courierId: input.courierIdOrOnboardingId },
        { courier: { is: { code: normalizeCode(input.courierIdOrOnboardingId) } } }
      ]
    },
    include: { courier: true }
  });

  if (!current) throw new HttpError(404, "COURIER_PARTNER_NOT_FOUND");

  if (input.status === CourierPartnerOnboardingStatus.LIVE) {
    const sandboxVerificationChecklist = await ensureSandboxVerificationChecklist(current.courierId, client);
    if (!isSandboxVerificationComplete(sandboxVerificationChecklist)) {
      throw new HttpError(409, "COURIER_SANDBOX_VERIFICATION_INCOMPLETE");
    }

    const activationReadiness = await getCourierActivationReadiness(current.courierId, client);
    if (!activationReadiness.ready) {
      await writeOnboardingAudit({
        client,
        onboardingId: current.id,
        courierId: current.courierId,
        actorType: "ADMIN",
        actorId: input.actorId,
        action: "COURIER_PARTNER_ACTIVATION_BLOCKED_TAX_COMPLIANCE",
        metadata: activationReadiness
      });
      throw new HttpError(409, activationReadiness.issues[0]?.code || "COURIER_PARTNER_ACTIVATION_TAX_COMPLIANCE_BLOCKED");
    }
  }

  const action = input.status === CourierPartnerOnboardingStatus.BLOCKED
    ? "COURIER_PARTNER_ONBOARDING_BLOCKED"
    : "COURIER_PARTNER_ONBOARDING_APPROVED";

  await runTransaction(client, async (tx) => {
    await tx.courierPartnerOnboarding.update({
      where: { id: current.id },
      data: {
        status: input.status,
        reviewedAt: new Date(),
        ...(input.status === CourierPartnerOnboardingStatus.BLOCKED ? { changeRequest: input.note || null } : {})
      }
    });

    if (input.status === CourierPartnerOnboardingStatus.BLOCKED) {
      await tx.courierPartner.update({
        where: { id: current.courierId },
        data: { active: false, apiMode: "manual" }
      });
    } else if (input.status === CourierPartnerOnboardingStatus.LIVE) {
      await tx.courierPartner.update({
        where: { id: current.courierId },
        data: { active: true, apiMode: "live" }
      });
    } else {
      await tx.courierPartner.update({
        where: { id: current.courierId },
        data: { active: true, apiMode: "manual" }
      });
    }

    await writeOnboardingAudit({
      client: tx,
      onboardingId: current.id,
      courierId: current.courierId,
      actorType: "ADMIN",
      actorId: input.actorId,
      action,
      metadata: {
        fromStatus: current.status,
        toStatus: input.status,
        note: input.note || null,
        activationChanged: input.status === CourierPartnerOnboardingStatus.LIVE || input.status === CourierPartnerOnboardingStatus.BLOCKED
      }
    });
  });

  return getAdminCourierPartner(current.courierId, client);
}

export async function reopenAdminCourierPartner(input: {
  courierIdOrOnboardingId: string;
  actorId?: string | undefined;
  reason: string;
}, client: Db = prisma) {
  const current = await client.courierPartnerOnboarding.findFirst({
    where: {
      OR: [
        { id: input.courierIdOrOnboardingId },
        { courierId: input.courierIdOrOnboardingId }
      ]
    }
  });

  if (!current) throw new HttpError(404, "COURIER_PARTNER_NOT_FOUND");

  await runTransaction(client, async (tx) => {
    await tx.courierPartnerOnboarding.update({
      where: { id: current.id },
      data: {
        status: CourierPartnerOnboardingStatus.REOPENED,
        changeRequest: input.reason
      }
    });
    await tx.courierPartner.update({
      where: { id: current.courierId },
      data: { active: true, apiMode: "manual" }
    });

    await writeOnboardingAudit({
      client: tx,
      onboardingId: current.id,
      courierId: current.courierId,
      actorType: "ADMIN",
      actorId: input.actorId,
      action: "COURIER_PARTNER_ONBOARDING_REOPENED",
      metadata: {
        fromStatus: current.status,
        toStatus: CourierPartnerOnboardingStatus.REOPENED,
        reason: input.reason
      }
    });
  });

  return getAdminCourierPartner(current.courierId, client);
}
