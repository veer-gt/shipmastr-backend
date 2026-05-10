import { Router } from "express";
import { z } from "zod";
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

export const automationRouter = Router();
export const automationCallbacksRouter = Router();
export const automationCommunicationsRouter = Router();

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
