import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import {
  handleProviderDeliveryCallback,
  processQueuedBuyerCommunications
} from "../communication/communication-worker.service.js";
import { updateMerchantAutomationPolicy } from "../intelligence/action-policy.service.js";
import {
  type BuyerCommunicationCallbackInput,
  handleBuyerCommunicationCallback,
  listQueuedBuyerCommunications,
  sellerSafeCommunicationEvent,
  updateBuyerCommunicationStatus
} from "../intelligence/buyer-communication.service.js";
import {
  calculateAutopilotMetrics,
  connectMerchantEmailChannel,
  connectMerchantWhatsappChannel,
  dispatchAutomationEvent,
  disableMerchantChannel,
  emitAutomationEvent,
  AutomationCallbackError,
  ensureDefaultAutopilotRecords,
  getMerchantChannelReadiness,
  getMerchantAutomationContext,
  handleAutomationCallback,
  renderTemplate,
  runAbandonedCheckoutSmoke,
  runCodRemittanceSmoke,
  runCourierPickupDelaySmoke,
  runCourierSlaBreachSmoke,
  runCourierDailyDigestSmoke,
  runFakeScanReviewSmoke,
  runInvoiceMismatchSmoke,
  runSellerSettlementSmoke,
  runMerchantChannelTest,
  retryAutomationEvent,
  runMerchantDailyDigest,
  runRepeatBuyerSmoke,
  sendMerchantEmailVerification,
  setMerchantEmailFallback,
  verifyMerchantEmailChannel,
  verifyMerchantWhatsappChannel,
  verifyAutomationSignature
} from "./autopilot.service.js";

export const automationRouter = Router();
export const automationCallbacksRouter = Router();
export const automationCommunicationsRouter = Router();
export const internalAutomationRouter = Router();
export const adminAutomationRouter = Router();

const buyerCommunicationResponses = [
  "OTP_VERIFIED",
  "OTP_FAILED",
  "ADDRESS_CONFIRMED",
  "ADDRESS_CORRECTED",
  "PREPAID_CONVERTED",
  "BUYER_CONFIRMED_REATTEMPT",
  "BUYER_REFUSED",
  "NO_RESPONSE",
  "INVALID_RESPONSE"
] as const;

const communicationChannels = ["WHATSAPP", "SMS", "EMAIL", "CALL"] as const;
const communicationStatuses = ["QUEUED", "SENT", "DELIVERED", "READ", "RESPONDED", "FAILED", "EXPIRED"] as const;
const deliveryStatuses = ["SENT", "DELIVERED", "READ", "FAILED"] as const;
const workflowStatuses = ["ACTIVE", "PAUSED"] as const;
const campaignStatuses = ["DRAFT", "SCHEDULED", "RUNNING", "PAUSED", "COMPLETED"] as const;
const metadataSchema = z.record(z.string(), z.any());

const policyPatchSchema = z.object({
  autoCodControlEnabled: z.boolean().optional(),
  autoOtpForBronzeEnabled: z.boolean().optional(),
  autoPrepaidOnlyForIronEnabled: z.boolean().optional(),
  autoAddressCorrectionEnabled: z.boolean().optional(),
  autoCourierSelectionEnabled: z.boolean().optional(),
  autoNdrRecoveryEnabled: z.boolean().optional(),
  autoRtoHoldEnabled: z.boolean().optional(),
  autoCancelAfterFailedVerificationEnabled: z.boolean().optional(),
  maxAutoHoldOrderValue: z.number().nullable().optional(),
  maxAutoCourierCostIncrease: z.number().nullable().optional(),
  maxAutoCodAmount: z.number().nullable().optional(),
  allowPrepaidConversionMessage: z.boolean().optional(),
  allowBuyerWhatsappMessages: z.boolean().optional(),
  allowBuyerSmsMessages: z.boolean().optional(),
  communicationEnabled: z.boolean().optional(),
  dailyWhatsappLimit: z.number().int().min(0).nullable().optional(),
  dailySmsLimit: z.number().int().min(0).nullable().optional(),
  buyerMessageQuietHoursStart: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  buyerMessageQuietHoursEnd: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional()
});

const callbackSchema = z.object({
  orderId: z.string().min(1),
  phone: z.string().min(6).optional(),
  response: z.enum(buyerCommunicationResponses),
  providerMessageId: z.string().min(1).optional(),
  metadata: metadataSchema.optional()
});

const preferencePatchSchema = z.object({
  autopilotEnabled: z.boolean().optional(),
  notificationsEnabled: z.boolean().optional(),
  codShieldEnabled: z.boolean().optional(),
  ndrRescueEnabled: z.boolean().optional(),
  marketingEnabled: z.boolean().optional(),
  courierControlEnabled: z.boolean().optional(),
  financeControlEnabled: z.boolean().optional(),
  buyerIntelligenceEnabled: z.boolean().optional(),
  whatsappEnabled: z.boolean().optional(),
  smsEnabled: z.boolean().optional(),
  emailEnabled: z.boolean().optional(),
  quietHoursStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  quietHoursEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  timezone: z.string().min(1).optional(),
  dailyBuyerMessageCap: z.number().int().min(0).max(100).optional(),
  weeklyBuyerMessageCap: z.number().int().min(0).max(500).optional(),
  metadata: metadataSchema.optional()
});

const campaignCreateSchema = z.object({
  key: z.string().min(2).max(80),
  name: z.string().min(2).max(120),
  campaignType: z.enum([
    "abandoned_checkout",
    "repeat_buyer",
    "winback",
    "product_launch",
    "festive_sale",
    "review_request",
    "low_stock_urgency",
    "cod_to_prepaid_offer"
  ]),
  status: z.enum(campaignStatuses).optional(),
  audienceId: z.string().min(1).optional(),
  channelOrder: z.array(z.enum(communicationChannels)).min(1).optional(),
  templateKey: z.string().min(1).optional(),
  scheduleAt: z.coerce.date().optional(),
  budgetLimitPaise: z.number().int().min(0).optional(),
  settings: metadataSchema.optional()
});

const workflowPatchSchema = z.object({
  status: z.enum(workflowStatuses).optional(),
  channelOrder: z.array(z.enum(communicationChannels)).min(1).optional(),
  frequencyCap: z.number().int().min(0).nullable().optional(),
  retryLimit: z.number().int().min(0).max(10).optional(),
  quietHoursMode: z.enum(["respect", "ignore_internal_only"]).optional(),
  settings: metadataSchema.optional()
});

const emitEventSchema = z.object({
  merchantId: z.string().min(1),
  eventKey: z.string().min(3),
  source: z.string().min(1).optional(),
  sourceId: z.string().min(1).optional(),
  idempotencyKey: z.string().min(3).optional(),
  payload: metadataSchema.optional()
});

const emailConnectSchema = z.object({
  businessEmail: z.string().email()
});

const emailVerifySchema = z.object({
  verificationCode: z.string().min(4).max(12)
});

const emailFallbackSchema = z.object({
  fallbackAllowed: z.boolean()
});

const whatsappConnectSchema = z.object({
  businessNumber: z.string().min(6).max(24),
  templateStatuses: metadataSchema.optional()
});

const whatsappVerifySchema = z.object({
  verificationCode: z.string().min(4).max(12).optional()
});

const compactData = (value: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined));

const safeChannelCredential = (credential: {
  channel: string;
  provider: string;
  label: string;
  status: string;
  lastVerifiedAt: Date | null;
  metadata: unknown;
}) => {
  const metadata = metadataSchema.catch({}).parse(credential.metadata || {});
  const senderEmail = typeof metadata.senderEmail === "string" ? metadata.senderEmail : undefined;
  const businessEmail = typeof metadata.businessEmail === "string" ? metadata.businessEmail : senderEmail;
  const whatsappBusinessNumber = typeof metadata.whatsappBusinessNumber === "string" ? metadata.whatsappBusinessNumber : undefined;
  const maskPhone = (value?: string) => value ? `${"*".repeat(Math.max(value.length - 4, 4))}${value.slice(-4)}` : undefined;

  return compactData({
    channel: credential.channel,
    provider: credential.provider,
    label: credential.label,
    status: credential.status,
    lastVerifiedAt: credential.lastVerifiedAt,
    senderDomain: businessEmail?.includes("@") ? `*@${businessEmail.split("@").at(-1)}` : undefined,
    whatsappBusinessNumber: maskPhone(whatsappBusinessNumber),
    templateName: typeof metadata.templateName === "string" ? metadata.templateName : undefined
  });
};

const respondChannelError = (res: Response, error: unknown, status = 400) =>
  res.status(status).json({ error: error instanceof Error ? error.message : "CHANNEL_OPERATION_FAILED" });

function callbackBody(schema: z.ZodType, reqBody: unknown): BuyerCommunicationCallbackInput {
  const body = schema.parse(reqBody) as BuyerCommunicationCallbackInput;
  const input: BuyerCommunicationCallbackInput = {
    orderId: body.orderId,
    response: body.response
  };
  if (body.phone !== undefined) input.phone = body.phone;
  if (body.providerMessageId !== undefined) input.providerMessageId = body.providerMessageId;
  if (body.metadata !== undefined) input.metadata = body.metadata;
  return input;
}

function narrowedCallbackSchema(values: readonly [string, ...string[]]) {
  return callbackSchema.extend({
    response: z.enum(values)
  });
}

function verifySignedAutomationCallback(req: Request, res: Response) {
  const timestamp = req.header("x-shipmastr-timestamp");
  const signature = req.header("x-shipmastr-signature");
  const body = JSON.stringify(req.body ?? {});

  if (!verifyAutomationSignature({ body, timestamp, signature })) {
    res.status(401).json({ error: "INVALID_AUTOMATION_CALLBACK_SIGNATURE" });
    return false;
  }

  return true;
}

export function automationSmokeCallbackEventId(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.eventId === "string") return candidate.eventId;
  const event = candidate.event;
  if (event && typeof event === "object" && !Array.isArray(event)) {
    const eventRecord = event as Record<string, unknown>;
    if (typeof eventRecord.id === "string") return eventRecord.id;
  }
  return undefined;
}

export function containsAutomationSmokeOtpCodeField(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsAutomationSmokeOtpCodeField(item));

  return Object.entries(value as Record<string, unknown>).some(([key, fieldValue]) => {
    const normalizedKey = key.replace(/[_\-\s]/g, "").toLowerCase();
    if (["otp", "otpcode", "onetimepassword", "onetimepasscode", "passcode"].includes(normalizedKey)) {
      return true;
    }
    return containsAutomationSmokeOtpCodeField(fieldValue);
  });
}

const smokeCallbackSchema = z.object({
  synthetic: z.literal(true),
  eventId: z.string().min(1).optional(),
  event: z.object({
    id: z.string().min(1)
  }).optional(),
  status: z.enum(["PROCESSED", "FAILED"]).optional(),
  result: metadataSchema.optional(),
  communication: metadataSchema.optional()
}).passthrough();

export function validateAutomationSmokeCallbackBody(input: unknown) {
  const parsed = smokeCallbackSchema.safeParse(input ?? {});
  if (!parsed.success) {
    return { ok: false as const, status: 400, error: "INVALID_SMOKE_CALLBACK_BODY" };
  }

  const eventId = automationSmokeCallbackEventId(parsed.data);
  if (!eventId || !eventId.startsWith("SMOKE_")) {
    return { ok: false as const, status: 400, error: "INVALID_SMOKE_CALLBACK_EVENT_ID" };
  }

  if (containsAutomationSmokeOtpCodeField(parsed.data)) {
    return { ok: false as const, status: 400, error: "SMOKE_CALLBACK_OTP_CODE_REJECTED" };
  }

  return { ok: true as const, eventId };
}

automationRouter.get("/overview", async (req, res) => {
  const merchantId = req.auth!.merchantId;
  await ensureDefaultAutopilotRecords(merchantId);
  const [metrics, preference, workflows, recentLogs, recentEvents, campaigns, latestDigestEvent, latestDigestLog, channelCredentials] = await Promise.all([
    calculateAutopilotMetrics(merchantId),
    prisma.automationPreference.findUnique({ where: { merchantId } }),
    prisma.automationWorkflowSetting.findMany({
      where: { merchantId },
      orderBy: { key: "asc" }
    }),
    prisma.communicationLog.findMany({
      where: { merchantId },
      orderBy: { createdAt: "desc" },
      take: 8
    }),
    prisma.automationEvent.findMany({
      where: { merchantId },
      orderBy: { createdAt: "desc" },
      take: 8
    }),
    prisma.marketingCampaign.findMany({
      where: { merchantId },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: 8
    }),
    prisma.automationEvent.findFirst({
      where: { merchantId, eventKey: "merchant.daily_digest" },
      orderBy: { createdAt: "desc" }
    }),
    prisma.communicationLog.findFirst({
      where: { merchantId, templateKey: "merchant_daily_digest_v1" },
      orderBy: { createdAt: "desc" }
    }),
    prisma.merchantChannelCredential.findMany({
      where: {
        merchantId,
        channel: { in: ["EMAIL", "WHATSAPP"] }
      },
      select: {
        channel: true,
        provider: true,
        label: true,
        status: true,
        lastVerifiedAt: true,
        metadata: true
      },
      orderBy: [{ channel: "asc" }, { updatedAt: "desc" }]
    })
  ]);

  res.json({
    metrics,
    preference,
    workflows,
    recentLogs,
    recentEvents,
    campaigns,
    channelCredentials: channelCredentials.map(safeChannelCredential),
    latestDigest: {
      event: latestDigestEvent,
      communication: latestDigestLog
    }
  });
});

automationRouter.get("/preferences", async (req, res) => {
  const merchantId = req.auth!.merchantId;
  const preference = await ensureDefaultAutopilotRecords(merchantId);

  res.json({ preference });
});

automationRouter.patch("/preferences", async (req, res) => {
  const body = preferencePatchSchema.parse(req.body);
  const merchantId = req.auth!.merchantId;
  const current = await prisma.automationPreference.upsert({
    where: { merchantId },
    create: { merchantId },
    update: {}
  });
  const currentMetadata = metadataSchema.catch({}).parse(current.metadata || {});
  const nextMetadata = {
    ...currentMetadata,
    ...(body.metadata || {})
  };
  const data = compactData({
    ...body,
    metadata: nextMetadata
  });

  if (nextMetadata.abandonedCheckoutEnabled === true || nextMetadata.repeatBuyerEnabled === true) {
    const readiness = await getMerchantChannelReadiness(merchantId, {
      ...current,
      ...data,
      metadata: nextMetadata as never
    });

    const blocked = nextMetadata.abandonedCheckoutEnabled === true && !readiness.abandonedCheckout.canEnable
      ? readiness.abandonedCheckout
      : nextMetadata.repeatBuyerEnabled === true && !readiness.repeatBuyer.canEnable
        ? readiness.repeatBuyer
        : null;

    if (blocked) {
      return res.status(422).json({
        error: "AUTOMATION_CHANNEL_NOT_READY",
        message: "Connect at least one channel to enable this automation.",
        readiness
      });
    }
  }

  const preference = await prisma.automationPreference.upsert({
    where: { merchantId },
    create: {
      merchantId,
      ...data
    } as never,
    update: data as never
  });

  await prisma.auditLog.create({
    data: {
      merchantId,
      actorId: req.auth!.userId,
      action: "automation.preferences.updated",
      entityType: "AutomationPreference",
      entityId: preference.id,
      metadata: data as never
    }
  });

  res.json({ preference });
});

automationRouter.get("/channel-readiness", async (req, res) => {
  const merchantId = req.auth!.merchantId;
  const readiness = await getMerchantChannelReadiness(merchantId);

  res.json(readiness);
});

automationRouter.post("/channels/email/connect", async (req, res) => {
  const merchantId = req.auth!.merchantId;
  const body = emailConnectSchema.parse(req.body);

  try {
    await connectMerchantEmailChannel({ merchantId, businessEmail: body.businessEmail });
    const readiness = await getMerchantChannelReadiness(merchantId);
    res.status(201).json({ ok: true, readiness });
  } catch (error) {
    respondChannelError(res, error);
  }
});

automationRouter.post("/channels/email/send-verification", async (req, res) => {
  const merchantId = req.auth!.merchantId;

  try {
    const result = await sendMerchantEmailVerification(merchantId);
    const readiness = await getMerchantChannelReadiness(merchantId);
    res.json({ ...result, readiness });
  } catch (error) {
    respondChannelError(res, error);
  }
});

automationRouter.post("/channels/email/verify", async (req, res) => {
  const merchantId = req.auth!.merchantId;
  const body = emailVerifySchema.parse(req.body);

  try {
    await verifyMerchantEmailChannel({ merchantId, verificationCode: body.verificationCode });
    const readiness = await getMerchantChannelReadiness(merchantId);
    res.json({ ok: true, readiness });
  } catch (error) {
    respondChannelError(res, error);
  }
});

automationRouter.post("/channels/email/test", async (req, res) => {
  const merchantId = req.auth!.merchantId;

  try {
    const result = await runMerchantChannelTest({ merchantId, channel: "EMAIL" });
    const readiness = await getMerchantChannelReadiness(merchantId);
    res.json({ ok: true, event: result.event, communication: result.communication, readiness });
  } catch (error) {
    respondChannelError(res, error);
  }
});

automationRouter.patch("/channels/email/fallback", async (req, res) => {
  const merchantId = req.auth!.merchantId;
  const body = emailFallbackSchema.parse(req.body);

  try {
    await setMerchantEmailFallback({ merchantId, fallbackAllowed: body.fallbackAllowed });
    const readiness = await getMerchantChannelReadiness(merchantId);
    res.json({ ok: true, readiness });
  } catch (error) {
    respondChannelError(res, error);
  }
});

automationRouter.post("/channels/email/disable", async (req, res) => {
  const merchantId = req.auth!.merchantId;

  try {
    const readiness = await disableMerchantChannel({ merchantId, channel: "EMAIL" });
    res.json({ ok: true, readiness });
  } catch (error) {
    respondChannelError(res, error);
  }
});

automationRouter.post("/channels/whatsapp/connect", async (req, res) => {
  const merchantId = req.auth!.merchantId;
  const body = whatsappConnectSchema.parse(req.body);

  try {
    await connectMerchantWhatsappChannel({
      merchantId,
      businessNumber: body.businessNumber,
      templateStatuses: body.templateStatuses as never
    });
    const readiness = await getMerchantChannelReadiness(merchantId);
    res.status(201).json({ ok: true, readiness });
  } catch (error) {
    respondChannelError(res, error);
  }
});

automationRouter.post("/channels/whatsapp/send-verification", async (req, res) => {
  const merchantId = req.auth!.merchantId;

  try {
    const readiness = await getMerchantChannelReadiness(merchantId);
    if (readiness.whatsapp.status === "NOT_CONNECTED") {
      return res.status(400).json({ error: "WHATSAPP_NOT_CONNECTED" });
    }
    res.json({
      ok: true,
      message: "WhatsApp verification is queued through the configured provider.",
      readiness
    });
  } catch (error) {
    respondChannelError(res, error);
  }
});

automationRouter.post("/channels/whatsapp/verify", async (req, res) => {
  const merchantId = req.auth!.merchantId;
  const body = whatsappVerifySchema.parse(req.body);

  try {
    await verifyMerchantWhatsappChannel({ merchantId, verificationCode: body.verificationCode });
    const readiness = await getMerchantChannelReadiness(merchantId);
    res.json({ ok: true, readiness });
  } catch (error) {
    respondChannelError(res, error);
  }
});

automationRouter.post("/channels/whatsapp/test", async (req, res) => {
  const merchantId = req.auth!.merchantId;

  try {
    const result = await runMerchantChannelTest({ merchantId, channel: "WHATSAPP" });
    const readiness = await getMerchantChannelReadiness(merchantId);
    res.json({ ok: true, event: result.event, communication: result.communication, readiness });
  } catch (error) {
    respondChannelError(res, error);
  }
});

automationRouter.get("/channels/whatsapp/templates", async (req, res) => {
  const merchantId = req.auth!.merchantId;
  const readiness = await getMerchantChannelReadiness(merchantId);

  res.json({ templateStatus: readiness.whatsapp.templateStatus });
});

automationRouter.post("/channels/whatsapp/disable", async (req, res) => {
  const merchantId = req.auth!.merchantId;

  try {
    const readiness = await disableMerchantChannel({ merchantId, channel: "WHATSAPP" });
    res.json({ ok: true, readiness });
  } catch (error) {
    respondChannelError(res, error);
  }
});

automationRouter.get("/logs", async (req, res) => {
  const merchantId = req.auth!.merchantId;
  const query = z.object({
    status: z.string().optional(),
    channel: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50)
  }).parse(req.query);

  const logs = await prisma.communicationLog.findMany({
    where: {
      merchantId,
      ...compactData({
        status: query.status,
        channel: query.channel
      })
    } as never,
    orderBy: { createdAt: "desc" },
    take: query.limit
  });

  res.json({ logs });
});

automationRouter.get("/campaigns", async (req, res) => {
  const merchantId = req.auth!.merchantId;
  await ensureDefaultAutopilotRecords(merchantId);
  const campaigns = await prisma.marketingCampaign.findMany({
    where: { merchantId },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }]
  });

  res.json({ campaigns });
});

automationRouter.post("/campaigns", async (req, res) => {
  const body = campaignCreateSchema.parse(req.body);
  const data = compactData(body);
  const merchantId = req.auth!.merchantId;
  const campaign = await prisma.marketingCampaign.create({
    data: {
      merchantId,
      ...data
    } as never
  });

  await emitAutomationEvent({
    merchantId,
    eventKey: "campaign.created",
    source: "merchant-dashboard",
    sourceId: campaign.id,
    idempotencyKey: `campaign.created:${campaign.id}`,
    payload: {
      campaignId: campaign.id,
      campaignType: campaign.campaignType,
      status: campaign.status
    }
  }).catch((error) =>
    prisma.auditLog.create({
      data: {
        merchantId,
        actorId: req.auth!.userId,
        action: "automation.campaign_emit_failed",
        entityType: "MarketingCampaign",
        entityId: campaign.id,
        metadata: { error: error instanceof Error ? error.message : "Unknown emit failure" }
      }
    })
  );

  res.status(201).json({ campaign });
});

automationRouter.get("/templates", async (req, res) => {
  const merchantId = req.auth!.merchantId;
  const templates = await prisma.automationTemplate.findMany({
    where: {
      OR: [{ merchantId }, { merchantId: null }]
    },
    orderBy: [{ key: "asc" }, { channel: "asc" }]
  });

  res.json({ templates });
});

automationRouter.patch("/workflows/:key", async (req, res) => {
  const params = z.object({ key: z.string().min(2).max(120) }).parse(req.params);
  const body = workflowPatchSchema.parse(req.body);
  const data = compactData(body);
  const merchantId = req.auth!.merchantId;
  const workflow = await prisma.automationWorkflowSetting.upsert({
    where: {
      merchantId_key: {
        merchantId,
        key: params.key
      }
    },
    create: {
      merchantId,
      key: params.key,
      ...data
    } as never,
    update: data as never
  });

  await prisma.auditLog.create({
    data: {
      merchantId,
      actorId: req.auth!.userId,
      action: "automation.workflow.updated",
      entityType: "AutomationWorkflowSetting",
      entityId: workflow.id,
      metadata: { key: params.key, ...data }
    }
  });

  res.json({ workflow });
});

internalAutomationRouter.post("/dispatch", async (req, res) => {
  const body = z.object({
    eventId: z.string().min(1).optional(),
    event: emitEventSchema.optional()
  }).parse(req.body);

  const event = body.eventId
    ? await prisma.automationEvent.findUnique({ where: { id: body.eventId } })
    : body.event
      ? await emitAutomationEvent(compactData(body.event) as never)
      : null;

  if (!event) {
    return res.status(404).json({ error: "AUTOMATION_EVENT_NOT_FOUND" });
  }

  const dispatched = await dispatchAutomationEvent(event.id);

  res.json({ event: dispatched });
});

internalAutomationRouter.post("/daily-digest/run", async (req, res) => {
  const body = z.object({
    merchantId: z.string().min(1).optional(),
    digestDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100)
  }).parse(req.body ?? {});

  const merchants = body.merchantId
    ? [{ id: body.merchantId }]
    : await prisma.merchant.findMany({
      where: { email: { not: "" } },
      select: { id: true },
      take: body.limit,
      orderBy: { createdAt: "asc" }
    });

  const results = [];
  for (const merchant of merchants) {
    try {
      const result = await runMerchantDailyDigest({
        merchantId: merchant.id,
        digestDate: body.digestDate
      });
      results.push({
        merchantId: merchant.id,
        eventId: result.event.id,
        status: result.event.status,
        digestDate: result.summary.digestDate
      });
    } catch (error) {
      results.push({
        merchantId: merchant.id,
        status: "FAILED",
        error: error instanceof Error ? error.message : "UNKNOWN_DAILY_DIGEST_FAILURE"
      });
    }
  }

  res.json({
    ok: true,
    count: results.length,
    results
  });
});

internalAutomationRouter.post("/abandoned-checkout/smoke", async (req, res) => {
  const body = z.object({
    merchantId: z.string().min(1),
    mode: z.enum(["email_only", "whatsapp_only", "both", "fallback_email"]).default("both"),
    cartId: z.string().min(1).optional(),
    checkoutId: z.string().min(1).optional(),
    buyerName: z.string().min(1).optional(),
    buyerEmail: z.string().email().optional(),
    buyerPhone: z.string().min(6).optional(),
    recoveryUrl: z.string().url().optional(),
    cartValuePaise: z.number().int().min(0).optional(),
    itemCount: z.number().int().min(0).optional(),
    recoveryWindowMinutes: z.number().int().min(15).max(24 * 60).optional()
  }).parse(req.body ?? {});

  const result = await runAbandonedCheckoutSmoke(body);

  res.json({
    ok: true,
    mode: result.mode,
    merchantId: result.merchant.id,
    event: result.event
  });
});

internalAutomationRouter.post("/repeat-buyer/smoke", async (req, res) => {
  const body = z.object({
    merchantId: z.string().min(1),
    mode: z.enum(["email_only", "whatsapp_only", "both", "fallback_email"]).default("both"),
    buyerId: z.string().min(1).optional(),
    buyerName: z.string().min(1).optional(),
    buyerEmail: z.string().email().optional(),
    buyerPhone: z.string().min(6).optional(),
    lastOrderId: z.string().min(1).optional(),
    lastOrderDate: z.string().min(1).optional(),
    daysSinceLastOrder: z.number().int().min(0).optional(),
    storeUrl: z.string().url().optional(),
    recommendedOffer: z.string().min(1).optional()
  }).parse(req.body ?? {});

  const result = await runRepeatBuyerSmoke(body);

  res.json({
    ok: true,
    mode: result.mode,
    merchantId: result.merchant.id,
    event: result.event
  });
});

internalAutomationRouter.post("/cod-remittance/smoke", async (req, res) => {
  const body = z.object({
    merchantId: z.string().min(1),
    alertType: z.enum(["due", "delayed", "settled", "mismatch"]).default("due"),
    mode: z.enum(["due", "delayed", "settled", "mismatch", "email_only", "whatsapp_only", "both", "admin_escalation"]).default("email_only"),
    remittanceId: z.string().min(1).optional(),
    courierPartnerId: z.string().min(1).optional(),
    courierPartnerName: z.string().min(1).optional(),
    settlementDate: z.string().min(1).optional(),
    dueDate: z.string().min(1).optional(),
    codAmountPaise: z.number().int().min(0).optional(),
    expectedAmountPaise: z.number().int().min(0).optional(),
    receivedAmountPaise: z.number().int().min(0).optional(),
    mismatchAmountPaise: z.number().int().min(0).optional(),
    shipmentCount: z.number().int().min(0).optional(),
    awbCount: z.number().int().min(0).optional(),
    financeSummaryUrl: z.string().url().optional()
  }).parse(req.body ?? {});
  const alertMode = ["due", "delayed", "settled", "mismatch"].includes(body.mode) ? body.mode : body.alertType;
  const channelMode = ["email_only", "whatsapp_only", "both", "admin_escalation"].includes(body.mode)
    ? body.mode as "email_only" | "whatsapp_only" | "both" | "admin_escalation"
    : "email_only";
  const result = await runCodRemittanceSmoke({
    ...body,
    alertType: alertMode as "due" | "delayed" | "settled" | "mismatch",
    mode: channelMode
  });

  res.json({
    ok: true,
    alertType: result.alertType,
    mode: result.mode,
    merchantId: result.merchant.id,
    event: result.event
  });
});

internalAutomationRouter.post("/seller-settlement/smoke", async (req, res) => {
  const body = z.object({
    merchantId: z.string().min(1),
    alertType: z.enum(["generated", "scheduled", "paid", "held", "adjusted"]).default("generated"),
    mode: z.enum(["generated", "scheduled", "paid", "held", "adjusted", "email_only", "whatsapp_only", "both"]).default("email_only"),
    settlementId: z.string().min(1).optional(),
    settlementStatus: z.string().min(1).optional(),
    settlementDate: z.string().min(1).optional(),
    expectedPayoutDate: z.string().min(1).optional(),
    paidAt: z.string().min(1).optional(),
    grossCodAmountPaise: z.number().int().min(0).optional(),
    shippingChargesPaise: z.number().int().min(0).optional(),
    platformFeesPaise: z.number().int().min(0).optional(),
    adjustmentAmountPaise: z.number().int().min(0).optional(),
    holdAmountPaise: z.number().int().min(0).optional(),
    disputeAmountPaise: z.number().int().min(0).optional(),
    netPayableAmountPaise: z.number().int().min(0).optional(),
    shipmentCount: z.number().int().min(0).optional(),
    awbCount: z.number().int().min(0).optional(),
    statementUrl: z.string().url().optional()
  }).parse(req.body ?? {});
  const alertMode = ["generated", "scheduled", "paid", "held", "adjusted"].includes(body.mode) ? body.mode : body.alertType;
  const channelMode = ["email_only", "whatsapp_only", "both"].includes(body.mode)
    ? body.mode as "email_only" | "whatsapp_only" | "both"
    : "email_only";
  const result = await runSellerSettlementSmoke({
    ...body,
    alertType: alertMode as "generated" | "scheduled" | "paid" | "held" | "adjusted",
    mode: channelMode
  });

  res.json({
    ok: true,
    alertType: result.alertType,
    mode: result.mode,
    merchantId: result.merchant.id,
    event: result.event
  });
});

internalAutomationRouter.post("/invoice-mismatch/smoke", async (req, res) => {
  const body = z.object({
    merchantId: z.string().min(1),
    alertType: z.enum([
      "mismatch",
      "duplicate_awb",
      "weight_discrepancy",
      "zone_mismatch",
      "rto_charge_mismatch",
      "cod_fee_mismatch",
      "resolved",
      "dispute_created"
    ]).default("mismatch"),
    mode: z.enum([
      "mismatch",
      "duplicate_awb",
      "weight_discrepancy",
      "zone_mismatch",
      "rto_charge_mismatch",
      "cod_fee_mismatch",
      "resolved",
      "dispute_created",
      "email_only",
      "whatsapp_only",
      "both",
      "admin_escalation"
    ]).default("email_only"),
    invoiceId: z.string().min(1).optional(),
    mismatchId: z.string().min(1).optional(),
    courierPartnerId: z.string().min(1).optional(),
    courierPartnerName: z.string().min(1).optional(),
    severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
    invoiceDate: z.string().min(1).optional(),
    detectedAt: z.string().min(1).optional(),
    awbCount: z.number().int().min(0).optional(),
    affectedShipmentCount: z.number().int().min(0).optional(),
    expectedAmountPaise: z.number().int().min(0).optional(),
    billedAmountPaise: z.number().int().min(0).optional(),
    mismatchAmountPaise: z.number().int().min(0).optional(),
    financeSummaryUrl: z.string().url().optional(),
    disputeUrl: z.string().url().optional()
  }).parse(req.body ?? {});
  const alertMode = [
    "mismatch",
    "duplicate_awb",
    "weight_discrepancy",
    "zone_mismatch",
    "rto_charge_mismatch",
    "cod_fee_mismatch",
    "resolved",
    "dispute_created"
  ].includes(body.mode) ? body.mode : body.alertType;
  const channelMode = ["email_only", "whatsapp_only", "both", "admin_escalation"].includes(body.mode)
    ? body.mode as "email_only" | "whatsapp_only" | "both" | "admin_escalation"
    : "email_only";
  const result = await runInvoiceMismatchSmoke({
    ...body,
    alertType: alertMode as any,
    mode: channelMode
  });

  res.json({
    ok: true,
    alertType: result.alertType,
    mode: result.mode,
    merchantId: result.merchant.id,
    event: result.event
  });
});

internalAutomationRouter.post("/courier-pickup-delay/smoke", async (req, res) => {
  const body = z.object({
    merchantId: z.string().min(1),
    alertType: z.enum(["delay", "missed", "failed", "escalated", "resolved"]).default("delay"),
    mode: z.enum([
      "delay",
      "missed",
      "failed",
      "escalated",
      "resolved",
      "merchant_email",
      "courier_email",
      "ops_escalation",
      "both",
      "whatsapp_only"
    ]).default("both"),
    pickupId: z.string().min(1).optional(),
    courierPartnerId: z.string().min(1).optional(),
    courierPartnerName: z.string().min(1).optional(),
    courierEmail: z.string().email().optional(),
    pickupDate: z.string().min(1).optional(),
    scheduledPickupWindow: z.string().min(1).optional(),
    delayMinutes: z.number().int().min(0).optional(),
    affectedShipmentCount: z.number().int().min(0).optional(),
    awbCount: z.number().int().min(0).optional(),
    oldestAwbAgeMinutes: z.number().int().min(0).optional(),
    pickupLocationSummary: z.string().min(1).optional(),
    city: z.string().min(1).optional(),
    state: z.string().min(1).optional(),
    pincode: z.string().min(1).optional(),
    severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
    pickupDashboardUrl: z.string().url().optional()
  }).parse(req.body ?? {});
  const alertMode = ["delay", "missed", "failed", "escalated", "resolved"].includes(body.mode) ? body.mode : body.alertType;
  const channelMode = ["merchant_email", "courier_email", "ops_escalation", "both", "whatsapp_only"].includes(body.mode)
    ? body.mode as "merchant_email" | "courier_email" | "ops_escalation" | "both" | "whatsapp_only"
    : "both";
  const result = await runCourierPickupDelaySmoke({
    ...body,
    alertType: alertMode as "delay" | "missed" | "failed" | "escalated" | "resolved",
    mode: channelMode
  });

  res.json({
    ok: true,
    alertType: result.alertType,
    mode: result.mode,
    merchantId: result.merchant.id,
    event: result.event
  });
});

internalAutomationRouter.post("/courier-sla-breach/smoke", async (req, res) => {
  const body = z.object({
    merchantId: z.string().min(1),
    alertType: z.enum([
      "general",
      "pickup",
      "first_scan",
      "in_transit",
      "ofd",
      "ndr_response",
      "reattempt",
      "rto",
      "cod_remittance",
      "escalated",
      "resolved"
    ]).default("pickup"),
    mode: z.enum([
      "pickup",
      "first_scan",
      "in_transit",
      "ofd",
      "ndr_response",
      "reattempt",
      "rto",
      "cod_remittance",
      "escalated",
      "resolved",
      "merchant_email",
      "courier_email",
      "ops_escalation",
      "finance_escalation",
      "both",
      "whatsapp_only"
    ]).default("both"),
    breachId: z.string().min(1).optional(),
    breachType: z.string().min(1).optional(),
    courierPartnerId: z.string().min(1).optional(),
    courierPartnerName: z.string().min(1).optional(),
    courierEmail: z.string().email().optional(),
    detectedAt: z.string().min(1).optional(),
    slaTarget: z.string().min(1).optional(),
    actualValue: z.union([z.string().min(1), z.number()]).optional(),
    breachMinutes: z.number().int().min(0).optional(),
    affectedShipmentCount: z.number().int().min(0).optional(),
    awbCount: z.number().int().min(0).optional(),
    sampleAwbs: z.array(z.string().min(1)).max(5).optional(),
    city: z.string().min(1).optional(),
    state: z.string().min(1).optional(),
    pincode: z.string().min(1).optional(),
    laneSummary: z.string().min(1).optional(),
    severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
    courierDashboardUrl: z.string().url().optional()
  }).parse(req.body ?? {});
  const alertMode = [
    "pickup",
    "first_scan",
    "in_transit",
    "ofd",
    "ndr_response",
    "reattempt",
    "rto",
    "cod_remittance",
    "escalated",
    "resolved"
  ].includes(body.mode) ? body.mode : body.alertType;
  const channelMode = ["merchant_email", "courier_email", "ops_escalation", "finance_escalation", "both", "whatsapp_only"].includes(body.mode)
    ? body.mode as "merchant_email" | "courier_email" | "ops_escalation" | "finance_escalation" | "both" | "whatsapp_only"
    : "both";
  const result = await runCourierSlaBreachSmoke({
    ...body,
    alertType: alertMode as any,
    mode: channelMode
  });

  res.json({
    ok: true,
    alertType: result.alertType,
    mode: result.mode,
    merchantId: result.merchant.id,
    event: result.event
  });
});

internalAutomationRouter.post("/fake-scan-review/smoke", async (req, res) => {
  const body = z.object({
    merchantId: z.string().min(1),
    alertType: z.enum([
      "general",
      "pickup_fake",
      "delivery_attempt_fake",
      "ndr_fake",
      "late_scan",
      "impossible_sequence",
      "location_mismatch",
      "duplicate_pattern",
      "after_terminal_state",
      "escalated",
      "resolved",
      "dismissed"
    ]).default("pickup_fake"),
    mode: z.enum([
      "pickup_fake",
      "delivery_attempt_fake",
      "ndr_fake",
      "late_scan",
      "impossible_sequence",
      "location_mismatch",
      "duplicate_pattern",
      "after_terminal_state",
      "escalated",
      "resolved",
      "dismissed",
      "ops_internal",
      "merchant_email",
      "courier_email",
      "both",
      "whatsapp_only"
    ]).default("ops_internal"),
    anomalyId: z.string().min(1).optional(),
    anomalyType: z.string().min(1).optional(),
    courierPartnerId: z.string().min(1).optional(),
    courierPartnerName: z.string().min(1).optional(),
    courierEmail: z.string().email().optional(),
    detectedAt: z.string().min(1).optional(),
    shipmentId: z.string().min(1).optional(),
    orderId: z.string().min(1).optional(),
    awb: z.string().min(1).optional(),
    affectedShipmentCount: z.number().int().min(0).optional(),
    awbCount: z.number().int().min(0).optional(),
    scanStatus: z.string().min(1).optional(),
    previousStatus: z.string().min(1).optional(),
    nextStatus: z.string().min(1).optional(),
    scanTimestamp: z.string().min(1).optional(),
    receivedAt: z.string().min(1).optional(),
    delayMinutes: z.number().int().min(0).optional(),
    locationSummary: z.string().min(1).optional(),
    expectedLocationSummary: z.string().min(1).optional(),
    routeSummary: z.string().min(1).optional(),
    anomalyReasonCode: z.string().min(1).optional(),
    sellerSafeSummary: z.string().min(1).optional(),
    opsReviewSummary: z.string().min(1).optional(),
    severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
    courierDashboardUrl: z.string().url().optional()
  }).parse(req.body ?? {});
  const alertMode = [
    "pickup_fake",
    "delivery_attempt_fake",
    "ndr_fake",
    "late_scan",
    "impossible_sequence",
    "location_mismatch",
    "duplicate_pattern",
    "after_terminal_state",
    "escalated",
    "resolved",
    "dismissed"
  ].includes(body.mode) ? body.mode : body.alertType;
  const channelMode = ["ops_internal", "merchant_email", "courier_email", "both", "whatsapp_only"].includes(body.mode)
    ? body.mode as "ops_internal" | "merchant_email" | "courier_email" | "both" | "whatsapp_only"
    : "ops_internal";
  const result = await runFakeScanReviewSmoke({
    ...body,
    alertType: alertMode as any,
    mode: channelMode
  });

  res.json({
    ok: true,
    alertType: result.alertType,
    mode: result.mode,
    merchantId: result.merchant.id,
    event: result.event
  });
});

internalAutomationRouter.post("/courier-daily-digest/smoke", async (req, res) => {
  const body = z.object({
    merchantId: z.string().min(1),
    scope: z.enum(["OPS", "COURIER_PARTNER"]).optional(),
    mode: z.enum([
      "ops",
      "courier_partner",
      "email_only",
      "internal_only",
      "both",
      "whatsapp_only",
      "failure"
    ]).default("ops"),
    digestId: z.string().min(1).optional(),
    digestDate: z.string().min(1).optional(),
    timezone: z.string().min(1).optional(),
    courierPartnerId: z.string().min(1).optional(),
    courierPartnerName: z.string().min(1).optional(),
    courierEmail: z.string().email().optional(),
    pendingPickupCount: z.number().int().min(0).optional(),
    missedPickupCount: z.number().int().min(0).optional(),
    failedPickupCount: z.number().int().min(0).optional(),
    slaBreachCount: z.number().int().min(0).optional(),
    ndrBacklogCount: z.number().int().min(0).optional(),
    reattemptPendingCount: z.number().int().min(0).optional(),
    fakeScanReviewCount: z.number().int().min(0).optional(),
    rtoDelayCount: z.number().int().min(0).optional(),
    codRemittanceSlaIssueCount: z.number().int().min(0).optional(),
    invoiceMismatchCount: z.number().int().min(0).optional(),
    invoiceMismatchAmountPaise: z.number().int().min(0).optional(),
    affectedMerchantCount: z.number().int().min(0).optional(),
    affectedShipmentCount: z.number().int().min(0).optional(),
    highSeverityCount: z.number().int().min(0).optional(),
    criticalSeverityCount: z.number().int().min(0).optional(),
    topIssues: z.array(z.union([z.string().min(1), metadataSchema])).max(8).optional(),
    recommendedActions: z.array(z.string().min(1)).max(8).optional(),
    dashboardUrl: z.string().url().optional()
  }).parse(req.body ?? {});
  const scope = body.scope || (body.mode === "courier_partner" ? "COURIER_PARTNER" : "OPS");
  const result = await runCourierDailyDigestSmoke({
    ...body,
    scope
  });

  res.json({
    ok: true,
    scope: result.scope,
    mode: result.mode,
    merchantId: result.merchant.id,
    event: result.event
  });
});

internalAutomationRouter.get("/merchant-context/:merchantId", async (req, res) => {
  const params = z.object({ merchantId: z.string().min(1) }).parse(req.params);
  const context = await getMerchantAutomationContext(params.merchantId);

  res.json(context);
});

internalAutomationRouter.post("/callback/smoke", async (req, res) => {
  if (!env.SHIPMASTR_AUTOMATION_SMOKE_CALLBACKS_ENABLED) {
    return res.status(403).json({ error: "AUTOMATION_SMOKE_CALLBACK_DISABLED" });
  }

  if (!verifySignedAutomationCallback(req, res)) return;

  const validation = validateAutomationSmokeCallbackBody(req.body);
  if (!validation.ok) {
    return res.status(validation.status).json({ error: validation.error });
  }

  res.status(202).json({
    ok: true,
    synthetic: true,
    eventId: validation.eventId,
    status: "ACCEPTED",
    receivedAt: new Date().toISOString()
  });
});

internalAutomationRouter.post("/callback", async (req, res) => {
  if (!verifySignedAutomationCallback(req, res)) return;

  const body = z.object({
    eventId: z.string().min(1),
    merchantId: z.string().min(1).optional(),
    status: z.enum(["PROCESSED", "FAILED"]),
    workflowKey: z.string().min(1).optional(),
    templateKey: z.string().min(1).optional(),
    cartId: z.string().min(1).optional(),
    checkoutId: z.string().min(1).optional(),
    buyerId: z.string().min(1).optional(),
    lastOrderId: z.string().min(1).optional(),
    remittanceId: z.string().min(1).optional(),
    settlementId: z.string().min(1).optional(),
    settlementStatus: z.string().min(1).optional(),
    expectedPayoutDate: z.string().min(1).optional(),
    paidAt: z.string().min(1).optional(),
    statementUrl: z.string().url().optional(),
    invoiceId: z.string().min(1).optional(),
    mismatchId: z.string().min(1).optional(),
    financeSummaryUrl: z.string().url().optional(),
    disputeUrl: z.string().url().optional(),
    pickupId: z.string().min(1).optional(),
    pickupDate: z.string().min(1).optional(),
    courierPartnerId: z.string().min(1).optional(),
    courierPartnerName: z.string().min(1).optional(),
    breachId: z.string().min(1).optional(),
    breachType: z.string().min(1).optional(),
    breachMinutes: z.number().min(0).optional(),
    anomalyId: z.string().min(1).optional(),
    anomalyType: z.string().min(1).optional(),
    scanStatus: z.string().min(1).optional(),
    anomalyReasonCode: z.string().min(1).optional(),
    delayMinutes: z.number().min(0).optional(),
    digestId: z.string().min(1).optional(),
    digestDate: z.string().min(1).optional(),
    scope: z.enum(["OPS", "COURIER_PARTNER"]).optional(),
    dueDate: z.string().min(1).optional(),
    settlementDate: z.string().min(1).optional(),
    ageingBucket: z.string().min(1).optional(),
    recoveryUrl: z.string().url().optional(),
    storeUrl: z.string().url().optional(),
    result: metadataSchema.optional(),
    error: z.string().optional(),
    channelResults: z.array(z.object({
      channel: z.string().min(1),
      provider: z.string().optional(),
      providerMessageId: z.string().optional(),
      sender: z.string().optional(),
      replyTo: z.string().optional(),
      recipient: z.string().optional(),
      status: z.string().min(1),
      skipReason: z.string().optional(),
      error: z.string().optional(),
      metadata: metadataSchema.optional()
    })).optional(),
    communication: z.object({
      merchantId: z.string().min(1),
      eventId: z.string().min(1).optional(),
      campaignId: z.string().min(1).optional(),
      channel: z.string().min(1),
      recipient: z.string().min(1).optional(),
      from: z.string().min(1).optional(),
      replyTo: z.string().min(1).optional(),
      to: z.string().min(1).optional(),
      subject: z.string().min(1).optional(),
      digestDate: z.string().min(1).optional(),
      templateKey: z.string().min(1).optional(),
      status: z.string().min(1).optional(),
      buyerAction: z.string().min(1).optional(),
      courierInstructionStatus: z.string().min(1).optional(),
      renderedMessage: z.string().optional(),
      provider: z.string().optional(),
      providerMessageId: z.string().optional(),
      metadata: metadataSchema.optional()
    }).optional()
  }).parse(req.body);

  try {
      const result = await handleAutomationCallback(compactData({
      ...body,
      result: compactData({
        ...(body.result || {}),
        workflowKey: body.workflowKey,
        cartId: body.cartId,
        checkoutId: body.checkoutId,
        recoveryUrl: body.recoveryUrl,
        buyerId: body.buyerId,
        lastOrderId: body.lastOrderId,
        storeUrl: body.storeUrl,
        remittanceId: body.remittanceId,
        settlementId: body.settlementId,
        settlementStatus: body.settlementStatus,
        expectedPayoutDate: body.expectedPayoutDate,
        paidAt: body.paidAt,
        statementUrl: body.statementUrl,
        invoiceId: body.invoiceId,
        mismatchId: body.mismatchId,
        financeSummaryUrl: body.financeSummaryUrl,
        disputeUrl: body.disputeUrl,
        pickupId: body.pickupId,
        pickupDate: body.pickupDate,
        courierPartnerId: body.courierPartnerId,
        courierPartnerName: body.courierPartnerName,
        breachId: body.breachId,
        breachType: body.breachType,
        breachMinutes: body.breachMinutes,
        anomalyId: body.anomalyId,
        anomalyType: body.anomalyType,
        scanStatus: body.scanStatus,
        anomalyReasonCode: body.anomalyReasonCode,
        delayMinutes: body.delayMinutes,
        digestId: body.digestId,
        digestDate: body.digestDate,
        scope: body.scope,
        dueDate: body.dueDate,
        settlementDate: body.settlementDate,
        ageingBucket: body.ageingBucket
      }),
      channelResults: body.channelResults?.map((channelResult) => compactData({
        ...channelResult,
        metadata: compactData({
          ...(channelResult.metadata || {}),
          cartId: body.cartId,
          checkoutId: body.checkoutId,
          recoveryUrl: body.recoveryUrl,
          buyerId: body.buyerId,
          lastOrderId: body.lastOrderId,
          storeUrl: body.storeUrl,
          remittanceId: body.remittanceId,
          settlementId: body.settlementId,
          settlementStatus: body.settlementStatus,
          expectedPayoutDate: body.expectedPayoutDate,
          paidAt: body.paidAt,
          statementUrl: body.statementUrl,
          invoiceId: body.invoiceId,
          mismatchId: body.mismatchId,
          financeSummaryUrl: body.financeSummaryUrl,
          disputeUrl: body.disputeUrl,
          pickupId: body.pickupId,
          pickupDate: body.pickupDate,
          courierPartnerId: body.courierPartnerId,
          courierPartnerName: body.courierPartnerName,
          breachId: body.breachId,
          breachType: body.breachType,
          breachMinutes: body.breachMinutes,
          anomalyId: body.anomalyId,
          anomalyType: body.anomalyType,
          scanStatus: body.scanStatus,
          anomalyReasonCode: body.anomalyReasonCode,
          delayMinutes: body.delayMinutes,
          digestId: body.digestId,
          digestDate: body.digestDate,
          scope: body.scope,
          dueDate: body.dueDate,
          settlementDate: body.settlementDate,
          ageingBucket: body.ageingBucket,
          templateKey: body.templateKey
        })
      })),
      communication: body.communication
        ? compactData({
          ...body.communication,
          eventId: body.eventId,
          recipient: body.communication.recipient || body.communication.to,
          metadata: compactData({
            ...(body.communication.metadata || {}),
            from: body.communication.from,
            replyTo: body.communication.replyTo || body.communication.from,
            to: body.communication.to || body.communication.recipient,
            subject: body.communication.subject,
            digestDate: body.communication.digestDate,
            remittanceId: body.remittanceId,
            settlementId: body.settlementId,
            settlementStatus: body.settlementStatus,
            expectedPayoutDate: body.expectedPayoutDate,
            paidAt: body.paidAt,
            statementUrl: body.statementUrl,
            invoiceId: body.invoiceId,
            mismatchId: body.mismatchId,
            financeSummaryUrl: body.financeSummaryUrl,
            disputeUrl: body.disputeUrl,
            pickupId: body.pickupId,
            pickupDate: body.pickupDate,
            courierPartnerId: body.courierPartnerId,
            courierPartnerName: body.courierPartnerName,
            anomalyId: body.anomalyId,
            anomalyType: body.anomalyType,
            scanStatus: body.scanStatus,
            anomalyReasonCode: body.anomalyReasonCode,
            delayMinutes: body.delayMinutes,
            dueDate: body.dueDate,
            settlementDate: body.settlementDate,
            ageingBucket: body.ageingBucket,
            buyerAction: body.communication.buyerAction,
            courierInstructionStatus: body.communication.courierInstructionStatus
          })
        })
        : undefined
    }) as never);

    res.json(result);
  } catch (error) {
    if (error instanceof AutomationCallbackError) {
      return res.status(error.status).json({ error: error.message });
    }

    throw error;
  }
});

adminAutomationRouter.get("/events", async (req, res) => {
  const query = z.object({
    merchantId: z.string().optional(),
    status: z.string().optional(),
    eventKey: z.string().optional(),
    courierPartnerId: z.string().optional(),
    ageingBucket: z.string().optional(),
    severity: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100)
  }).parse(req.query);

  const events = await prisma.automationEvent.findMany({
    where: {
      ...compactData({
        merchantId: query.merchantId,
        status: query.status,
        eventKey: query.eventKey
      })
    } as never,
    orderBy: { createdAt: "desc" },
    take: query.courierPartnerId || query.ageingBucket || query.severity ? Math.min(query.limit * 3, 200) : query.limit
  });

  const filteredEvents = events.filter((event) => {
    const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? event.payload as Record<string, any>
      : {};
    const courierPartner = payload.courierPartner && typeof payload.courierPartner === "object"
      ? payload.courierPartner as Record<string, any>
      : {};
    if (query.courierPartnerId && courierPartner.id !== query.courierPartnerId && payload.courierPartnerId !== query.courierPartnerId) return false;
    if (query.ageingBucket && payload.ageingBucket !== query.ageingBucket) return false;
    if (query.severity && payload.severity !== query.severity) return false;
    return true;
  }).slice(0, query.limit);

  res.json({ events: filteredEvents });
});

adminAutomationRouter.post("/events/:id/retry", async (req, res) => {
  const params = z.object({ id: z.string().min(1) }).parse(req.params);
  const event = await retryAutomationEvent(params.id);

  res.json({ event });
});

adminAutomationRouter.post("/merchants/:merchantId/pause", async (req, res) => {
  const params = z.object({ merchantId: z.string().min(1) }).parse(req.params);
  const preference = await prisma.automationPreference.upsert({
    where: { merchantId: params.merchantId },
    create: { merchantId: params.merchantId, autopilotEnabled: false },
    update: { autopilotEnabled: false }
  });

  await prisma.auditLog.create({
    data: {
      merchantId: params.merchantId,
      actorId: req.auth!.userId,
      action: "automation.merchant.paused",
      entityType: "AutomationPreference",
      entityId: preference.id
    }
  });

  res.json({ preference });
});

adminAutomationRouter.post("/merchants/:merchantId/resume", async (req, res) => {
  const params = z.object({ merchantId: z.string().min(1) }).parse(req.params);
  const preference = await prisma.automationPreference.upsert({
    where: { merchantId: params.merchantId },
    create: { merchantId: params.merchantId, autopilotEnabled: true },
    update: { autopilotEnabled: true }
  });

  await prisma.auditLog.create({
    data: {
      merchantId: params.merchantId,
      actorId: req.auth!.userId,
      action: "automation.merchant.resumed",
      entityType: "AutomationPreference",
      entityId: preference.id
    }
  });

  res.json({ preference });
});

adminAutomationRouter.get("/logs", async (req, res) => {
  const query = z.object({
    merchantId: z.string().optional(),
    channel: z.string().optional(),
    status: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100)
  }).parse(req.query);

  const logs = await prisma.communicationLog.findMany({
    where: {
      ...compactData({
        merchantId: query.merchantId,
        channel: query.channel,
        status: query.status
      })
    } as never,
    orderBy: { createdAt: "desc" },
    take: query.limit
  });

  res.json({ logs });
});

automationRouter.get("/policy", async (req, res) => {
  const policy = await prisma.merchantAutomationPolicy.upsert({
    where: { merchantId: req.auth!.merchantId },
    create: { merchantId: req.auth!.merchantId },
    update: {}
  });

  res.json({ policy });
});

automationCallbacksRouter.post("/buyer-response", async (req, res) => {
  const body = callbackBody(callbackSchema, req.body);
  const result = await handleBuyerCommunicationCallback(body);

  res.json({
    ok: true,
    event: sellerSafeCommunicationEvent(result.event),
    actionType: result.actionType
  });
});

automationCallbacksRouter.post("/otp", async (req, res) => {
  const body = callbackBody(narrowedCallbackSchema(["OTP_VERIFIED", "OTP_FAILED", "NO_RESPONSE", "INVALID_RESPONSE"]), req.body);
  const result = await handleBuyerCommunicationCallback({
    ...body,
    actionType: "SEND_COD_OTP",
    template: "send_cod_otp"
  });

  res.json({
    ok: true,
    event: sellerSafeCommunicationEvent(result.event),
    actionType: result.actionType
  });
});

automationCallbacksRouter.post("/address-confirmation", async (req, res) => {
  const body = callbackBody(narrowedCallbackSchema(["ADDRESS_CONFIRMED", "ADDRESS_CORRECTED", "NO_RESPONSE", "INVALID_RESPONSE"]), req.body);
  const result = await handleBuyerCommunicationCallback({
    ...body,
    actionType: "SEND_ADDRESS_CORRECTION_LINK",
    template: "send_address_correction_link"
  });

  res.json({
    ok: true,
    event: sellerSafeCommunicationEvent(result.event),
    actionType: result.actionType
  });
});

automationCallbacksRouter.post("/prepaid-conversion", async (req, res) => {
  const body = callbackBody(narrowedCallbackSchema(["PREPAID_CONVERTED", "BUYER_REFUSED", "NO_RESPONSE", "INVALID_RESPONSE"]), req.body);
  const result = await handleBuyerCommunicationCallback({
    ...body,
    actionType: "SEND_PREPAID_LINK",
    template: "send_prepaid_link"
  });

  res.json({
    ok: true,
    event: sellerSafeCommunicationEvent(result.event),
    actionType: result.actionType
  });
});

automationCallbacksRouter.post("/ndr-reattempt", async (req, res) => {
  const body = callbackBody(narrowedCallbackSchema(["BUYER_CONFIRMED_REATTEMPT", "BUYER_REFUSED", "NO_RESPONSE", "INVALID_RESPONSE"]), req.body);
  const result = await handleBuyerCommunicationCallback({
    ...body,
    actionType: "SEND_NDR_RECOVERY_MESSAGE",
    template: "send_ndr_recovery_message"
  });

  res.json({
    ok: true,
    event: sellerSafeCommunicationEvent(result.event),
    actionType: result.actionType
  });
});

automationCommunicationsRouter.get("/queue", async (req, res) => {
  const query = z.object({
    channel: z.enum(communicationChannels).optional(),
    status: z.enum(communicationStatuses).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional()
  }).parse(req.query);
  const communications = await listQueuedBuyerCommunications(query);

  res.json({
    communications: communications.map(sellerSafeCommunicationEvent)
  });
});

automationCommunicationsRouter.post("/process-queue", async (req, res) => {
  const body = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(25)
  }).parse(req.body ?? {});
  const result = await processQueuedBuyerCommunications({ limit: body.limit });

  res.json(result);
});

automationCommunicationsRouter.post("/provider-callback", async (req, res) => {
  const body = z.object({
    providerMessageId: z.string().min(1),
    status: z.enum(deliveryStatuses),
    errorCode: z.string().min(1).optional(),
    metadata: metadataSchema.optional()
  }).parse(req.body);
  const communication = await handleProviderDeliveryCallback(body);

  res.json({ communication: sellerSafeCommunicationEvent(communication) });
});

automationCommunicationsRouter.patch("/:id/status", async (req, res) => {
  const params = z.object({ id: z.string().min(1) }).parse(req.params);
  const body = z.object({
    status: z.enum(deliveryStatuses),
    providerMessageId: z.string().min(1).optional(),
    metadata: metadataSchema.optional()
  }).parse(req.body);
  const communication = await updateBuyerCommunicationStatus({
    id: params.id,
    status: body.status,
    providerMessageId: body.providerMessageId,
    metadata: body.metadata
  });

  res.json({ communication: sellerSafeCommunicationEvent(communication) });
});

automationRouter.patch("/policy", async (req, res) => {
  const body = policyPatchSchema.parse(req.body);
  const policy = await updateMerchantAutomationPolicy(req.auth!.merchantId, body);

  res.json({ policy });
});
