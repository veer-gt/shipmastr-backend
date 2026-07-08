import { OrderStatus, Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { emailTemplates, sendTransactionalEmail, trackingUrl } from "../../lib/email.js";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { getCarrierAdapter } from "../carrierAdapters/carrier-adapter.factory.js";
import { applyCarrierTrackingUpdate } from "../carrierAdapters/carrier-tracking.service.js";
import { updateAddressFingerprint } from "../intelligence/address-intelligence.service.js";
import { handleWebhookAutonomy } from "../intelligence/autonomous-action.service.js";
import { updateConsigneeProfileFromWebhook } from "../intelligence/consignee-intelligence.service.js";
import { updateCourierPerformanceFromWebhook } from "../intelligence/courier-performance.service.js";
import { addressHash, phoneHash } from "../intelligence/fingerprint.js";
import { updateMerchantTrustProfile } from "../intelligence/merchant-trust.service.js";
import { updateMerchantMetrics } from "../intelligence/metrics.service.js";
import { updateOrderDataSignalsFromWebhook, updateShipmentDetailsFromWebhook } from "../intelligence/order-intelligence.service.js";
import { createSlaBreach, logOperationalEvent } from "../intelligence/operational-reliability.service.js";
import { actualOutcomeFromCarrier, evaluatePredictionOutcome } from "../intelligence/prediction-outcome.service.js";
import { verifyWebhookSignature } from "./webhook.security.js";
import { AutomationCallbackError, buildNdrRecoveryAutomationEvent, emitAutomationEvent, handleWhatsappProviderCallback, verifyWhatsappProviderSignature } from "../automation/autopilot.service.js";
export const webhooksRouter = Router();
const whatsappProviderCallbackSchema = z.object({
    providerMessageId: z.string().min(1),
    merchantId: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    status: z.string().min(1).optional(),
    eventType: z.string().min(1).optional(),
    sender: z.string().min(1).optional(),
    recipient: z.string().min(1).optional(),
    templateKey: z.string().min(1).optional(),
    failureReason: z.string().min(1).optional(),
    buyerMessage: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.any()).optional()
});
const schema = z.object({
    externalId: z.string(),
    eventType: z.string(),
    merchantId: z.string().optional(),
    orderId: z.string().optional(),
    externalOrderId: z.string().optional(),
    awbNumber: z.string().optional(),
    trackingNumber: z.string().optional(),
    latestEvent: z.string().optional(),
    description: z.string().optional()
}).passthrough();
const statusByEventType = {
    "shipment.delivered": "DELIVERED",
    "shipment.ndr": "NDR",
    "shipment.rto": "RTO",
    "shipment.shipped": "SHIPPED",
    "shipment.cancelled": "CANCELLED",
    "shipment.lost": "CANCELLED"
};
function courierEventType(eventType) {
    const value = eventType.toLowerCase();
    if (value.includes("delivered"))
        return "DELIVERED";
    if (value.includes("ndr"))
        return "NDR";
    if (value.includes("rto"))
        return "RTO";
    if (value.includes("lost"))
        return "LOST";
    if (value.includes("cancel"))
        return "CANCELLED";
    if (value.includes("pickup"))
        return "PICKED_UP";
    if (value.includes("ofd") || value.includes("out_for_delivery"))
        return "OUT_FOR_DELIVERY";
    return "IN_TRANSIT";
}
function ndrReasonFromPayload(body) {
    const reason = String(body.reason || body.ndrReason || "").toLowerCase();
    if (reason.includes("reachable") || reason.includes("phone"))
        return "CUSTOMER_NOT_REACHABLE";
    if (reason.includes("address"))
        return "ADDRESS_ISSUE";
    if (reason.includes("refused"))
        return "CUSTOMER_REFUSED";
    if (reason.includes("payment"))
        return "PAYMENT_ISSUE";
    if (reason.includes("reschedule"))
        return "RESCHEDULE_REQUESTED";
    return "OTHER";
}
function rtoReasonFromPayload(body) {
    const reason = String(body.reason || body.rtoReason || "").toLowerCase();
    if (reason.includes("refused"))
        return "CUSTOMER_REFUSED";
    if (reason.includes("address"))
        return "ADDRESS_INCOMPLETE";
    if (reason.includes("reachable") || reason.includes("phone"))
        return "CUSTOMER_UNREACHABLE";
    if (reason.includes("courier"))
        return "COURIER_ISSUE";
    if (reason.includes("failed"))
        return "FAILED_DELIVERY";
    return "OTHER";
}
webhooksRouter.post("/whatsapp/provider", async (req, res) => {
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body));
    const signature = req.header("x-whatsapp-signature") ??
        req.header("x-provider-signature") ??
        req.header("x-hub-signature-256") ??
        req.header("x-shipmastr-signature") ??
        undefined;
    if (!verifyWhatsappProviderSignature({ body: rawBody, signature })) {
        throw new HttpError(401, "INVALID_WHATSAPP_PROVIDER_SIGNATURE");
    }
    const body = whatsappProviderCallbackSchema.parse(req.body);
    try {
        const result = await handleWhatsappProviderCallback(body);
        res.json({
            ok: true,
            communication: {
                id: result.communication.id,
                merchantId: result.communication.merchantId,
                channel: result.communication.channel,
                templateKey: result.communication.templateKey,
                status: result.communication.status,
                provider: result.communication.provider,
                providerMessageId: result.communication.providerMessageId,
                deliveredAt: result.communication.deliveredAt,
                readAt: result.communication.readAt,
                failedAt: result.communication.failedAt
            },
            optOutRecorded: Boolean(result.optOut)
        });
    }
    catch (error) {
        if (error instanceof AutomationCallbackError) {
            throw new HttpError(error.status, error.message);
        }
        throw error;
    }
});
webhooksRouter.post("/carrier", async (req, res) => {
    const signatureValid = verifyWebhookSignature(req.rawBody ?? Buffer.from(JSON.stringify(req.body)), req.header("x-shipmastr-signature") ?? undefined);
    if (!signatureValid) {
        throw new HttpError(401, "INVALID_WEBHOOK_SIGNATURE");
    }
    const headers = {};
    const signatureHeader = req.header("x-shipmastr-signature") ?? undefined;
    const courierProviderHeader = req.header("x-courier-provider") ?? undefined;
    if (signatureHeader)
        headers["x-shipmastr-signature"] = signatureHeader;
    if (courierProviderHeader)
        headers["x-courier-provider"] = courierProviderHeader;
    const normalizedWebhook = await getCarrierAdapter().parseWebhook(req.body, {
        headers,
        receivedAt: new Date()
    });
    const body = schema.parse(normalizedWebhook);
    const existing = await prisma.webhookEvent.findUnique({
        where: {
            provider_externalId: {
                provider: "CARRIER",
                externalId: body.externalId
            }
        }
    });
    if (existing) {
        return res.json({
            ok: true,
            duplicate: true
        });
    }
    const order = body.orderId
        ? await prisma.order.findUnique({
            where: { id: body.orderId },
            include: { merchant: true }
        })
        : body.externalOrderId && body.merchantId
            ? await prisma.order.findUnique({
                where: {
                    merchantId_externalOrderId: {
                        merchantId: body.merchantId,
                        externalOrderId: body.externalOrderId
                    }
                },
                include: { merchant: true }
            })
            : null;
    const mappedStatus = statusByEventType[body.eventType];
    const actualOutcome = actualOutcomeFromCarrier(body.eventType);
    const result = await prisma.$transaction(async (tx) => {
        const event = await tx.webhookEvent.create({
            data: {
                provider: "CARRIER",
                externalId: body.externalId,
                eventType: body.eventType,
                payload: body,
                signatureValid,
                status: "PROCESSED",
                ...(order?.id ? { orderId: order.id } : {})
            }
        });
        let ndrEvent = null;
        await applyCarrierTrackingUpdate({
            awbNumber: body.awbNumber ?? null,
            trackingNumber: body.trackingNumber ?? null,
            orderId: order?.id ?? body.orderId ?? body.externalOrderId ?? null,
            status: normalizedWebhook.status,
            eventType: body.eventType,
            latestEvent: body.latestEvent ?? body.description ?? body.eventType,
            location: normalizedWebhook.location ?? null,
            rawPayload: body
        }, tx);
        if (order && mappedStatus) {
            await tx.order.update({
                where: { id: order.id },
                data: { status: mappedStatus }
            });
            await updateShipmentDetailsFromWebhook({ order, payload: body, status: mappedStatus }, tx);
            await updateOrderDataSignalsFromWebhook({ orderId: order.id, payload: body, status: mappedStatus }, tx);
            if (actualOutcome !== "PENDING") {
                await evaluatePredictionOutcome(order.id, actualOutcome, tx);
            }
            await handleWebhookAutonomy({
                orderId: order.id,
                merchantId: order.merchantId,
                eventType: body.eventType,
                reason: typeof body.reason === "string" ? body.reason : typeof body.ndrReason === "string" ? body.ndrReason : null,
                phoneHash: phoneHash(order.buyerPhone),
                buyerConfirmed: body.buyerConfirmed === true
            }, tx);
            await updateAddressFingerprint({ ...order, status: mappedStatus }, tx);
            await updateConsigneeProfileFromWebhook({ ...order, status: mappedStatus }, mappedStatus, tx);
            await tx.auditLog.create({
                data: {
                    merchantId: order.merchantId,
                    action: "ORDER_STATUS_TRANSITIONED",
                    entityType: "Order",
                    entityId: order.id,
                    metadata: {
                        eventType: body.eventType,
                        externalId: body.externalId,
                        status: mappedStatus
                    }
                }
            });
            const pHash = phoneHash(order.buyerPhone);
            const aHash = addressHash(order);
            if (mappedStatus === "NDR") {
                ndrEvent = await tx.ndrEvent.create({
                    data: {
                        merchantId: order.merchantId,
                        orderId: order.id,
                        courierId: typeof body.courierId === "string" ? body.courierId : null,
                        pincode: order.pincode,
                        phoneHash: pHash,
                        addressHash: aHash,
                        reason: ndrReasonFromPayload(body),
                        actionRequired: String(body.actionRequired || "Review reattempt action"),
                        metadata: { eventType: body.eventType, externalId: body.externalId }
                    }
                });
            }
            if (mappedStatus === "RTO") {
                await tx.rtoEvent.create({
                    data: {
                        merchantId: order.merchantId,
                        orderId: order.id,
                        courierId: typeof body.courierId === "string" ? body.courierId : null,
                        pincode: order.pincode,
                        phoneHash: pHash,
                        addressHash: aHash,
                        reason: rtoReasonFromPayload(body),
                        metadata: { eventType: body.eventType, externalId: body.externalId }
                    }
                });
            }
            await updateCourierPerformanceFromWebhook({ ...event, order }, tx);
            await updateMerchantMetrics(order.merchantId, tx);
            await updateMerchantTrustProfile(order.merchantId, tx);
            await logOperationalEvent({
                merchantId: order.merchantId,
                orderId: order.id,
                eventType: courierEventType(body.eventType),
                status: mappedStatus,
                metadata: { externalId: body.externalId, eventType: body.eventType }
            }, tx);
        }
        if (!order) {
            await logOperationalEvent({
                eventType: courierEventType(body.eventType),
                status: "webhook_order_unmatched",
                severity: "MEDIUM",
                metadata: { externalId: body.externalId, eventType: body.eventType }
            }, tx);
            await createSlaBreach({
                breachType: "WEBHOOK_DELAYED",
                severity: "MEDIUM",
                metadata: { reason: "Carrier webhook did not match an order", externalId: body.externalId }
            }, tx);
        }
        return { event, ndrEvent };
    });
    if (order && mappedStatus === "NDR" && result.ndrEvent) {
        const automationEvent = buildNdrRecoveryAutomationEvent({
            merchantId: order.merchantId,
            orderId: order.id,
            externalOrderId: order.externalOrderId,
            shipmentId: typeof body.shipmentId === "string" ? body.shipmentId : undefined,
            awb: body.awbNumber,
            trackingNumber: body.trackingNumber,
            ndrEventId: result.ndrEvent.id,
            courierPartnerId: typeof body.courierId === "string" ? body.courierId : undefined,
            courierPartnerName: typeof body.courierName === "string"
                ? body.courierName
                : typeof body.courierPartnerName === "string"
                    ? body.courierPartnerName
                    : undefined,
            buyerName: order.buyerName,
            buyerPhone: order.buyerPhone,
            ndrReason: ndrReasonFromPayload(body),
            attemptCount: typeof body.attemptCount === "number" ? body.attemptCount : undefined,
            city: order.city,
            state: order.state,
            pincode: order.pincode
        });
        void emitAutomationEvent(automationEvent).catch((error) => prisma.auditLog.create({
            data: {
                merchantId: order.merchantId,
                action: "automation.ndr_event_emit_failed",
                entityType: "NdrEvent",
                entityId: result.ndrEvent?.id || null,
                metadata: {
                    error: error instanceof Error ? error.message : "Unknown automation event failure",
                    eventKey: "shipment.ndr_created"
                }
            }
        }).catch(() => undefined));
    }
    if (order?.merchant?.email && mappedStatus) {
        const awbNumber = body.awbNumber || body.trackingNumber || body.externalId;
        const latestEvent = body.latestEvent || body.description || body.eventType;
        const template = mappedStatus === "NDR"
            ? emailTemplates.ndrUpdate({
                orderId: order.externalOrderId,
                awbNumber,
                latestEvent,
                trackingUrl: trackingUrl(awbNumber)
            })
            : emailTemplates.shipmentStatusUpdate({
                orderId: order.externalOrderId,
                awbNumber,
                currentStatus: mappedStatus,
                latestEvent,
                trackingUrl: trackingUrl(awbNumber)
            });
        await sendTransactionalEmail({
            to: order.merchant.email,
            type: mappedStatus === "NDR" ? "ndr-update" : "shipment-status-update",
            metadata: {
                merchantId: order.merchantId,
                orderId: order.externalOrderId,
                awbNumber,
                status: mappedStatus,
                eventType: body.eventType
            },
            ...template
        });
    }
    res.json({
        ok: true,
        eventId: result.event.id,
        status: mappedStatus ?? null,
        orderMatched: Boolean(order)
    });
});
//# sourceMappingURL=webhooks.routes.js.map