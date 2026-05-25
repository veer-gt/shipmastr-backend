import { DomainProvider, DomainProvisioningStatus, DomainStatus, Prisma } from "@prisma/client";
import { Router, type Response } from "express";
import { z } from "zod";
import {
  connectExistingDomain,
  createDomainPurchaseIntent,
  getAdminDomainDiagnostics,
  getMerchantDomain,
  listAdminDomains,
  listMerchantDomains,
  recordDomainProvisioningEvent,
  requestMerchantDomainActivation,
  searchMerchantDomain,
  startDomainRegistration
} from "./domains.service.js";
import {
  getMerchantDomainPollingStatus,
  pollAndPersistAdminDomainStatus
} from "./domain-status-polling.service.js";
import {
  approveAdminDomainRequest,
  checkAdminDomainActivationStatus,
  getAdminDomainDnsInstructions,
  getAdminDomainActivationOverview,
  linkAdminDomainStorefront,
  rejectAdminDomainRequest,
  reviewAdminDomainRequest,
  startAdminDomainProviderSetup
} from "./domain-activation.service.js";
import {
  fetchCloudflareValidationRecordsForAdmin,
  runCloudflareCustomHostnameAdminAction,
  runCloudflareWorkerRouteAdminAction
} from "./domain-cloudflare-admin.service.js";
import { checkResellerClubDomainAvailability } from "./resellerclub-availability.service.js";

export const merchantDomainsRouter = Router();
export const domainStatusRouter = Router();
export const internalDomainProvisioningRouter = Router();
export const adminDomainsRouter = Router();

function sendNoStoreJson(res: Response, body: unknown) {
  res.set({
    "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0"
  });
  res.json(body);
}

const domainBodySchema = z.object({
  domain: z.string().trim().min(1).max(253),
  storefrontId: z.string().trim().min(1).max(120).optional().nullable()
}).strict();

const merchantDomainRequestSchema = z.object({
  domain: z.string().trim().min(1).max(253),
  storefrontId: z.string().trim().min(1).max(120).optional().nullable(),
  intent: z.enum(["CONNECT_EXISTING_DOMAIN", "BUY_NEW_DOMAIN"]),
  note: z.string().trim().max(500).optional().nullable()
}).strict();

const provisioningEventSchema = z.object({
  merchantId: z.string().trim().min(1).optional().nullable(),
  storefrontId: z.string().trim().min(1).max(120).optional().nullable(),
  merchantDomainId: z.string().trim().min(1).optional().nullable(),
  domain: z.string().trim().min(1).max(253).optional().nullable(),
  provider: z.nativeEnum(DomainProvider),
  eventType: z.string().trim().min(1).max(160),
  status: z.nativeEnum(DomainStatus),
  eventStatus: z.nativeEnum(DomainProvisioningStatus).optional(),
  safeMessage: z.string().trim().max(500).optional(),
  internalError: z.string().trim().max(2000).optional(),
  providerReferenceId: z.string().trim().max(200).optional(),
  resellerClubEntityId: z.string().trim().max(200).optional(),
  resellerClubOrderId: z.string().trim().max(200).optional(),
  cloudflareCustomHostnameId: z.string().trim().max(200).optional(),
  sslStatus: z.string().trim().max(120).optional(),
  validationRecords: z.unknown().optional(),
  expiresAt: z.coerce.date().optional(),
  requestPayload: z.unknown().optional(),
  responsePayload: z.unknown().optional(),
  idempotencyKey: z.string().trim().max(240).optional()
}).strict().refine((value) => value.merchantDomainId || value.domain, {
  message: "merchantDomainId or domain is required"
});

const startRegistrationSchema = z.object({
  merchantId: z.string().trim().min(1),
  merchantDomainId: z.string().trim().min(1),
  paymentReferenceId: z.string().trim().min(1).max(200),
  paymentVerified: z.literal(true),
  onboardingApproved: z.literal(true)
}).strict();

const adminAvailabilityCheckSchema = z.object({
  domain: z.string().trim().min(1).max(253),
  storefrontDomainId: z.string().trim().min(1).max(120).optional()
}).strict();

const adminLinkStorefrontSchema = z.object({
  domain: z.string().trim().min(1).max(253).optional(),
  storefrontId: z.string().trim().min(1).max(120),
  isPrimary: z.boolean().optional()
}).strict();

const adminDomainReviewSchema = z.object({
  note: z.string().trim().max(1000).optional().nullable()
}).strict();

const adminDomainRejectSchema = z.object({
  reason: z.string().trim().min(1).max(1000)
}).strict();

const dnsInstructionRecordSchema = z.object({
  type: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(253),
  value: z.string().trim().min(1).max(500),
  ttl: z.union([z.string().trim().max(80), z.number().int().positive()]).optional().nullable(),
  purpose: z.string().trim().max(200).optional().nullable()
}).strict();

const adminProviderSetupStartSchema = z.object({
  confirmDomain: z.string().trim().min(1).max(253),
  note: z.string().trim().max(1000).optional().nullable(),
  dnsInstructions: z.object({
    available: z.boolean().optional(),
    summary: z.string().trim().max(500).optional().nullable(),
    records: z.array(dnsInstructionRecordSchema).max(10).optional()
  }).strict().optional()
}).strict();

const adminCloudflareMutationSchema = z.object({
  confirmDomain: z.string().trim().min(1).max(253),
  dryRun: z.boolean().optional().default(true)
}).strict();

merchantDomainsRouter.get("/search", async (req, res) => {
  const query = z.object({ domain: z.string().trim().min(1).max(253) }).parse(req.query);
  const result = await searchMerchantDomain({
    userId: req.auth!.userId,
    merchantId: req.auth!.merchantId,
    domain: query.domain
  });
  sendNoStoreJson(res, result);
});

merchantDomainsRouter.post("/purchase-intent", async (req, res) => {
  const body = domainBodySchema.parse(req.body);
  const result = await createDomainPurchaseIntent({
    userId: req.auth!.userId,
    merchantId: req.auth!.merchantId,
    domain: body.domain,
    storefrontId: body.storefrontId
  });
  sendNoStoreJson(res, result);
});

merchantDomainsRouter.post("/connect-existing", async (req, res) => {
  const body = domainBodySchema.parse(req.body);
  const result = await connectExistingDomain({
    userId: req.auth!.userId,
    merchantId: req.auth!.merchantId,
    domain: body.domain,
    storefrontId: body.storefrontId
  });
  sendNoStoreJson(res, result);
});

merchantDomainsRouter.post("/request", async (req, res) => {
  const body = merchantDomainRequestSchema.parse(req.body);
  const result = await requestMerchantDomainActivation({
    userId: req.auth!.userId,
    merchantId: req.auth!.merchantId,
    domain: body.domain,
    storefrontId: body.storefrontId,
    intent: body.intent,
    note: body.note
  });
  sendNoStoreJson(res, result);
});

merchantDomainsRouter.get("/", async (req, res) => {
  const result = await listMerchantDomains({
    userId: req.auth!.userId,
    merchantId: req.auth!.merchantId
  });
  sendNoStoreJson(res, result);
});

merchantDomainsRouter.get("/:id", async (req, res) => {
  const result = await getMerchantDomain({
    userId: req.auth!.userId,
    merchantId: req.auth!.merchantId,
    id: req.params.id
  });
  sendNoStoreJson(res, result);
});

domainStatusRouter.get("/:domain/status", async (req, res) => {
  const result = await getMerchantDomainPollingStatus({
    userId: req.auth!.userId,
    merchantId: req.auth!.merchantId,
    domain: req.params.domain
  });
  sendNoStoreJson(res, result);
});

internalDomainProvisioningRouter.post("/domain-events", async (req, res) => {
  const body = provisioningEventSchema.parse(req.body);
  const result = await recordDomainProvisioningEvent({
    merchantId: body.merchantId,
    storefrontId: body.storefrontId,
    merchantDomainId: body.merchantDomainId,
    domain: body.domain,
    provider: body.provider,
    eventType: body.eventType,
    status: body.status,
    eventStatus: body.eventStatus,
    safeMessage: body.safeMessage,
    internalError: body.internalError,
    providerReferenceId: body.providerReferenceId,
    resellerClubEntityId: body.resellerClubEntityId,
    resellerClubOrderId: body.resellerClubOrderId,
    cloudflareCustomHostnameId: body.cloudflareCustomHostnameId,
    sslStatus: body.sslStatus,
    validationRecords: body.validationRecords as Prisma.InputJsonValue | undefined,
    expiresAt: body.expiresAt,
    requestPayload: body.requestPayload as Prisma.InputJsonValue | undefined,
    responsePayload: body.responsePayload as Prisma.InputJsonValue | undefined,
    idempotencyKey: body.idempotencyKey
  });
  sendNoStoreJson(res, result);
});

internalDomainProvisioningRouter.get("/domains/:domain/diagnostics", async (req, res) => {
  const result = await getAdminDomainDiagnostics({ domain: req.params.domain });
  sendNoStoreJson(res, result);
});

internalDomainProvisioningRouter.post("/start-domain-registration", async (req, res) => {
  const body = startRegistrationSchema.parse(req.body);
  const result = await startDomainRegistration(body);
  sendNoStoreJson(res, result);
});

adminDomainsRouter.get("/", async (req, res) => {
  const query = z.object({
    status: z.nativeEnum(DomainStatus).optional(),
    provider: z.nativeEnum(DomainProvider).optional(),
    merchantId: z.string().trim().min(1).optional()
  }).parse(req.query);
  const result = await listAdminDomains(query);
  sendNoStoreJson(res, result);
});

adminDomainsRouter.post("/check-availability", async (req, res) => {
  const body = adminAvailabilityCheckSchema.parse(req.body);
  const result = await checkResellerClubDomainAvailability({
    domain: body.domain,
    storefrontDomainId: body.storefrontDomainId
  });
  sendNoStoreJson(res, result);
});

adminDomainsRouter.get("/:domain/activation", async (req, res) => {
  const result = await getAdminDomainActivationOverview({ domain: req.params.domain });
  sendNoStoreJson(res, result);
});

adminDomainsRouter.post("/:domain/review", async (req, res) => {
  const body = adminDomainReviewSchema.parse(req.body);
  const result = await reviewAdminDomainRequest({
    domain: req.params.domain,
    actorId: req.auth?.userId,
    note: body.note
  });
  sendNoStoreJson(res, result);
});

adminDomainsRouter.post("/:domain/approve", async (req, res) => {
  const body = adminDomainReviewSchema.parse(req.body);
  const result = await approveAdminDomainRequest({
    domain: req.params.domain,
    actorId: req.auth?.userId,
    note: body.note
  });
  sendNoStoreJson(res, result);
});

adminDomainsRouter.post("/:domain/reject", async (req, res) => {
  const body = adminDomainRejectSchema.parse(req.body);
  const result = await rejectAdminDomainRequest({
    domain: req.params.domain,
    actorId: req.auth?.userId,
    reason: body.reason
  });
  sendNoStoreJson(res, result);
});

adminDomainsRouter.post("/:domain/start-provider-setup", async (req, res) => {
  const body = adminProviderSetupStartSchema.parse(req.body);
  const result = await startAdminDomainProviderSetup({
    domain: req.params.domain,
    confirmDomain: body.confirmDomain,
    actorId: req.auth?.userId,
    note: body.note,
    dnsInstructions: body.dnsInstructions as Prisma.InputJsonValue | undefined
  });
  sendNoStoreJson(res, result);
});

adminDomainsRouter.get("/:domain/dns-instructions", async (req, res) => {
  const result = await getAdminDomainDnsInstructions({ domain: req.params.domain });
  sendNoStoreJson(res, result);
});

adminDomainsRouter.post("/:domain/link-storefront", async (req, res) => {
  const body = adminLinkStorefrontSchema.parse(req.body);
  const result = await linkAdminDomainStorefront({
    pathDomain: req.params.domain,
    domain: body.domain,
    storefrontId: body.storefrontId,
    isPrimary: body.isPrimary
  });
  sendNoStoreJson(res, result);
});

adminDomainsRouter.post("/:domain/check-status", async (req, res) => {
  const result = await checkAdminDomainActivationStatus({
    domain: req.params.domain,
    actorId: req.auth?.userId
  });
  sendNoStoreJson(res, result);
});

adminDomainsRouter.post("/:domain/cloudflare/custom-hostname", async (req, res) => {
  const body = adminCloudflareMutationSchema.parse(req.body);
  const result = await runCloudflareCustomHostnameAdminAction({
    domain: req.params.domain,
    confirmDomain: body.confirmDomain,
    dryRun: body.dryRun
  });
  sendNoStoreJson(res, result);
});

adminDomainsRouter.get("/:domain/cloudflare/validation-records", async (req, res) => {
  const result = await fetchCloudflareValidationRecordsForAdmin({ domain: req.params.domain });
  sendNoStoreJson(res, result);
});

adminDomainsRouter.post("/:domain/cloudflare/worker-route", async (req, res) => {
  const body = adminCloudflareMutationSchema.parse(req.body);
  const result = await runCloudflareWorkerRouteAdminAction({
    domain: req.params.domain,
    confirmDomain: body.confirmDomain,
    dryRun: body.dryRun
  });
  sendNoStoreJson(res, result);
});

adminDomainsRouter.get("/:domain/diagnostics", async (req, res) => {
  const result = await getAdminDomainDiagnostics({ domain: req.params.domain });
  sendNoStoreJson(res, result);
});

adminDomainsRouter.post("/:domain/check-now", async (req, res) => {
  const result = await pollAndPersistAdminDomainStatus({ domain: req.params.domain });
  sendNoStoreJson(res, result);
});
