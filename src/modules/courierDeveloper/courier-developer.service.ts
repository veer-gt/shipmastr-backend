import { Prisma } from "@prisma/client";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../audit/audit.service.js";
import {
  decryptSecretValue,
  encryptSecretValue,
  maskSecretValue,
  redactSecrets
} from "../courierPartnerOnboarding/onboarding.service.js";

type Db = Prisma.TransactionClient | typeof prisma;

export const COURIER_DEVELOPER_CREDENTIAL_TYPES = {
  API_KEY: "API_KEY",
  SIGNING_SECRET: "SIGNING_SECRET"
} as const;

export const COURIER_DEVELOPER_CREDENTIAL_ENVIRONMENT = "sandbox";

const credentialIssuerRoles = new Set(["MASTER_ADMIN", "COURIER_MANAGER"]);

const defaultWebhookEvents = [
  "shipment.tracking.updated",
  "shipment.ndr.created",
  "shipment.rto.created",
  "cod.remittance.imported",
  "invoice.imported"
];

const statusMap: Record<string, string> = {
  pickup_scheduled: "pickup_scheduled",
  picked_up: "picked_up",
  in_transit: "in_transit",
  out_for_delivery: "out_for_delivery",
  delivered: "delivered",
  ndr: "ndr",
  rto: "rto_initiated",
  rto_initiated: "rto_initiated",
  rto_delivered: "rto_delivered",
  lost: "lost",
  cancelled: "cancelled",
  damaged: "damaged"
};

async function runTransaction<T>(
  client: Db,
  callback: (tx: Prisma.TransactionClient) => Promise<T>
) {
  if ("$transaction" in client && typeof (client as typeof prisma).$transaction === "function") {
    return (client as typeof prisma).$transaction(callback);
  }

  return callback(client as Prisma.TransactionClient);
}

function developerSecretRef(courierId: string, type: string, environment = COURIER_DEVELOPER_CREDENTIAL_ENVIRONMENT) {
  return [
    "courier-developer",
    courierId,
    environment,
    type.toLowerCase(),
    randomBytes(8).toString("hex")
  ].join("/");
}

function generatedSecret(type: string) {
  const value = randomBytes(24).toString("hex");
  if (type === COURIER_DEVELOPER_CREDENTIAL_TYPES.API_KEY) return `smc_${value}`;
  return `whsec_${value}`;
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function maskedCredentialMap(credentials: Array<{
  credentialType: string;
  environment?: string | null;
  maskedValue: string;
  status: string;
  updatedAt: Date;
}>) {
  const find = (type: string) => credentials.find((credential) => credential.credentialType === type);
  const apiKey = find(COURIER_DEVELOPER_CREDENTIAL_TYPES.API_KEY);
  const signingSecret = find(COURIER_DEVELOPER_CREDENTIAL_TYPES.SIGNING_SECRET);

  return {
    apiKey: apiKey ? {
      environment: apiKey.environment || COURIER_DEVELOPER_CREDENTIAL_ENVIRONMENT,
      maskedValue: apiKey.maskedValue,
      status: apiKey.status,
      updatedAt: apiKey.updatedAt
    } : null,
    signingSecret: signingSecret ? {
      environment: signingSecret.environment || COURIER_DEVELOPER_CREDENTIAL_ENVIRONMENT,
      maskedValue: signingSecret.maskedValue,
      status: signingSecret.status,
      updatedAt: signingSecret.updatedAt
    } : null
  };
}

function credentialStatus(credentials: Array<{ credentialType: string; status: string }>) {
  const apiKey = credentials.find((credential) => credential.credentialType === COURIER_DEVELOPER_CREDENTIAL_TYPES.API_KEY);
  const signingSecret = credentials.find((credential) => credential.credentialType === COURIER_DEVELOPER_CREDENTIAL_TYPES.SIGNING_SECRET);

  if (!apiKey && !signingSecret) return "not_issued";
  if (apiKey?.status === "ACTIVE" && signingSecret?.status === "ACTIVE") return "active";
  return "revoked";
}

export function assertCourierDeveloperCredentialIssuer(actorRole?: string | null) {
  if (!credentialIssuerRoles.has(String(actorRole || "").toUpperCase())) {
    throw new HttpError(403, "COURIER_DEVELOPER_CREDENTIAL_ADMIN_ONLY");
  }
}

function actorField(actorId?: string | undefined) {
  return actorId ? { actorId } : {};
}

function sanitizeWebhookConfig(config: {
  id: string;
  targetUrl: string;
  active: boolean;
  events: string[];
  signingMethod?: string | null;
  maskedSecret?: string | null;
  secret?: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: config.id,
    targetUrl: config.targetUrl,
    active: config.active,
    events: config.events,
    signingMethod: config.signingMethod || "HMAC_SHA256",
    maskedSecret: config.maskedSecret || (config.secret ? maskSecretValue(config.secret) : ""),
    createdAt: config.createdAt,
    updatedAt: config.updatedAt
  };
}

function normalizeStatus(value: string) {
  const normalized = value.trim().toLowerCase();
  return statusMap[normalized] || normalized;
}

function optionalDate(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function writeDeveloperCredential(input: {
  courierId: string;
  credentialType: string;
  environment?: string | undefined;
}, client: Db) {
  const environment = input.environment || COURIER_DEVELOPER_CREDENTIAL_ENVIRONMENT;
  const secret = generatedSecret(input.credentialType);
  const encrypted = encryptSecretValue(secret);
  const secretRef = developerSecretRef(input.courierId, input.credentialType, environment);
  const maskedValue = maskSecretValue(secret);

  await client.courierPartnerSecret.create({
    data: {
      courierId: input.courierId,
      secretRef,
      ...encrypted
    }
  });

  const data = {
    environment,
    maskedValue,
    secretRef,
    status: "ACTIVE"
  };

  const existing = await client.courierDeveloperCredential.findFirst({
    where: {
      courierId: input.courierId,
      environment,
      credentialType: input.credentialType
    }
  });

  const credential = existing
    ? await client.courierDeveloperCredential.update({
        where: { id: existing.id },
        data
      })
    : await client.courierDeveloperCredential.create({
        data: {
          courierId: input.courierId,
          credentialType: input.credentialType,
          ...data
        }
      });

  return { credential, rawSecret: secret, maskedValue };
}

async function readDeveloperCredentials(courierId: string, client: Db, environment = COURIER_DEVELOPER_CREDENTIAL_ENVIRONMENT) {
  return client.courierDeveloperCredential.findMany({
    where: { courierId, environment },
    orderBy: { updatedAt: "desc" }
  });
}

function adminCredentialPayload(credentials: Awaited<ReturnType<typeof readDeveloperCredentials>>) {
  return {
    environment: COURIER_DEVELOPER_CREDENTIAL_ENVIRONMENT,
    status: credentialStatus(credentials),
    credentials: maskedCredentialMap(credentials)
  };
}

export async function getAdminCourierDeveloperCredentials(input: {
  courierId: string;
}, client: Db = prisma) {
  const credentials = await readDeveloperCredentials(input.courierId, client);
  return adminCredentialPayload(credentials);
}

export async function issueCourierDeveloperCredentials(input: {
  courierId: string;
  actorId: string;
  actorRole?: string | null;
}, client: Db = prisma) {
  assertCourierDeveloperCredentialIssuer(input.actorRole);

  return runTransaction(client, async (tx) => {
    const existing = await readDeveloperCredentials(input.courierId, tx);
    if (existing.some((credential) => credential.status === "ACTIVE")) {
      throw new HttpError(409, "COURIER_DEVELOPER_CREDENTIALS_ALREADY_ACTIVE");
    }

    const apiKey = await writeDeveloperCredential({
      courierId: input.courierId,
      credentialType: COURIER_DEVELOPER_CREDENTIAL_TYPES.API_KEY
    }, tx);
    const signingSecret = await writeDeveloperCredential({
      courierId: input.courierId,
      credentialType: COURIER_DEVELOPER_CREDENTIAL_TYPES.SIGNING_SECRET
    }, tx);
    const credentials = await readDeveloperCredentials(input.courierId, tx);

    await audit({
      ...actorField(input.actorId),
      action: "COURIER_DEVELOPER_CREDENTIALS_ISSUED",
      entityType: "courier_partner",
      entityId: input.courierId,
      metadata: {
        courierId: input.courierId,
        environment: COURIER_DEVELOPER_CREDENTIAL_ENVIRONMENT,
        credentialTypes: Object.values(COURIER_DEVELOPER_CREDENTIAL_TYPES),
        maskedApiKey: apiKey.maskedValue,
        maskedSigningSecret: signingSecret.maskedValue
      }
    }, tx).catch(() => undefined);

    return {
      ...adminCredentialPayload(credentials),
      oneTimeSecrets: {
        apiKey: apiKey.rawSecret,
        signingSecret: signingSecret.rawSecret
      }
    };
  });
}

async function rotateCourierDeveloperCredential(input: {
  courierId: string;
  actorId: string;
  actorRole?: string | null;
  credentialType: string;
  auditAction: string;
}, client: Db = prisma) {
  assertCourierDeveloperCredentialIssuer(input.actorRole);

  return runTransaction(client, async (tx) => {
    const rotated = await writeDeveloperCredential({
      courierId: input.courierId,
      credentialType: input.credentialType
    }, tx);
    const credentials = await readDeveloperCredentials(input.courierId, tx);

    await audit({
      ...actorField(input.actorId),
      action: input.auditAction,
      entityType: "courier_partner",
      entityId: input.courierId,
      metadata: {
        courierId: input.courierId,
        environment: COURIER_DEVELOPER_CREDENTIAL_ENVIRONMENT,
        credentialType: input.credentialType,
        maskedValue: rotated.maskedValue,
        secretRefRotated: true
      }
    }, tx).catch(() => undefined);

    return {
      ...adminCredentialPayload(credentials),
      oneTimeSecrets: input.credentialType === COURIER_DEVELOPER_CREDENTIAL_TYPES.API_KEY
        ? { apiKey: rotated.rawSecret }
        : { signingSecret: rotated.rawSecret }
    };
  });
}

export async function rotateCourierDeveloperApiKey(input: {
  courierId: string;
  actorId: string;
  actorRole?: string | null;
}, client: Db = prisma) {
  return rotateCourierDeveloperCredential({
    ...input,
    credentialType: COURIER_DEVELOPER_CREDENTIAL_TYPES.API_KEY,
    auditAction: "COURIER_DEVELOPER_API_KEY_ROTATED"
  }, client);
}

export async function rotateCourierDeveloperSigningSecret(input: {
  courierId: string;
  actorId: string;
  actorRole?: string | null;
}, client: Db = prisma) {
  return rotateCourierDeveloperCredential({
    ...input,
    credentialType: COURIER_DEVELOPER_CREDENTIAL_TYPES.SIGNING_SECRET,
    auditAction: "COURIER_DEVELOPER_SIGNING_SECRET_ROTATED"
  }, client);
}

export async function revokeCourierDeveloperCredentials(input: {
  courierId: string;
  actorId: string;
  actorRole?: string | null;
}, client: Db = prisma) {
  assertCourierDeveloperCredentialIssuer(input.actorRole);

  return runTransaction(client, async (tx) => {
    const existing = await readDeveloperCredentials(input.courierId, tx);
    for (const credential of existing) {
      await tx.courierDeveloperCredential.update({
        where: { id: credential.id },
        data: { status: "REVOKED" }
      });
    }

    const credentials = await readDeveloperCredentials(input.courierId, tx);

    await audit({
      ...actorField(input.actorId),
      action: "COURIER_DEVELOPER_CREDENTIALS_REVOKED",
      entityType: "courier_partner",
      entityId: input.courierId,
      metadata: {
        courierId: input.courierId,
        environment: COURIER_DEVELOPER_CREDENTIAL_ENVIRONMENT,
        revokedCount: existing.length
      }
    }, tx).catch(() => undefined);

    return adminCredentialPayload(credentials);
  });
}

export async function getCourierDeveloperProfile(input: {
  courierId: string;
  actorId?: string | undefined;
}, client: Db = prisma) {
  const courier = await client.courierPartner.findUnique({
    where: { id: input.courierId },
    include: {
      rateCards: { select: { id: true }, take: 1 },
      serviceablePincodes: { where: { active: true }, select: { id: true }, take: 1 },
      gstinRecords: {
        where: { verificationStatus: "VERIFIED" },
        select: { id: true, registeredState: true },
        take: 5
      },
      operationalLocations: {
        where: { status: "APPROVED" },
        select: { id: true, state: true, linkedGstinId: true },
        take: 5
      },
      sandboxVerificationChecklist: {
        orderBy: { itemKey: "asc" }
      },
      pilotChecklist: {
        orderBy: { itemKey: "asc" }
      },
      webhookConfigs: {
        orderBy: { updatedAt: "desc" },
        take: 1
      }
    }
  });

  if (!courier?.active) throw new HttpError(403, "COURIER_DEVELOPER_ACCESS_DISABLED");

  const credentials = await readDeveloperCredentials(input.courierId, client);
  await audit({
    ...actorField(input.actorId),
    action: "COURIER_DEVELOPER_PROFILE_VIEWED",
    entityType: "courier_partner",
    entityId: courier.id,
    metadata: {
      courierId: courier.id,
      credentialTypes: credentials.map((credential) => credential.credentialType)
    }
  }, client).catch(() => undefined);

  return {
    courier: {
      id: courier.id,
      name: courier.name,
      code: courier.code,
      active: courier.active,
      apiMode: courier.apiMode,
      bookingMode: courier.bookingMode,
      manualBookingSupported: courier.bookingMode === "manual" || courier.apiMode === "manual"
    },
    credentials: maskedCredentialMap(credentials),
    readiness: {
      verifiedGstinExists: courier.gstinRecords.length > 0,
      approvedOfficeExists: courier.operationalLocations.length > 0,
      rateCardExists: courier.rateCards.length > 0,
      serviceablePincodesExist: courier.serviceablePincodes.length > 0,
      bookingModeSelected: Boolean(courier.bookingMode),
      sandboxChecklist: courier.sandboxVerificationChecklist,
      pilotChecklist: courier.pilotChecklist
    },
    webhookConfig: courier.webhookConfigs[0] ? sanitizeWebhookConfig(courier.webhookConfigs[0]) : null,
    docs: {
      postmanCollectionStatus: "PLACEHOLDER",
      baseUrl: "/v1/courier",
      authentication: "Use the issued courier API key and HMAC-SHA256 request signature. Raw secrets are not shown after creation."
    }
  };
}

export async function getCourierWebhookConfig(input: {
  courierId: string;
  actorId?: string | undefined;
}, client: Db = prisma) {
  const configs = await client.courierWebhookConfig.findMany({
    where: { courierId: input.courierId },
    orderBy: { updatedAt: "desc" }
  });

  await audit({
    ...actorField(input.actorId),
    action: "COURIER_WEBHOOK_CONFIG_VIEWED",
    entityType: "courier_partner",
    entityId: input.courierId,
    metadata: { courierId: input.courierId }
  }, client).catch(() => undefined);

  return {
    docs: {
      authentication: "Shipmastr signs webhook payloads with HMAC-SHA256. Shared secrets remain masked in the portal.",
      events: defaultWebhookEvents
    },
    configs: configs.map(sanitizeWebhookConfig)
  };
}

export async function upsertCourierWebhookConfig(input: {
  courierId: string;
  actorId?: string | undefined;
  targetUrl: string;
  active: boolean;
  events: string[];
}, client: Db = prisma) {
  return runTransaction(client, async (tx) => {
    const existing = await tx.courierWebhookConfig.findFirst({
      where: { courierId: input.courierId },
      orderBy: { updatedAt: "desc" }
    });

    let secretRef = existing?.secretRef || null;
    let maskedSecret = existing?.maskedSecret || null;
    if (!secretRef || !maskedSecret) {
      const rawSecret = generatedSecret(COURIER_DEVELOPER_CREDENTIAL_TYPES.SIGNING_SECRET);
      secretRef = developerSecretRef(input.courierId, "webhook-signing");
      maskedSecret = maskSecretValue(rawSecret);
      await tx.courierPartnerSecret.create({
        data: {
          courierId: input.courierId,
          secretRef,
          ...encryptSecretValue(rawSecret)
        }
      });
    }

    const data = {
      targetUrl: input.targetUrl,
      active: input.active,
      events: input.events.length ? input.events : defaultWebhookEvents,
      signingMethod: "HMAC_SHA256",
      secret: maskedSecret,
      secretRef,
      maskedSecret
    };

    const config = existing
      ? await tx.courierWebhookConfig.update({ where: { id: existing.id }, data })
      : await tx.courierWebhookConfig.create({
          data: {
            courierId: input.courierId,
            ...data
          }
        });

    await audit({
      ...actorField(input.actorId),
      action: existing ? "COURIER_WEBHOOK_CONFIG_UPDATED" : "COURIER_WEBHOOK_CONFIG_CREATED",
      entityType: "courier_webhook_config",
      entityId: config.id,
      metadata: {
        courierId: input.courierId,
        targetUrl: input.targetUrl,
        events: data.events,
        secret: "[redacted]"
      }
    }, tx).catch(() => undefined);

    return { config: sanitizeWebhookConfig(config) };
  });
}

export async function listCourierApiEvents(input: {
  courierId: string;
}, client: Db = prisma) {
  const events = await client.courierApiEvent.findMany({
    where: { courierId: input.courierId },
    orderBy: { createdAt: "desc" },
    take: 50
  });

  return {
    events: events.map((event) => ({
      id: event.id,
      eventType: event.eventType,
      externalEventId: event.externalEventId,
      status: event.status,
      signatureValid: event.signatureValid,
      error: event.error,
      createdAt: event.createdAt,
      courierShipmentId: event.courierShipmentId
    }))
  };
}

async function secretForRef(secretRef: string, client: Db) {
  const secret = await client.courierPartnerSecret.findUnique({ where: { secretRef } });
  if (!secret) return null;
  return decryptSecretValue(secret);
}

async function findCourierByApiKey(apiKey: string, client: Db) {
  const credentials = await client.courierDeveloperCredential.findMany({
    where: {
      credentialType: COURIER_DEVELOPER_CREDENTIAL_TYPES.API_KEY,
      status: "ACTIVE"
    },
    include: { courier: true }
  });

  for (const credential of credentials) {
    const raw = await secretForRef(credential.secretRef, client);
    if (raw && safeEqual(apiKey, raw)) return credential;
  }

  return null;
}

function verifySignature(rawBody: Buffer, signature: string, secret: string) {
  const received = signature.replace(/^sha256=/i, "");
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");

  try {
    return timingSafeEqual(Buffer.from(received, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

export async function authenticateInboundCourierSignature(input: {
  apiKey?: string | undefined;
  signature?: string | undefined;
  rawBody: Buffer;
}, client: Db = prisma) {
  const apiKey = input.apiKey?.trim();
  if (!apiKey) {
    return { ok: false as const, error: "COURIER_API_KEY_REQUIRED" };
  }

  const credential = await findCourierByApiKey(apiKey, client);
  if (!credential) {
    return { ok: false as const, error: "INVALID_COURIER_API_KEY" };
  }

  if (!credential.courier.active) {
    return {
      ok: false as const,
      error: "COURIER_DEVELOPER_ACCESS_DISABLED",
      courierId: credential.courierId
    };
  }

  const signingCredential = await client.courierDeveloperCredential.findFirst({
    where: {
      courierId: credential.courierId,
      credentialType: COURIER_DEVELOPER_CREDENTIAL_TYPES.SIGNING_SECRET,
      status: "ACTIVE"
    }
  });
  if (!signingCredential) {
    return { ok: false as const, error: "COURIER_SIGNING_SECRET_NOT_CONFIGURED", courierId: credential.courierId };
  }

  const signingSecret = await secretForRef(signingCredential.secretRef, client);
  if (!signingSecret || !input.signature || !verifySignature(input.rawBody, input.signature, signingSecret)) {
    return { ok: false as const, error: "INVALID_COURIER_SIGNATURE", courierId: credential.courierId };
  }

  return {
    ok: true as const,
    courierId: credential.courierId,
    credentialId: credential.id
  };
}

export async function recordRejectedCourierApiEvent(input: {
  courierId?: string | undefined;
  eventType: string;
  error: string;
  rawPayload?: unknown | undefined;
}, client: Db = prisma) {
  if (!input.courierId) {
    await audit({
      action: "COURIER_API_EVENT_REJECTED",
      entityType: "courier_api_event",
      metadata: {
        eventType: input.eventType,
        error: input.error
      }
    }, client).catch(() => undefined);
    return null;
  }

  const event = await client.courierApiEvent.create({
    data: {
      courierId: input.courierId,
      eventType: input.eventType,
      status: "REJECTED",
      signatureValid: false,
      error: input.error,
      rawPayload: redactSecrets(input.rawPayload || {}) as Prisma.InputJsonValue
    }
  });

  await audit({
    action: "COURIER_API_EVENT_REJECTED",
    entityType: "courier_api_event",
    entityId: event.id,
    metadata: {
      courierId: input.courierId,
      eventType: input.eventType,
      error: input.error
    }
  }, client).catch(() => undefined);

  return event;
}

export async function ingestCourierApiEvent(input: {
  courierId: string;
  shipmentId: string;
  eventType: "tracking" | "ndr" | "rto";
  payload: Record<string, unknown>;
}, client: Db = prisma) {
  const shipment = await client.courierShipment.findFirst({
    where: {
      courierId: input.courierId,
      OR: [
        { id: input.shipmentId },
        { awbNumber: input.shipmentId }
      ]
    }
  });

  if (!shipment) throw new HttpError(404, "COURIER_SHIPMENT_NOT_FOUND");

  const externalEventId = typeof input.payload.eventId === "string" ? input.payload.eventId : undefined;
  const remarks = String(input.payload.remarks || input.payload.description || input.payload.reason || `${input.eventType} event received`);
  const location = typeof input.payload.location === "string" ? input.payload.location : undefined;
  const rawPayload = redactSecrets(input.payload) as Prisma.InputJsonValue;

  return runTransaction(client, async (tx) => {
    const eventRecord = await tx.courierApiEvent.create({
      data: {
        courierId: input.courierId,
        courierShipmentId: shipment.id,
        eventType: input.eventType,
        externalEventId: externalEventId || null,
        status: "ACCEPTED",
        signatureValid: true,
        rawPayload
      }
    });

    if (input.eventType === "ndr") {
      await tx.courierNdr.upsert({
        where: { courierShipmentId: shipment.id },
        update: {
          reason: String(input.payload.reason || remarks),
          actionRequired: String(input.payload.actionRequired || "Courier NDR action required"),
          nextAttemptDate: optionalDate(typeof input.payload.nextAttemptDate === "string" ? input.payload.nextAttemptDate : null),
          remarks,
          status: "open"
        },
        create: {
          courierShipmentId: shipment.id,
          courierId: input.courierId,
          reason: String(input.payload.reason || remarks),
          actionRequired: String(input.payload.actionRequired || "Courier NDR action required"),
          nextAttemptDate: optionalDate(typeof input.payload.nextAttemptDate === "string" ? input.payload.nextAttemptDate : null),
          remarks
        }
      });
    }

    if (input.eventType === "rto") {
      await tx.courierRto.upsert({
        where: { courierShipmentId: shipment.id },
        update: {
          rtoStatus: String(input.payload.rtoStatus || "rto_initiated"),
          reason: String(input.payload.reason || remarks),
          expectedReturnDate: optionalDate(typeof input.payload.expectedReturnDate === "string" ? input.payload.expectedReturnDate : null),
          remarks
        },
        create: {
          courierShipmentId: shipment.id,
          courierId: input.courierId,
          rtoStatus: String(input.payload.rtoStatus || "rto_initiated"),
          reason: String(input.payload.reason || remarks),
          expectedReturnDate: optionalDate(typeof input.payload.expectedReturnDate === "string" ? input.payload.expectedReturnDate : null),
          remarks
        }
      });
    }

    const nextStatus = input.eventType === "ndr"
      ? "ndr"
      : input.eventType === "rto"
        ? normalizeStatus(String(input.payload.rtoStatus || "rto_initiated"))
        : normalizeStatus(String(input.payload.status || shipment.status));

    const updatedShipment = await tx.courierShipment.update({
      where: { id: shipment.id },
      data: {
        status: nextStatus,
        lastEvent: remarks,
        events: {
          create: {
            courierId: input.courierId,
            eventType: `api_${input.eventType}`,
            status: nextStatus,
            location: location || null,
            remarks,
            rawPayload
          }
        }
      }
    });

    await audit({
      action: "COURIER_API_EVENT_INGESTED",
      entityType: "courier_api_event",
      entityId: eventRecord.id,
      metadata: {
        courierId: input.courierId,
        shipmentId: shipment.id,
        awbNumber: shipment.awbNumber,
        eventType: input.eventType,
        status: nextStatus,
        externalEventId
      }
    }, tx).catch(() => undefined);

    return {
      event: {
        id: eventRecord.id,
        eventType: eventRecord.eventType,
        status: eventRecord.status,
        signatureValid: eventRecord.signatureValid,
        createdAt: eventRecord.createdAt
      },
      shipment: updatedShipment
    };
  });
}
