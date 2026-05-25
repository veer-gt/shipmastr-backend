import { AutomationEventStatus, type Prisma } from "@prisma/client";
import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";

export const UNIVERSAL_AUTOMATION_EVENTS = [
  "merchant.created",
  "merchant.kyc.approved",
  "store.created",
  "store.domain.connected",
  "product.created",
  "product.low_stock",
  "cart.abandoned",
  "checkout.started",
  "order.created",
  "order.cod_risk_high",
  "order.address_confirmation_required",
  "order.confirmed",
  "shipment.booked",
  "shipment.awb_assigned",
  "shipment.pickup_scheduled",
  "shipment.pickup_failed",
  "courier.pickup_delay_detected",
  "courier.pickup_missed",
  "courier.pickup_failed",
  "courier.pickup_escalated",
  "courier.pickup_resolved",
  "courier.sla_breach_detected",
  "courier.pickup_sla_breach",
  "courier.first_scan_sla_breach",
  "courier.in_transit_sla_breach",
  "courier.ofd_sla_breach",
  "courier.ndr_response_sla_breach",
  "courier.reattempt_sla_breach",
  "courier.rto_sla_breach",
  "courier.cod_remittance_sla_breach",
  "courier.sla_breach_escalated",
  "courier.sla_breach_resolved",
  "courier.fake_scan_suspected",
  "courier.pickup_scan_suspected_fake",
  "courier.delivery_attempt_suspected_fake",
  "courier.ndr_scan_suspected_fake",
  "courier.late_scan_detected",
  "courier.impossible_scan_sequence",
  "courier.scan_location_mismatch",
  "courier.duplicate_scan_pattern",
  "courier.scan_after_terminal_state",
  "courier.scan_anomaly_escalated",
  "courier.scan_anomaly_resolved",
  "courier.scan_anomaly_dismissed",
  "shipment.in_transit",
  "shipment.out_for_delivery",
  "shipment.delivered",
  "shipment.ndr_created",
  "shipment.reattempt_requested",
  "shipment.rto_initiated",
  "shipment.rto_delivered",
  "cod.remittance_due",
  "cod.remittance_delayed",
  "cod.remittance_settled",
  "cod.remittance_mismatch_detected",
  "seller.settlement_generated",
  "seller.settlement_scheduled",
  "seller.settlement_paid",
  "seller.settlement_held",
  "seller.settlement_adjusted",
  "settlement.created",
  "settlement.paid",
  "invoice.uploaded",
  "invoice.mismatch_detected",
  "invoice.duplicate_awb_charge_detected",
  "invoice.weight_discrepancy_detected",
  "invoice.zone_mismatch_detected",
  "invoice.rto_charge_mismatch_detected",
  "invoice.cod_fee_mismatch_detected",
  "invoice.resolved",
  "invoice.dispute_created",
  "campaign.created",
  "campaign.sent",
  "campaign.clicked",
  "campaign.converted",
  "buyer.repeat_purchase_due",
  "support.message_received",
  "support.ticket_created",
  "courier.sla_breach",
  "courier.fake_scan_suspected",
  "platform.workflow.failed",
  "platform.deploy.build_alert",
  "platform.health.digest",
  "courier.sla_escalation",
  "merchant.automation.paused",
  "merchant.automation.resumed",
  "ops.pickup_failure.queue",
  "ops.ndr_rescue.queue",
  "ops.courier_escalation.ticket",
  "ops.fake_scan.review",
  "ops.daily_digest",
  "finance.payment_hold.ticket",
  "finance.dispute.ticket",
  "courier.pickup.assignment",
  "courier.pickup.delay",
  "courier.ndr_buyer_instruction",
  "courier.sla_breach_warning",
  "courier.cod_remittance.reminder",
  "merchant.daily_digest",
  "merchant.channel_test",
  "cod.settlement.update",
  "buyer.order_confirmation",
  "buyer.address_confirmation",
  "buyer.shipment_update",
  "buyer.out_for_delivery",
  "buyer.ndr_action",
  "buyer.feedback_request"
] as const;

export type AutomationEventKey = (typeof UNIVERSAL_AUTOMATION_EVENTS)[number];

type JsonMap = Prisma.JsonObject;

export type EmitAutomationEventInput = {
  merchantId: string;
  eventKey: AutomationEventKey | string;
  payload?: JsonMap | undefined;
  source?: string | undefined;
  sourceId?: string | undefined;
  idempotencyKey?: string | undefined;
};

export type RenderTemplateInput = {
  merchantId: string;
  templateKey: string;
  channel: string;
  variables?: JsonMap | undefined;
};

export type LogCommunicationInput = {
  merchantId: string;
  eventId?: string | undefined;
  campaignId?: string | undefined;
  idempotencyKey?: string | undefined;
  channel: string;
  recipient: string;
  templateKey?: string | undefined;
  status?: string | undefined;
  renderedMessage?: string | undefined;
  provider?: string | undefined;
  providerMessageId?: string | undefined;
  metadata?: JsonMap | undefined;
};

export type AutomationChannelResultInput = {
  channel: string;
  provider?: string | undefined;
  providerMessageId?: string | undefined;
  sender?: string | undefined;
  replyTo?: string | undefined;
  recipient?: string | undefined;
  status: string;
  skipReason?: string | undefined;
  error?: string | undefined;
  metadata?: JsonMap | undefined;
};

export type AutomationCallbackInput = {
  eventId: string;
  merchantId?: string | undefined;
  status: "PROCESSED" | "FAILED";
  result?: JsonMap | undefined;
  error?: string | undefined;
  communication?: LogCommunicationInput | undefined;
  communications?: LogCommunicationInput[] | undefined;
  channelResults?: AutomationChannelResultInput[] | undefined;
};

export type WhatsappProviderCallbackInput = {
  providerMessageId: string;
  merchantId?: string | undefined;
  provider?: string | undefined;
  status?: string | undefined;
  eventType?: string | undefined;
  sender?: string | undefined;
  recipient?: string | undefined;
  templateKey?: string | undefined;
  failureReason?: string | undefined;
  buyerMessage?: string | undefined;
  metadata?: JsonMap | undefined;
};

export class AutomationCallbackError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const DEFAULT_WORKFLOWS = [
  "SM_ORDER_CREATED",
  "SM_COD_RISK_HIGH",
  "SM_ADDRESS_CONFIRMATION",
  "SM_14_NDR_RECOVERY",
  "SM_NDR_RECOVERY",
  "SM_20_ABANDONED_CHECKOUT",
  "SM_21_REPEAT_BUYER",
  "SM_ABANDONED_CHECKOUT",
  "SM_REPEAT_BUYER",
  "SM_PRODUCT_LAUNCH",
  "SM_COURIER_PICKUP_DELAY",
  "SM_30_COURIER_PICKUP_DELAY",
  "SM_31_COURIER_SLA_BREACH",
  "SM_32_FAKE_SCAN_REVIEW",
  "SM_33_COURIER_DAILY_DIGEST",
  "SM_COURIER_SLA_BREACH",
  "SM_40_COD_REMITTANCE_ALERT",
  "SM_41_SELLER_SETTLEMENT_SUMMARY",
  "SM_COD_REMITTANCE_DUE",
  "SM_42_INVOICE_MISMATCH",
  "SM_INVOICE_MISMATCH",
  "SM_SUPPORT_TRIAGE",
  "SM_60_MERCHANT_DAILY_DIGEST",
  "SM_CHANNEL_TEST",
  "SM_LOW_STOCK",
  "SM_COD_SETTLEMENT_UPDATE",
  "SM_BUYER_ORDER_CONFIRMATION",
  "SM_BUYER_ADDRESS_CONFIRMATION",
  "SM_BUYER_SHIPMENT_UPDATE",
  "SM_BUYER_OUT_FOR_DELIVERY",
  "SM_BUYER_NDR_ACTION",
  "SM_BUYER_FEEDBACK_REQUEST"
];

const WORKFLOW_BY_EVENT: Record<string, string> = {
  "order.created": "SM_ORDER_CREATED",
  "order.cod_risk_high": "SM_COD_RISK_HIGH",
  "order.address_confirmation_required": "SM_ADDRESS_CONFIRMATION",
  "shipment.ndr_created": "SM_14_NDR_RECOVERY",
  "shipment.pickup_failed": "SM_COURIER_PICKUP_DELAY",
  "courier.pickup_delay_detected": "SM_30_COURIER_PICKUP_DELAY",
  "courier.pickup_missed": "SM_30_COURIER_PICKUP_DELAY",
  "courier.pickup_failed": "SM_30_COURIER_PICKUP_DELAY",
  "courier.pickup_escalated": "SM_30_COURIER_PICKUP_DELAY",
  "courier.pickup_resolved": "SM_30_COURIER_PICKUP_DELAY",
  "courier.sla_breach_detected": "SM_31_COURIER_SLA_BREACH",
  "courier.pickup_sla_breach": "SM_31_COURIER_SLA_BREACH",
  "courier.first_scan_sla_breach": "SM_31_COURIER_SLA_BREACH",
  "courier.in_transit_sla_breach": "SM_31_COURIER_SLA_BREACH",
  "courier.ofd_sla_breach": "SM_31_COURIER_SLA_BREACH",
  "courier.ndr_response_sla_breach": "SM_31_COURIER_SLA_BREACH",
  "courier.reattempt_sla_breach": "SM_31_COURIER_SLA_BREACH",
  "courier.rto_sla_breach": "SM_31_COURIER_SLA_BREACH",
  "courier.cod_remittance_sla_breach": "SM_31_COURIER_SLA_BREACH",
  "courier.sla_breach_escalated": "SM_31_COURIER_SLA_BREACH",
  "courier.sla_breach_resolved": "SM_31_COURIER_SLA_BREACH",
  "cart.abandoned": "SM_20_ABANDONED_CHECKOUT",
  "buyer.repeat_purchase_due": "SM_21_REPEAT_BUYER",
  "campaign.created": "SM_PRODUCT_LAUNCH",
  "courier.sla_breach": "SM_COURIER_SLA_BREACH",
  "courier.fake_scan_suspected": "SM_32_FAKE_SCAN_REVIEW",
  "courier.pickup_scan_suspected_fake": "SM_32_FAKE_SCAN_REVIEW",
  "courier.delivery_attempt_suspected_fake": "SM_32_FAKE_SCAN_REVIEW",
  "courier.ndr_scan_suspected_fake": "SM_32_FAKE_SCAN_REVIEW",
  "courier.late_scan_detected": "SM_32_FAKE_SCAN_REVIEW",
  "courier.impossible_scan_sequence": "SM_32_FAKE_SCAN_REVIEW",
  "courier.scan_location_mismatch": "SM_32_FAKE_SCAN_REVIEW",
  "courier.duplicate_scan_pattern": "SM_32_FAKE_SCAN_REVIEW",
  "courier.scan_after_terminal_state": "SM_32_FAKE_SCAN_REVIEW",
  "courier.scan_anomaly_escalated": "SM_32_FAKE_SCAN_REVIEW",
  "courier.scan_anomaly_resolved": "SM_32_FAKE_SCAN_REVIEW",
  "courier.scan_anomaly_dismissed": "SM_32_FAKE_SCAN_REVIEW",
  "courier.daily_digest_due": "SM_33_COURIER_DAILY_DIGEST",
  "courier.daily_digest_generated": "SM_33_COURIER_DAILY_DIGEST",
  "courier.daily_digest_failed": "SM_33_COURIER_DAILY_DIGEST",
  "courier.daily_digest_sent": "SM_33_COURIER_DAILY_DIGEST",
  "courier.ops_daily_digest_due": "SM_33_COURIER_DAILY_DIGEST",
  "courier.partner_daily_digest_due": "SM_33_COURIER_DAILY_DIGEST",
  "cod.remittance_due": "SM_40_COD_REMITTANCE_ALERT",
  "cod.remittance_delayed": "SM_40_COD_REMITTANCE_ALERT",
  "cod.remittance_settled": "SM_40_COD_REMITTANCE_ALERT",
  "cod.remittance_mismatch_detected": "SM_40_COD_REMITTANCE_ALERT",
  "seller.settlement_generated": "SM_41_SELLER_SETTLEMENT_SUMMARY",
  "seller.settlement_scheduled": "SM_41_SELLER_SETTLEMENT_SUMMARY",
  "seller.settlement_paid": "SM_41_SELLER_SETTLEMENT_SUMMARY",
  "seller.settlement_held": "SM_41_SELLER_SETTLEMENT_SUMMARY",
  "seller.settlement_adjusted": "SM_41_SELLER_SETTLEMENT_SUMMARY",
  "invoice.mismatch_detected": "SM_42_INVOICE_MISMATCH",
  "invoice.duplicate_awb_charge_detected": "SM_42_INVOICE_MISMATCH",
  "invoice.weight_discrepancy_detected": "SM_42_INVOICE_MISMATCH",
  "invoice.zone_mismatch_detected": "SM_42_INVOICE_MISMATCH",
  "invoice.rto_charge_mismatch_detected": "SM_42_INVOICE_MISMATCH",
  "invoice.cod_fee_mismatch_detected": "SM_42_INVOICE_MISMATCH",
  "invoice.resolved": "SM_42_INVOICE_MISMATCH",
  "invoice.dispute_created": "SM_42_INVOICE_MISMATCH",
  "support.message_received": "SM_SUPPORT_TRIAGE",
  "product.low_stock": "SM_LOW_STOCK",
  "merchant.daily_digest": "SM_60_MERCHANT_DAILY_DIGEST",
  "merchant.channel_test": "SM_CHANNEL_TEST",
  "cod.settlement.update": "SM_COD_SETTLEMENT_UPDATE",
  "buyer.order_confirmation": "SM_BUYER_ORDER_CONFIRMATION",
  "buyer.address_confirmation": "SM_BUYER_ADDRESS_CONFIRMATION",
  "buyer.shipment_update": "SM_BUYER_SHIPMENT_UPDATE",
  "buyer.out_for_delivery": "SM_BUYER_OUT_FOR_DELIVERY",
  "buyer.ndr_action": "SM_BUYER_NDR_ACTION",
  "buyer.feedback_request": "SM_BUYER_FEEDBACK_REQUEST",
  "platform.workflow.failed": "SM_MASTER_FAILED_WORKFLOW_ALERT",
  "platform.deploy.build_alert": "SM_MASTER_DEPLOY_BUILD_ALERT",
  "platform.health.digest": "SM_MASTER_PLATFORM_HEALTH_DIGEST",
  "courier.sla_escalation": "SM_MASTER_COURIER_SLA_ESCALATION",
  "merchant.automation.paused": "SM_MASTER_MERCHANT_AUTOMATION_PAUSE_RESUME_ALERT",
  "merchant.automation.resumed": "SM_MASTER_MERCHANT_AUTOMATION_PAUSE_RESUME_ALERT",
  "ops.pickup_failure.queue": "SM_OPS_PICKUP_FAILURE_QUEUE",
  "ops.ndr_rescue.queue": "SM_OPS_NDR_RESCUE_QUEUE",
  "ops.courier_escalation.ticket": "SM_OPS_COURIER_ESCALATION_TICKET",
  "ops.fake_scan.review": "SM_OPS_FAKE_SCAN_REVIEW",
  "ops.daily_digest": "SM_OPS_DAILY_DIGEST",
  "settlement.created": "SM_FINANCE_SETTLEMENT_GENERATED",
  "finance.payment_hold.ticket": "SM_FINANCE_PAYMENT_HOLD_DISPUTE_TICKET",
  "finance.dispute.ticket": "SM_FINANCE_PAYMENT_HOLD_DISPUTE_TICKET",
  "courier.pickup.assignment": "SM_COURIER_PICKUP_ASSIGNMENT",
  "courier.pickup.delay": "SM_COURIER_PICKUP_DELAY",
  "courier.ndr_buyer_instruction": "SM_COURIER_NDR_BUYER_INSTRUCTION",
  "courier.sla_breach_warning": "SM_COURIER_SLA_BREACH_WARNING",
  "courier.cod_remittance.reminder": "SM_COURIER_COD_REMITTANCE_REMINDER"
};

const VERSIONED_TEMPLATE_BY_EVENT: Record<string, Record<string, string>> = {
  "order.cod_risk_high": {
    cod_risk_high: "cod_risk_high_v1"
  },
  "order.address_confirmation_required": {
    address_confirmation: "address_confirmation_v1"
  },
  "shipment.ndr_created": {
    ndr_recovery: "ndr_recovery_v1"
  },
  "merchant.daily_digest": {
    merchant_daily_digest: "merchant_daily_digest_v1"
  },
  "cart.abandoned": {
    abandoned_checkout: "abandoned_checkout_v1"
  },
  "buyer.repeat_purchase_due": {
    repeat_buyer: "repeat_buyer_v1"
  },
  "cod.remittance_due": {
    cod_remittance_due: "cod_remittance_due_v1"
  },
  "cod.remittance_delayed": {
    cod_remittance_delayed: "cod_remittance_delayed_v1"
  },
  "cod.remittance_settled": {
    cod_remittance_settled: "cod_remittance_settled_v1"
  },
  "cod.remittance_mismatch_detected": {
    cod_remittance_mismatch: "cod_remittance_mismatch_v1"
  },
  "seller.settlement_generated": {
    seller_settlement_generated: "seller_settlement_generated_v1"
  },
  "seller.settlement_scheduled": {
    seller_settlement_scheduled: "seller_settlement_scheduled_v1"
  },
  "seller.settlement_paid": {
    seller_settlement_paid: "seller_settlement_paid_v1"
  },
  "seller.settlement_held": {
    seller_settlement_held: "seller_settlement_held_v1"
  },
  "seller.settlement_adjusted": {
    seller_settlement_adjusted: "seller_settlement_adjusted_v1"
  },
  "invoice.mismatch_detected": {
    invoice_mismatch_detected: "invoice_mismatch_detected_v1"
  },
  "invoice.duplicate_awb_charge_detected": {
    invoice_duplicate_awb_charge: "invoice_duplicate_awb_charge_v1"
  },
  "invoice.weight_discrepancy_detected": {
    invoice_weight_discrepancy: "invoice_weight_discrepancy_v1"
  },
  "invoice.zone_mismatch_detected": {
    invoice_zone_mismatch: "invoice_zone_mismatch_v1"
  },
  "invoice.rto_charge_mismatch_detected": {
    invoice_rto_charge_mismatch: "invoice_rto_charge_mismatch_v1"
  },
  "invoice.cod_fee_mismatch_detected": {
    invoice_cod_fee_mismatch: "invoice_cod_fee_mismatch_v1"
  },
  "invoice.dispute_created": {
    invoice_dispute_created: "invoice_dispute_created_v1"
  },
  "invoice.resolved": {
    invoice_resolved: "invoice_resolved_v1"
  },
  "courier.pickup_delay_detected": {
    courier_pickup_delay: "courier_pickup_delay_v1"
  },
  "courier.pickup_missed": {
    courier_pickup_missed: "courier_pickup_missed_v1"
  },
  "courier.pickup_failed": {
    courier_pickup_failed: "courier_pickup_failed_v1"
  },
  "courier.pickup_escalated": {
    courier_pickup_escalated: "courier_pickup_escalated_v1"
  },
  "courier.pickup_resolved": {
    courier_pickup_resolved: "courier_pickup_resolved_v1"
  },
  "courier.sla_breach_detected": {
    courier_sla_breach: "courier_sla_breach_v1"
  },
  "courier.pickup_sla_breach": {
    courier_pickup_sla_breach: "courier_pickup_sla_breach_v1"
  },
  "courier.first_scan_sla_breach": {
    courier_first_scan_sla_breach: "courier_first_scan_sla_breach_v1"
  },
  "courier.in_transit_sla_breach": {
    courier_in_transit_sla_breach: "courier_in_transit_sla_breach_v1"
  },
  "courier.ofd_sla_breach": {
    courier_ofd_sla_breach: "courier_ofd_sla_breach_v1"
  },
  "courier.ndr_response_sla_breach": {
    courier_ndr_response_sla_breach: "courier_ndr_response_sla_breach_v1"
  },
  "courier.reattempt_sla_breach": {
    courier_reattempt_sla_breach: "courier_reattempt_sla_breach_v1"
  },
  "courier.rto_sla_breach": {
    courier_rto_sla_breach: "courier_rto_sla_breach_v1"
  },
  "courier.cod_remittance_sla_breach": {
    courier_cod_remittance_sla_breach: "courier_cod_remittance_sla_breach_v1"
  },
  "courier.sla_breach_escalated": {
    courier_sla_breach_escalated: "courier_sla_breach_escalated_v1"
  },
  "courier.sla_breach_resolved": {
    courier_sla_breach_resolved: "courier_sla_breach_resolved_v1"
  },
  "courier.fake_scan_suspected": {
    fake_scan_review: "fake_scan_review_v1"
  },
  "courier.pickup_scan_suspected_fake": {
    fake_pickup_scan: "fake_pickup_scan_v1"
  },
  "courier.delivery_attempt_suspected_fake": {
    fake_delivery_attempt: "fake_delivery_attempt_v1"
  },
  "courier.ndr_scan_suspected_fake": {
    fake_ndr_scan: "fake_ndr_scan_v1"
  },
  "courier.late_scan_detected": {
    late_scan_detected: "late_scan_detected_v1"
  },
  "courier.impossible_scan_sequence": {
    impossible_scan_sequence: "impossible_scan_sequence_v1"
  },
  "courier.scan_location_mismatch": {
    scan_location_mismatch: "scan_location_mismatch_v1"
  },
  "courier.duplicate_scan_pattern": {
    duplicate_scan_pattern: "duplicate_scan_pattern_v1"
  },
  "courier.scan_after_terminal_state": {
    scan_after_terminal_state: "scan_after_terminal_state_v1"
  },
  "courier.scan_anomaly_escalated": {
    scan_anomaly_escalated: "scan_anomaly_escalated_v1"
  },
  "courier.scan_anomaly_resolved": {
    scan_anomaly_resolved: "scan_anomaly_resolved_v1"
  },
  "courier.scan_anomaly_dismissed": {
    scan_anomaly_dismissed: "scan_anomaly_dismissed_v1"
  },
  "courier.daily_digest_due": {
    courier_daily_digest: "courier_daily_digest_v1"
  },
  "courier.daily_digest_generated": {
    courier_daily_digest: "courier_daily_digest_v1"
  },
  "courier.daily_digest_failed": {
    courier_daily_digest: "courier_daily_digest_v1"
  },
  "courier.daily_digest_sent": {
    courier_daily_digest: "courier_daily_digest_v1"
  },
  "courier.ops_daily_digest_due": {
    courier_ops_daily_digest: "courier_ops_daily_digest_v1"
  },
  "courier.partner_daily_digest_due": {
    courier_partner_daily_digest: "courier_partner_daily_digest_v1"
  }
};

function normalizeCallbackTemplateKey(eventKey: string, templateKey?: string) {
  if (!templateKey) return templateKey;
  return VERSIONED_TEMPLATE_BY_EVENT[eventKey]?.[templateKey] || templateKey;
}

type AutomationActorType =
  | "MASTER_ADMIN"
  | "ADMIN_OPS"
  | "FINANCE_ADMIN"
  | "COURIER_PARTNER"
  | "MERCHANT_SELLER"
  | "BUYER_CONSIGNEE"
  | "INTERNAL_SYSTEM";

type WorkflowScope = {
  actorType: AutomationActorType;
  permissionScope: string;
  category: string;
};

const INTERNAL_WORKFLOW_SCOPE: WorkflowScope = {
  actorType: "INTERNAL_SYSTEM",
  permissionScope: "automation:internal:event-router",
  category: "data_syncing"
};

const WORKFLOW_SCOPE_BY_KEY: Record<string, WorkflowScope> = {
  SM_MASTER_FAILED_WORKFLOW_ALERT: { actorType: "MASTER_ADMIN", permissionScope: "automation:master-admin:incident", category: "incident_response" },
  SM_MASTER_DEPLOY_BUILD_ALERT: { actorType: "MASTER_ADMIN", permissionScope: "automation:master-admin:cicd", category: "ci_cd" },
  SM_MASTER_PLATFORM_HEALTH_DIGEST: { actorType: "MASTER_ADMIN", permissionScope: "automation:master-admin:monitoring", category: "monitoring_alerting" },
  SM_MASTER_COURIER_SLA_ESCALATION: { actorType: "MASTER_ADMIN", permissionScope: "automation:master-admin:courier-escalation", category: "commerce_logistics" },
  SM_MASTER_MERCHANT_AUTOMATION_PAUSE_RESUME_ALERT: { actorType: "MASTER_ADMIN", permissionScope: "automation:master-admin:merchant-controls", category: "incident_response" },
  SM_OPS_PICKUP_FAILURE_QUEUE: { actorType: "ADMIN_OPS", permissionScope: "automation:ops:pickup", category: "ticketing" },
  SM_OPS_NDR_RESCUE_QUEUE: { actorType: "ADMIN_OPS", permissionScope: "automation:ops:ndr", category: "ticketing" },
  SM_OPS_COURIER_ESCALATION_TICKET: { actorType: "ADMIN_OPS", permissionScope: "automation:ops:courier-escalation", category: "ticketing" },
  SM_OPS_FAKE_SCAN_REVIEW: { actorType: "ADMIN_OPS", permissionScope: "automation:ops:fake-scan", category: "incident_response" },
  SM_OPS_DAILY_DIGEST: { actorType: "ADMIN_OPS", permissionScope: "automation:ops:reporting", category: "reporting" },
  SM_FINANCE_SETTLEMENT_GENERATED: { actorType: "FINANCE_ADMIN", permissionScope: "automation:finance:settlement", category: "reporting" },
  SM_FINANCE_PAYMENT_HOLD_DISPUTE_TICKET: { actorType: "FINANCE_ADMIN", permissionScope: "automation:finance:dispute", category: "ticketing" },
  SM_40_COD_REMITTANCE_ALERT: { actorType: "MERCHANT_SELLER", permissionScope: "automation:merchant:finance", category: "reporting" },
  SM_41_SELLER_SETTLEMENT_SUMMARY: { actorType: "MERCHANT_SELLER", permissionScope: "automation:merchant:finance", category: "reporting" },
  SM_COD_REMITTANCE_DUE: { actorType: "FINANCE_ADMIN", permissionScope: "automation:finance:cod-remittance", category: "commerce_logistics" },
  SM_42_INVOICE_MISMATCH: { actorType: "FINANCE_ADMIN", permissionScope: "automation:finance:invoice", category: "ticketing" },
  SM_INVOICE_MISMATCH: { actorType: "FINANCE_ADMIN", permissionScope: "automation:finance:invoice", category: "ticketing" },
  SM_30_COURIER_PICKUP_DELAY: { actorType: "ADMIN_OPS", permissionScope: "automation:ops:courier-pickup-delay", category: "monitoring_alerting" },
  SM_31_COURIER_SLA_BREACH: { actorType: "ADMIN_OPS", permissionScope: "automation:ops:courier-sla-breach", category: "monitoring_alerting" },
  SM_32_FAKE_SCAN_REVIEW: { actorType: "ADMIN_OPS", permissionScope: "automation:ops:fake-scan", category: "incident_response" },
  SM_33_COURIER_DAILY_DIGEST: { actorType: "ADMIN_OPS", permissionScope: "automation:ops:courier-daily-digest", category: "reporting" },
  SM_COURIER_PICKUP_ASSIGNMENT: { actorType: "COURIER_PARTNER", permissionScope: "automation:courier:pickup", category: "commerce_logistics" },
  SM_COURIER_PICKUP_DELAY: { actorType: "COURIER_PARTNER", permissionScope: "automation:courier:pickup-delay", category: "monitoring_alerting" },
  SM_COURIER_NDR_BUYER_INSTRUCTION: { actorType: "COURIER_PARTNER", permissionScope: "automation:courier:ndr", category: "commerce_logistics" },
  SM_COURIER_SLA_BREACH_WARNING: { actorType: "COURIER_PARTNER", permissionScope: "automation:courier:sla", category: "monitoring_alerting" },
  SM_COURIER_COD_REMITTANCE_REMINDER: { actorType: "COURIER_PARTNER", permissionScope: "automation:courier:cod-remittance", category: "commerce_logistics" },
  SM_ORDER_CREATED: { actorType: "MERCHANT_SELLER", permissionScope: "automation:merchant:order-notification", category: "commerce_logistics" },
  SM_COD_RISK_HIGH: { actorType: "MERCHANT_SELLER", permissionScope: "automation:merchant:cod-shield", category: "commerce_logistics" },
  SM_ADDRESS_CONFIRMATION: { actorType: "MERCHANT_SELLER", permissionScope: "automation:merchant:cod-shield", category: "commerce_logistics" },
  SM_14_NDR_RECOVERY: { actorType: "MERCHANT_SELLER", permissionScope: "automation:merchant:ndr-rescue", category: "commerce_logistics" },
  SM_NDR_RECOVERY: { actorType: "MERCHANT_SELLER", permissionScope: "automation:merchant:ndr-rescue", category: "commerce_logistics" },
  SM_20_ABANDONED_CHECKOUT: { actorType: "MERCHANT_SELLER", permissionScope: "automation:merchant:marketing", category: "commerce_marketing" },
  SM_21_REPEAT_BUYER: { actorType: "MERCHANT_SELLER", permissionScope: "automation:merchant:marketing", category: "commerce_marketing" },
  SM_ABANDONED_CHECKOUT: { actorType: "MERCHANT_SELLER", permissionScope: "automation:merchant:marketing", category: "commerce_marketing" },
  SM_CHANNEL_TEST: { actorType: "MERCHANT_SELLER", permissionScope: "automation:merchant:channel-test", category: "monitoring_alerting" },
  SM_REPEAT_BUYER: { actorType: "MERCHANT_SELLER", permissionScope: "automation:merchant:marketing", category: "commerce_marketing" },
  SM_PRODUCT_LAUNCH: { actorType: "MERCHANT_SELLER", permissionScope: "automation:merchant:marketing", category: "commerce_marketing" },
  SM_LOW_STOCK: { actorType: "MERCHANT_SELLER", permissionScope: "automation:merchant:inventory", category: "monitoring_alerting" },
  SM_60_MERCHANT_DAILY_DIGEST: { actorType: "MERCHANT_SELLER", permissionScope: "automation:merchant:reporting", category: "reporting" },
  SM_MERCHANT_DAILY_DIGEST: { actorType: "MERCHANT_SELLER", permissionScope: "automation:merchant:reporting", category: "reporting" },
  SM_COD_SETTLEMENT_UPDATE: { actorType: "MERCHANT_SELLER", permissionScope: "automation:merchant:finance", category: "reporting" },
  SM_BUYER_ORDER_CONFIRMATION: { actorType: "BUYER_CONSIGNEE", permissionScope: "automation:buyer:transactional", category: "commerce_logistics" },
  SM_BUYER_ADDRESS_CONFIRMATION: { actorType: "BUYER_CONSIGNEE", permissionScope: "automation:buyer:transactional", category: "commerce_logistics" },
  SM_BUYER_SHIPMENT_UPDATE: { actorType: "BUYER_CONSIGNEE", permissionScope: "automation:buyer:transactional", category: "commerce_logistics" },
  SM_BUYER_OUT_FOR_DELIVERY: { actorType: "BUYER_CONSIGNEE", permissionScope: "automation:buyer:transactional", category: "commerce_logistics" },
  SM_BUYER_NDR_ACTION: { actorType: "BUYER_CONSIGNEE", permissionScope: "automation:buyer:transactional", category: "commerce_logistics" },
  SM_BUYER_FEEDBACK_REQUEST: { actorType: "BUYER_CONSIGNEE", permissionScope: "automation:buyer:feedback", category: "commerce_logistics" },
  SM_SUPPORT_TRIAGE: { actorType: "ADMIN_OPS", permissionScope: "automation:ops:support", category: "ticketing" },
  SM_01_EVENT_ROUTER: INTERNAL_WORKFLOW_SCOPE
};

const MARKETING_EVENT_KEYS = new Set([
  "cart.abandoned",
  "campaign.created",
  "campaign.sent",
  "campaign.clicked",
  "campaign.converted",
  "buyer.repeat_purchase_due"
]);

const MARKETING_WORKFLOWS = new Set([
  "SM_20_ABANDONED_CHECKOUT",
  "SM_21_REPEAT_BUYER",
  "SM_ABANDONED_CHECKOUT",
  "SM_REPEAT_BUYER",
  "SM_PRODUCT_LAUNCH"
]);

const MESSAGE_SENT_STATUSES = new Set(["SENT", "DELIVERED", "READ", "RESPONDED"]);
const DAILY_DIGEST_FROM_EMAIL = "noreply@shipmastr.com";
const ABANDONED_CHECKOUT_TEMPLATE_KEY = "abandoned_checkout_v1";
const REPEAT_BUYER_TEMPLATE_KEY = "repeat_buyer_v1";
const CHANNEL_TEST_TEMPLATE_KEY = "channel_test_v1";
const COD_REMITTANCE_WORKFLOW_KEY = "SM_40_COD_REMITTANCE_ALERT";
const COD_REMITTANCE_EVENT_KEYS = new Set([
  "cod.remittance_due",
  "cod.remittance_delayed",
  "cod.remittance_settled",
  "cod.remittance_mismatch_detected"
]);
const COD_REMITTANCE_TEMPLATE_BY_EVENT: Record<string, string> = {
  "cod.remittance_due": "cod_remittance_due_v1",
  "cod.remittance_delayed": "cod_remittance_delayed_v1",
  "cod.remittance_settled": "cod_remittance_settled_v1",
  "cod.remittance_mismatch_detected": "cod_remittance_mismatch_v1"
};
const SELLER_SETTLEMENT_WORKFLOW_KEY = "SM_41_SELLER_SETTLEMENT_SUMMARY";
const SELLER_SETTLEMENT_EVENT_KEYS = new Set([
  "seller.settlement_generated",
  "seller.settlement_scheduled",
  "seller.settlement_paid",
  "seller.settlement_held",
  "seller.settlement_adjusted"
]);
const SELLER_SETTLEMENT_TEMPLATE_BY_EVENT: Record<string, string> = {
  "seller.settlement_generated": "seller_settlement_generated_v1",
  "seller.settlement_scheduled": "seller_settlement_scheduled_v1",
  "seller.settlement_paid": "seller_settlement_paid_v1",
  "seller.settlement_held": "seller_settlement_held_v1",
  "seller.settlement_adjusted": "seller_settlement_adjusted_v1"
};
const INVOICE_MISMATCH_WORKFLOW_KEY = "SM_42_INVOICE_MISMATCH";
const INVOICE_MISMATCH_EVENT_KEYS = new Set([
  "invoice.mismatch_detected",
  "invoice.duplicate_awb_charge_detected",
  "invoice.weight_discrepancy_detected",
  "invoice.zone_mismatch_detected",
  "invoice.rto_charge_mismatch_detected",
  "invoice.cod_fee_mismatch_detected",
  "invoice.resolved",
  "invoice.dispute_created"
]);
const INVOICE_MISMATCH_TEMPLATE_BY_EVENT: Record<string, string> = {
  "invoice.mismatch_detected": "invoice_mismatch_detected_v1",
  "invoice.duplicate_awb_charge_detected": "invoice_duplicate_awb_charge_v1",
  "invoice.weight_discrepancy_detected": "invoice_weight_discrepancy_v1",
  "invoice.zone_mismatch_detected": "invoice_zone_mismatch_v1",
  "invoice.rto_charge_mismatch_detected": "invoice_rto_charge_mismatch_v1",
  "invoice.cod_fee_mismatch_detected": "invoice_cod_fee_mismatch_v1",
  "invoice.dispute_created": "invoice_dispute_created_v1",
  "invoice.resolved": "invoice_resolved_v1"
};
const COURIER_PICKUP_DELAY_WORKFLOW_KEY = "SM_30_COURIER_PICKUP_DELAY";
const COURIER_PICKUP_DELAY_EVENT_KEYS = new Set([
  "courier.pickup_delay_detected",
  "courier.pickup_missed",
  "courier.pickup_failed",
  "courier.pickup_escalated",
  "courier.pickup_resolved"
]);
const COURIER_PICKUP_DELAY_TEMPLATE_BY_EVENT: Record<string, string> = {
  "courier.pickup_delay_detected": "courier_pickup_delay_v1",
  "courier.pickup_missed": "courier_pickup_missed_v1",
  "courier.pickup_failed": "courier_pickup_failed_v1",
  "courier.pickup_escalated": "courier_pickup_escalated_v1",
  "courier.pickup_resolved": "courier_pickup_resolved_v1"
};
const COURIER_SLA_BREACH_WORKFLOW_KEY = "SM_31_COURIER_SLA_BREACH";
const COURIER_SLA_BREACH_EVENT_KEYS = new Set([
  "courier.sla_breach_detected",
  "courier.pickup_sla_breach",
  "courier.first_scan_sla_breach",
  "courier.in_transit_sla_breach",
  "courier.ofd_sla_breach",
  "courier.ndr_response_sla_breach",
  "courier.reattempt_sla_breach",
  "courier.rto_sla_breach",
  "courier.cod_remittance_sla_breach",
  "courier.sla_breach_escalated",
  "courier.sla_breach_resolved"
]);
const COURIER_SLA_BREACH_TEMPLATE_BY_EVENT: Record<string, string> = {
  "courier.sla_breach_detected": "courier_sla_breach_v1",
  "courier.pickup_sla_breach": "courier_pickup_sla_breach_v1",
  "courier.first_scan_sla_breach": "courier_first_scan_sla_breach_v1",
  "courier.in_transit_sla_breach": "courier_in_transit_sla_breach_v1",
  "courier.ofd_sla_breach": "courier_ofd_sla_breach_v1",
  "courier.ndr_response_sla_breach": "courier_ndr_response_sla_breach_v1",
  "courier.reattempt_sla_breach": "courier_reattempt_sla_breach_v1",
  "courier.rto_sla_breach": "courier_rto_sla_breach_v1",
  "courier.cod_remittance_sla_breach": "courier_cod_remittance_sla_breach_v1",
  "courier.sla_breach_escalated": "courier_sla_breach_escalated_v1",
  "courier.sla_breach_resolved": "courier_sla_breach_resolved_v1"
};
const FAKE_SCAN_REVIEW_WORKFLOW_KEY = "SM_32_FAKE_SCAN_REVIEW";
const FAKE_SCAN_REVIEW_EVENT_KEYS = new Set([
  "courier.fake_scan_suspected",
  "courier.pickup_scan_suspected_fake",
  "courier.delivery_attempt_suspected_fake",
  "courier.ndr_scan_suspected_fake",
  "courier.late_scan_detected",
  "courier.impossible_scan_sequence",
  "courier.scan_location_mismatch",
  "courier.duplicate_scan_pattern",
  "courier.scan_after_terminal_state",
  "courier.scan_anomaly_escalated",
  "courier.scan_anomaly_resolved",
  "courier.scan_anomaly_dismissed"
]);
const FAKE_SCAN_REVIEW_TEMPLATE_BY_EVENT: Record<string, string> = {
  "courier.fake_scan_suspected": "fake_scan_review_v1",
  "courier.pickup_scan_suspected_fake": "fake_pickup_scan_v1",
  "courier.delivery_attempt_suspected_fake": "fake_delivery_attempt_v1",
  "courier.ndr_scan_suspected_fake": "fake_ndr_scan_v1",
  "courier.late_scan_detected": "late_scan_detected_v1",
  "courier.impossible_scan_sequence": "impossible_scan_sequence_v1",
  "courier.scan_location_mismatch": "scan_location_mismatch_v1",
  "courier.duplicate_scan_pattern": "duplicate_scan_pattern_v1",
  "courier.scan_after_terminal_state": "scan_after_terminal_state_v1",
  "courier.scan_anomaly_escalated": "scan_anomaly_escalated_v1",
  "courier.scan_anomaly_resolved": "scan_anomaly_resolved_v1",
  "courier.scan_anomaly_dismissed": "scan_anomaly_dismissed_v1"
};
const COURIER_DAILY_DIGEST_WORKFLOW_KEY = "SM_33_COURIER_DAILY_DIGEST";
const COURIER_DAILY_DIGEST_EVENT_KEYS = new Set([
  "courier.daily_digest_due",
  "courier.daily_digest_generated",
  "courier.daily_digest_failed",
  "courier.daily_digest_sent",
  "courier.ops_daily_digest_due",
  "courier.partner_daily_digest_due"
]);
const COURIER_DAILY_DIGEST_TEMPLATE_BY_EVENT: Record<string, string> = {
  "courier.daily_digest_due": "courier_daily_digest_v1",
  "courier.daily_digest_generated": "courier_daily_digest_v1",
  "courier.daily_digest_failed": "courier_daily_digest_v1",
  "courier.daily_digest_sent": "courier_daily_digest_v1",
  "courier.ops_daily_digest_due": "courier_ops_daily_digest_v1",
  "courier.partner_daily_digest_due": "courier_partner_daily_digest_v1"
};
const SHIPMASTR_FALLBACK_EMAIL = "noreply@shipmastr.com";
const CHANNEL_READY_STATUSES = new Set(["VERIFIED", "ACTIVE"]);
const CHANNEL_STATUSES = new Set(["NOT_CONNECTED", "PENDING_VERIFICATION", "VERIFIED", "FAILED", "DISABLED"]);
const TEMPLATE_STATUSES = new Set(["NOT_CONFIGURED", "PENDING", "APPROVED", "REJECTED"]);
const WHATSAPP_TEMPLATE_KEY_BY_WORKFLOW: Record<string, string> = {
  SM_COD_RISK_HIGH: "cod_risk_high_v1",
  SM_ADDRESS_CONFIRMATION: "address_confirmation_v1",
  SM_14_NDR_RECOVERY: "ndr_recovery_v1",
  SM_NDR_RECOVERY: "ndr_recovery_v1",
  SM_20_ABANDONED_CHECKOUT: ABANDONED_CHECKOUT_TEMPLATE_KEY,
  SM_ABANDONED_CHECKOUT: ABANDONED_CHECKOUT_TEMPLATE_KEY,
  SM_21_REPEAT_BUYER: REPEAT_BUYER_TEMPLATE_KEY,
  SM_REPEAT_BUYER: REPEAT_BUYER_TEMPLATE_KEY
};
const WHATSAPP_TEMPLATE_STATUS_BY_KEY: Record<string, string> = {
  cod_risk_high_v1: "codRisk",
  address_confirmation_v1: "addressConfirmation",
  ndr_recovery_v1: "ndrRecovery",
  abandoned_checkout_v1: "abandonedCheckout",
  repeat_buyer_v1: "repeatBuyer"
};
const WHATSAPP_OPT_OUT_WORDS = new Set(["STOP", "UNSUBSCRIBE", "OPT OUT", "OPTOUT", "CANCEL"]);

function requireMerchantId(merchantId: string) {
  if (!merchantId || !merchantId.trim()) {
    throw new Error("AUTOMATION_EVENT_REQUIRES_MERCHANT_ID");
  }
}

function makeIdempotencyKey(input: EmitAutomationEventInput) {
  return [
    input.source || "shipmastr",
    input.eventKey,
    input.sourceId || input.payload?.id || input.payload?.orderId || input.payload?.awb || Date.now()
  ].join(":");
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60_000);
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
}

function inQuietHours(now: Date, start: string, end: string) {
  const [startHour = "21", startMinute = "0"] = start.split(":");
  const [endHour = "9", endMinute = "0"] = end.split(":");
  const current = now.getHours() * 60 + now.getMinutes();
  const starts = Number(startHour) * 60 + Number(startMinute);
  const ends = Number(endHour) * 60 + Number(endMinute);

  if (starts === ends) return false;
  if (starts < ends) return current >= starts && current < ends;
  return current >= starts || current < ends;
}

function stringifyTemplateValue(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function getMonthKey(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${date.getFullYear()}-${month}`;
}

function getPayloadString(payload: Prisma.JsonValue | null | undefined, keys: string[]) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const source = payload as Record<string, unknown>;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return null;
}

function getMarketingSubject(event: { payload?: Prisma.JsonValue | null; sourceId?: string | null }) {
  return (
    getPayloadString(event.payload, [
      "recipient",
      "buyerPhone",
      "buyerEmail",
      "phone",
      "email",
      "buyerKey",
      "customerId",
      "cartId",
      "orderId"
    ]) ||
    event.sourceId ||
    null
  );
}

function isMarketingAutomation(eventKey: string, workflowKey: string) {
  return MARKETING_EVENT_KEYS.has(eventKey) || MARKETING_WORKFLOWS.has(workflowKey);
}

function isCodShieldAutomation(workflowKey: string) {
  return workflowKey === "SM_COD_RISK_HIGH" || workflowKey === "SM_ADDRESS_CONFIRMATION";
}

function isNdrRescueAutomation(workflowKey: string) {
  return workflowKey === "SM_14_NDR_RECOVERY" || workflowKey === "SM_NDR_RECOVERY";
}

function isMerchantDailyDigestAutomation(workflowKey: string) {
  return workflowKey === "SM_60_MERCHANT_DAILY_DIGEST" || workflowKey === "SM_MERCHANT_DAILY_DIGEST";
}

function isAbandonedCheckoutAutomation(workflowKey: string) {
  return workflowKey === "SM_20_ABANDONED_CHECKOUT" || workflowKey === "SM_ABANDONED_CHECKOUT";
}

function isRepeatBuyerAutomation(workflowKey: string) {
  return workflowKey === "SM_21_REPEAT_BUYER" || workflowKey === "SM_REPEAT_BUYER";
}

function isCodRemittanceAutomation(workflowKey: string) {
  return workflowKey === COD_REMITTANCE_WORKFLOW_KEY;
}

function isSellerSettlementAutomation(workflowKey: string) {
  return workflowKey === SELLER_SETTLEMENT_WORKFLOW_KEY;
}

function isInvoiceMismatchAutomation(workflowKey: string) {
  return workflowKey === INVOICE_MISMATCH_WORKFLOW_KEY || workflowKey === "SM_INVOICE_MISMATCH";
}

function isCourierPickupDelayAutomation(workflowKey: string) {
  return workflowKey === COURIER_PICKUP_DELAY_WORKFLOW_KEY || workflowKey === "SM_COURIER_PICKUP_DELAY";
}

function isCourierSlaBreachAutomation(workflowKey: string) {
  return workflowKey === COURIER_SLA_BREACH_WORKFLOW_KEY || workflowKey === "SM_COURIER_SLA_BREACH";
}

function isFakeScanReviewAutomation(workflowKey: string) {
  return workflowKey === FAKE_SCAN_REVIEW_WORKFLOW_KEY;
}

function isCourierDailyDigestAutomation(workflowKey: string) {
  return workflowKey === COURIER_DAILY_DIGEST_WORKFLOW_KEY;
}

function isControlledGrowthAutomation(workflowKey: string) {
  return isAbandonedCheckoutAutomation(workflowKey) || isRepeatBuyerAutomation(workflowKey);
}

function defaultChannelOrderForWorkflow(workflowKey: string) {
  if (isCourierDailyDigestAutomation(workflowKey)) return ["EMAIL", "WHATSAPP"];
  if (isFakeScanReviewAutomation(workflowKey)) return ["EMAIL", "WHATSAPP"];
  if (isCourierSlaBreachAutomation(workflowKey)) return ["EMAIL", "WHATSAPP"];
  if (isCourierPickupDelayAutomation(workflowKey)) return ["EMAIL", "WHATSAPP"];
  if (isInvoiceMismatchAutomation(workflowKey)) return ["EMAIL", "WHATSAPP"];
  if (isSellerSettlementAutomation(workflowKey)) return ["EMAIL", "WHATSAPP"];
  if (isCodRemittanceAutomation(workflowKey)) return ["EMAIL", "WHATSAPP"];
  if (isControlledGrowthAutomation(workflowKey)) return ["EMAIL", "WHATSAPP"];
  return isMerchantDailyDigestAutomation(workflowKey) ? ["EMAIL"] : ["WHATSAPP", "SMS", "EMAIL"];
}

function getWorkflowScope(workflowKey: string) {
  return WORKFLOW_SCOPE_BY_KEY[workflowKey] || INTERNAL_WORKFLOW_SCOPE;
}

function workflowDispatchUrl(workflowKey: string) {
  if (!env.N8N_AUTOPILOT_WORKFLOW_URLS) return env.N8N_AUTOPILOT_DISPATCH_URL;

  let workflowUrls: unknown;
  try {
    workflowUrls = JSON.parse(env.N8N_AUTOPILOT_WORKFLOW_URLS);
  } catch {
    throw new Error("N8N_AUTOPILOT_WORKFLOW_URLS_INVALID_JSON");
  }

  if (!workflowUrls || typeof workflowUrls !== "object" || Array.isArray(workflowUrls)) {
    throw new Error("N8N_AUTOPILOT_WORKFLOW_URLS_INVALID_MAP");
  }

  const mappedUrl = (workflowUrls as Record<string, unknown>)[workflowKey];
  if (mappedUrl === undefined || mappedUrl === null || mappedUrl === "") {
    return env.N8N_AUTOPILOT_DISPATCH_URL;
  }

  if (typeof mappedUrl !== "string") {
    throw new Error("N8N_AUTOPILOT_WORKFLOW_URL_INVALID");
  }

  try {
    return new URL(mappedUrl).toString();
  } catch {
    throw new Error("N8N_AUTOPILOT_WORKFLOW_URL_INVALID");
  }
}

export function createAutomationSignature(body: string, timestamp: string) {
  const signingSecret = env.N8N_AUTOPILOT_SIGNING_SECRET || env.SHIPMASTR_INTERNAL_SECRET || env.WEBHOOK_SECRET;
  return createHmac("sha256", signingSecret).update(`${timestamp}.${body}`).digest("hex");
}

export function verifyAutomationSignature(input: {
  body: string;
  timestamp?: string | undefined;
  signature?: string | undefined;
  toleranceMs?: number | undefined;
}) {
  if (!input.timestamp || !input.signature) return false;

  const timestampMs = Date.parse(input.timestamp);
  if (!Number.isFinite(timestampMs)) return false;

  const toleranceMs = input.toleranceMs ?? 5 * 60_000;
  if (Math.abs(Date.now() - timestampMs) > toleranceMs) return false;

  const expected = createAutomationSignature(input.body, input.timestamp);
  const expectedBuffer = Buffer.from(expected, "hex");
  const signatureBuffer = Buffer.from(input.signature, "hex");

  return expectedBuffer.length === signatureBuffer.length && timingSafeEqual(expectedBuffer, signatureBuffer);
}

export function verifyWhatsappProviderSignature(input: {
  body: string | Buffer;
  signature?: string | undefined;
}) {
  const signingSecret = env.WHATSAPP_PROVIDER_WEBHOOK_SECRET || env.WEBHOOK_SECRET;
  if (!input.signature || !signingSecret) return false;

  const received = input.signature.replace(/^sha256=/i, "");
  const expected = createHmac("sha256", signingSecret).update(input.body).digest("hex");

  try {
    const expectedBuffer = Buffer.from(expected, "hex");
    const receivedBuffer = Buffer.from(received, "hex");
    return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer);
  } catch {
    return false;
  }
}

function makeCommunicationIdempotencyKey(input: LogCommunicationInput) {
  if (input.idempotencyKey?.trim()) return input.idempotencyKey.trim();
  if (input.provider && input.providerMessageId) return `provider:${input.provider}:${input.providerMessageId}`;
  if (input.providerMessageId) return `provider-message:${input.providerMessageId}`;
  return [
    "communication",
    input.eventId || "no-event",
    input.campaignId || "no-campaign",
    input.channel,
    input.recipient,
    input.templateKey || "no-template"
  ].join(":");
}

async function recordAutomationUsage(input: {
  merchantId: string;
  usageType: "N8N_EXECUTION" | "MESSAGE_ATTEMPT" | "MESSAGE_SENT" | "MESSAGE_FAILED";
  eventKey?: string | undefined;
  workflowKey?: string | undefined;
  channel?: string | undefined;
  count?: number | undefined;
  metadata?: JsonMap | undefined;
}) {
  const monthKey = getMonthKey();
  try {
    await prisma.automationUsageMeter.upsert({
      where: {
        merchantId_monthKey_usageType_eventKey_workflowKey_channel: {
          merchantId: input.merchantId,
          monthKey,
          usageType: input.usageType,
          eventKey: input.eventKey || "ALL",
          workflowKey: input.workflowKey || "ALL",
          channel: input.channel || "ALL"
        }
      },
      create: {
        merchantId: input.merchantId,
        monthKey,
        usageType: input.usageType,
        eventKey: input.eventKey || "ALL",
        workflowKey: input.workflowKey || "ALL",
        channel: input.channel || "ALL",
        count: input.count || 1,
        metadata: toJson(input.metadata)
      },
      update: {
        count: { increment: input.count || 1 },
        metadata: toJson(input.metadata)
      }
    });
  } catch (error) {
    await prisma.auditLog.create({
      data: {
        merchantId: input.merchantId,
        action: "automation.usage_meter_failed",
        entityType: "AutomationUsageMeter",
        metadata: {
          usageType: input.usageType,
          error: error instanceof Error ? error.message : "Unknown usage meter failure"
        }
      }
    }).catch(() => undefined);
  }
}

export async function getMerchantAutomationContext(merchantId: string) {
  requireMerchantId(merchantId);

  const [merchant, preference, workflowSettings, templates, channelCredentials] = await Promise.all([
    prisma.merchant.findUnique({
      where: { id: merchantId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        onboardingStatus: true,
        sellerKycStatus: true,
        adminStatus: true
      }
    }),
    prisma.automationPreference.upsert({
      where: { merchantId },
      create: { merchantId },
      update: {}
    }),
    prisma.automationWorkflowSetting.findMany({
      where: { merchantId },
      orderBy: { key: "asc" }
    }),
    prisma.automationTemplate.findMany({
      where: {
        OR: [{ merchantId }, { merchantId: null }],
        active: true
      },
      orderBy: [{ key: "asc" }, { channel: "asc" }]
    }),
    prisma.merchantChannelCredential.findMany({
      where: { merchantId, status: { in: ["ACTIVE", "VERIFIED"] } },
      orderBy: { channel: "asc" }
    })
  ]);

  return {
    merchant,
    preference,
    workflowSettings,
    templates,
    channelCredentials
  };
}

export async function emitAutomationEvent(input: EmitAutomationEventInput) {
  requireMerchantId(input.merchantId);

  const idempotencyKey = input.idempotencyKey || makeIdempotencyKey(input);
  const createData: Prisma.AutomationEventUncheckedCreateInput = {
    merchantId: input.merchantId,
    eventKey: input.eventKey,
    source: input.source || "shipmastr",
    idempotencyKey,
    payload: toJson(input.payload),
    status: "QUEUED"
  };

  if (input.sourceId) {
    createData.sourceId = input.sourceId;
  }

  try {
    return await prisma.automationEvent.upsert({
      where: {
        merchantId_idempotencyKey: {
          merchantId: input.merchantId,
          idempotencyKey
        }
      },
      create: createData,
      update: {
        payload: toJson(input.payload),
        updatedAt: new Date()
      }
    });
  } catch (error) {
    await prisma.auditLog.create({
      data: {
        merchantId: input.merchantId,
        action: "automation.emit_failed",
        entityType: "AutomationEvent",
        metadata: {
          eventKey: input.eventKey,
          source: input.source || "shipmastr",
          error: error instanceof Error ? error.message : "Unknown automation emit failure"
        }
      }
    });

    throw error;
  }
}

const NDR_RECOMMENDED_ACTIONS = [
  "reattempt_today",
  "reattempt_tomorrow",
  "update_address",
  "cancel_or_manual_review"
] as const;

function cleanOptionalString(value: unknown) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function cleanOptionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function metadataFlag(metadata: Prisma.JsonValue | Record<string, unknown> | null | undefined, key: string, fallback: boolean) {
  const value = asRecord(metadata)[key];
  return typeof value === "boolean" ? value : fallback;
}

function metadataString(metadata: Prisma.JsonValue | Record<string, unknown> | null | undefined, key: string) {
  return cleanOptionalString(asRecord(metadata)[key]);
}

function safeDomainFromEmail(email?: string | null | undefined) {
  const value = cleanOptionalString(email);
  const domain = value?.split("@")[1];
  return domain ? `*@${domain.toLowerCase()}` : undefined;
}

function maskEmail(email?: string | null | undefined) {
  const value = cleanOptionalString(email);
  if (!value || !value.includes("@")) return undefined;
  const [name = "", domain = ""] = value.split("@");
  const prefix = name.length <= 2 ? `${name.slice(0, 1)}*` : `${name.slice(0, 2)}***`;
  return `${prefix}@${domain}`;
}

function maskPhone(phone?: string | null | undefined) {
  const value = cleanOptionalString(phone)?.replace(/\s+/g, "");
  if (!value) return undefined;
  if (value.length <= 4) return "****";
  return `${"*".repeat(Math.max(value.length - 4, 4))}${value.slice(-4)}`;
}

function normalizeChannelStatus(status?: string | null | undefined) {
  const normalized = (status || "NOT_CONNECTED").toUpperCase();
  if (normalized === "ACTIVE") return "VERIFIED";
  return CHANNEL_STATUSES.has(normalized) ? normalized : "PENDING_VERIFICATION";
}

function normalizeTemplateStatus(status?: unknown) {
  const normalized = String(status || "NOT_CONFIGURED").toUpperCase();
  return TEMPLATE_STATUSES.has(normalized) ? normalized : "NOT_CONFIGURED";
}

function isVerifiedCredentialStatus(status?: string | null | undefined) {
  const normalized = (status || "").toUpperCase();
  return CHANNEL_READY_STATUSES.has(normalized);
}

function sanitizeCredentialMetadata(metadata: Prisma.JsonValue | null | undefined) {
  const source = asRecord(metadata);
  const safeKeys = [
    "senderEmail",
    "businessEmail",
    "whatsappBusinessNumber",
    "templateNamespace",
    "templateName",
    "templateStatus",
    "templateStatuses",
    "templateMappings",
    "providerMode",
    "providerStatus",
    "lastProviderCheckAt",
    "lastTestAt",
    "fallbackAllowed",
    "managedSender"
  ];

  const sanitized = Object.fromEntries(
    safeKeys
      .map((key) => [key, source[key]])
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
  ) as JsonMap;

  const phoneNumberId = cleanOptionalString(source.whatsappPhoneNumberId || source.phoneNumberId);
  if (phoneNumberId) sanitized.phoneNumberIdMasked = maskOpaqueId(phoneNumberId);

  return sanitized;
}

function sanitizeAutomationDispatchContext(context: Awaited<ReturnType<typeof getMerchantAutomationContext>>) {
  return {
    ...context,
    channelCredentials: context.channelCredentials.map((credential) => ({
      channel: credential.channel,
      provider: credential.provider,
      label: credential.label,
      status: credential.status,
      lastVerifiedAt: credential.lastVerifiedAt,
      metadata: sanitizeCredentialMetadata(credential.metadata)
    }))
  };
}

function effectiveBusinessEmailFromMetadata(metadata: Prisma.JsonValue | null | undefined) {
  const source = asRecord(metadata);
  return cleanOptionalString(source.businessEmail) || cleanOptionalString(source.senderEmail);
}

function emailFallbackAllowed(preference: { metadata: Prisma.JsonValue | null }) {
  const metadata = asRecord(preference.metadata);
  return metadataFlag(metadata, "abandonedCheckoutFallbackSenderAllowed", false) ||
    metadataFlag(metadata, "repeatBuyerFallbackSenderAllowed", false) ||
    metadataFlag(metadata, "emailFallbackAllowed", false);
}

function verificationHash(merchantId: string, channel: string, code: string) {
  return createHash("sha256")
    .update(`${merchantId}:${channel}:${code}:${env.APP_SECRET_PEPPER}`)
    .digest("hex");
}

function templateStatusesFromMetadata(metadata: Prisma.JsonValue | null | undefined) {
  const source = asRecord(metadata);
  const nested = asRecord(source.templateStatus || source.templateStatuses);
  const abandonedCheckout =
    normalizeTemplateStatus(nested.abandonedCheckout || source.abandonedCheckoutTemplateStatus ||
      (source.templateName === ABANDONED_CHECKOUT_TEMPLATE_KEY ? "APPROVED" : undefined));
  const repeatBuyer =
    normalizeTemplateStatus(nested.repeatBuyer || source.repeatBuyerTemplateStatus ||
      (source.templateName === REPEAT_BUYER_TEMPLATE_KEY ? "APPROVED" : undefined));

  return {
    abandonedCheckout,
    repeatBuyer,
    codRisk: normalizeTemplateStatus(nested.codRisk || source.codRiskTemplateStatus),
    addressConfirmation: normalizeTemplateStatus(nested.addressConfirmation || source.addressConfirmationTemplateStatus),
    ndrRecovery: normalizeTemplateStatus(nested.ndrRecovery || source.ndrRecoveryTemplateStatus)
  };
}

function maskOpaqueId(value?: string | null | undefined) {
  const normalized = cleanOptionalString(value);
  if (!normalized) return undefined;
  if (normalized.length <= 6) return "***";
  return `${normalized.slice(0, 2)}***${normalized.slice(-4)}`;
}

function templateMappingsFromMetadata(metadata: Prisma.JsonValue | null | undefined) {
  const source = asRecord(metadata);
  const mappings = asRecord(source.templateMappings);
  const templateStatuses = templateStatusesFromMetadata(metadata);

  const providerTemplate = (key: string, fallback: string) => {
    const mapping = asRecord(mappings[key]);
    return {
      templateKey: fallback,
      providerTemplateName: cleanOptionalString(mapping.providerTemplateName || mapping.name) || fallback,
      language: cleanOptionalString(mapping.language) || "en",
      status: templateStatuses[key as keyof typeof templateStatuses] || "NOT_CONFIGURED"
    };
  };

  return {
    codRisk: providerTemplate("codRisk", "cod_risk_high_v1"),
    addressConfirmation: providerTemplate("addressConfirmation", "address_confirmation_v1"),
    ndrRecovery: providerTemplate("ndrRecovery", "ndr_recovery_v1"),
    abandonedCheckout: providerTemplate("abandonedCheckout", ABANDONED_CHECKOUT_TEMPLATE_KEY),
    repeatBuyer: providerTemplate("repeatBuyer", REPEAT_BUYER_TEMPLATE_KEY)
  };
}

function whatsappWorkflowTemplateKey(workflowKey: string) {
  return WHATSAPP_TEMPLATE_KEY_BY_WORKFLOW[workflowKey];
}

function whatsappTemplateStatusName(templateKey: string) {
  return WHATSAPP_TEMPLATE_STATUS_BY_KEY[templateKey];
}

function whatsappTemplateMappingForKey(metadata: Prisma.JsonValue | null | undefined, templateKey: string) {
  const statusName = whatsappTemplateStatusName(templateKey);
  const mappings = templateMappingsFromMetadata(metadata);
  return statusName ? mappings[statusName as keyof typeof mappings] : undefined;
}

function whatsappCredentialProviderMode(credential: { provider?: string | null; metadata?: Prisma.JsonValue | null } | null | undefined) {
  const metadata = asRecord(credential?.metadata);
  const explicit = cleanOptionalString(metadata.providerMode)?.toLowerCase();
  const provider = cleanOptionalString(credential?.provider)?.toLowerCase() || "";
  if (explicit === "real" || explicit === "smoke") return explicit;
  if (provider.includes("smoke") || provider === "mock") return "smoke";
  return "real";
}

function resolveWhatsappProviderPlan(input: {
  credential?: {
    provider: string;
    status: string;
    metadata: Prisma.JsonValue | null;
  } | null | undefined;
  templateKey: string;
  allowSmoke?: boolean | undefined;
}) {
  const credential = input.credential;
  const metadata = sanitizeCredentialMetadata(credential?.metadata);
  const rawMetadata = asRecord(credential?.metadata);
  const status = normalizeChannelStatus(credential?.status);
  const mode = whatsappCredentialProviderMode(credential);
  const templateStatusName = whatsappTemplateStatusName(input.templateKey);
  const templateStatuses = templateStatusesFromMetadata(credential?.metadata);
  const templateStatus = templateStatusName
    ? templateStatuses[templateStatusName as keyof typeof templateStatuses]
    : "NOT_CONFIGURED";
  const mapping = whatsappTemplateMappingForKey(credential?.metadata, input.templateKey);
  const businessNumber = cleanOptionalString(rawMetadata.whatsappBusinessNumber);

  if (!credential || status !== "VERIFIED") {
    return {
      allowed: false as const,
      reason: "WHATSAPP_NOT_VERIFIED",
      mode,
      templateStatus,
      businessNumberMasked: maskPhone(businessNumber)
    };
  }

  if (mode === "smoke" && input.allowSmoke !== false) {
    return {
      allowed: true as const,
      mode: "smoke" as const,
      provider: credential.provider,
      templateStatus,
      businessNumberMasked: maskPhone(businessNumber),
      templateNamespace: cleanOptionalString(metadata.templateNamespace),
      templateKey: input.templateKey,
      providerTemplateName: mapping?.providerTemplateName || input.templateKey,
      language: mapping?.language || "en"
    };
  }

  if (templateStatus !== "APPROVED") {
    return {
      allowed: false as const,
      reason: `WHATSAPP_${input.templateKey.toUpperCase()}_TEMPLATE_NOT_APPROVED`,
      mode: "real" as const,
      templateStatus,
      businessNumberMasked: maskPhone(businessNumber)
    };
  }

  return {
    allowed: true as const,
    mode: "real" as const,
    provider: credential.provider,
    templateStatus,
    businessNumberMasked: maskPhone(businessNumber),
    phoneNumberIdMasked: maskOpaqueId(cleanOptionalString(rawMetadata.whatsappPhoneNumberId || rawMetadata.phoneNumberId)),
    templateNamespace: cleanOptionalString(metadata.templateNamespace),
    templateKey: input.templateKey,
    providerTemplateName: mapping?.providerTemplateName || input.templateKey,
    language: mapping?.language || "en"
  };
}

function latestTestTime(log?: { createdAt: Date } | null) {
  return log?.createdAt || null;
}

export async function getMerchantChannelReadiness(
  merchantId: string,
  preferenceOverride?: { metadata?: Prisma.JsonValue | null } & Record<string, unknown>
) {
  requireMerchantId(merchantId);

  const [preference, credentials, latestEmailTest, latestWhatsappTest] = await Promise.all([
    preferenceOverride
      ? Promise.resolve(preferenceOverride)
      : prisma.automationPreference.upsert({ where: { merchantId }, create: { merchantId }, update: {} }),
    prisma.merchantChannelCredential.findMany({
      where: { merchantId, channel: { in: ["EMAIL", "WHATSAPP"] } },
      orderBy: [{ channel: "asc" }, { updatedAt: "desc" }]
    }),
    prisma.communicationLog.findFirst({
      where: { merchantId, channel: "EMAIL", templateKey: CHANNEL_TEST_TEMPLATE_KEY },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true }
    }),
    prisma.communicationLog.findFirst({
      where: { merchantId, channel: "WHATSAPP", templateKey: CHANNEL_TEST_TEMPLATE_KEY },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true }
    })
  ]);

  const emailCredential = credentials.find((credential) => credential.channel === "EMAIL");
  const whatsappCredential = credentials.find((credential) => credential.channel === "WHATSAPP");
  const emailStatus = emailCredential ? normalizeChannelStatus(emailCredential.status) : "NOT_CONNECTED";
  const whatsappStatus = whatsappCredential ? normalizeChannelStatus(whatsappCredential.status) : "NOT_CONNECTED";
  const businessEmail = effectiveBusinessEmailFromMetadata(emailCredential?.metadata);
  const verifiedBusinessEmail = emailStatus === "VERIFIED" ? businessEmail : undefined;
  const fallbackAllowed = emailFallbackAllowed({ metadata: preference.metadata ?? {} });
  const fallbackUsed = !verifiedBusinessEmail;
  const effectiveEmail = verifiedBusinessEmail || SHIPMASTR_FALLBACK_EMAIL;
  const emailBlockingReasons: string[] = [];

  if (!verifiedBusinessEmail && !fallbackAllowed) {
    emailBlockingReasons.push("EMAIL_NOT_VERIFIED");
    emailBlockingReasons.push("EMAIL_FALLBACK_NOT_ALLOWED");
  }
  if (emailStatus === "FAILED") emailBlockingReasons.push("EMAIL_VERIFICATION_FAILED");
  if (emailStatus === "DISABLED") emailBlockingReasons.push("EMAIL_DISABLED");

  const templateStatus = templateStatusesFromMetadata(whatsappCredential?.metadata);
  const templateMappings = templateMappingsFromMetadata(whatsappCredential?.metadata);
  const whatsappMetadata = asRecord(whatsappCredential?.metadata);
  const providerMode = whatsappCredentialProviderMode(whatsappCredential);
  const maskedBusinessNumber = maskPhone(cleanOptionalString(asRecord(whatsappCredential?.metadata).whatsappBusinessNumber));
  const phoneNumberIdMasked = maskOpaqueId(cleanOptionalString(whatsappMetadata.whatsappPhoneNumberId || whatsappMetadata.phoneNumberId));
  const lastProviderCheckAt = cleanOptionalString(whatsappMetadata.lastProviderCheckAt);
  const lastProviderHealth = cleanOptionalString(whatsappMetadata.providerStatus);
  const whatsappBlockingReasons: string[] = [];
  if (whatsappStatus !== "VERIFIED") whatsappBlockingReasons.push("WHATSAPP_NOT_VERIFIED");
  if (providerMode === "real" && !phoneNumberIdMasked) whatsappBlockingReasons.push("WHATSAPP_PHONE_NUMBER_ID_NOT_CONFIGURED");
  if (templateStatus.codRisk !== "APPROVED") whatsappBlockingReasons.push("WHATSAPP_COD_RISK_TEMPLATE_NOT_APPROVED");
  if (templateStatus.addressConfirmation !== "APPROVED") whatsappBlockingReasons.push("WHATSAPP_ADDRESS_CONFIRMATION_TEMPLATE_NOT_APPROVED");
  if (templateStatus.ndrRecovery !== "APPROVED") whatsappBlockingReasons.push("WHATSAPP_NDR_RECOVERY_TEMPLATE_NOT_APPROVED");
  if (templateStatus.abandonedCheckout !== "APPROVED") whatsappBlockingReasons.push("WHATSAPP_ABANDONED_CHECKOUT_TEMPLATE_NOT_APPROVED");
  if (templateStatus.repeatBuyer !== "APPROVED") whatsappBlockingReasons.push("WHATSAPP_REPEAT_BUYER_TEMPLATE_NOT_APPROVED");

  const emailReady = Boolean(verifiedBusinessEmail || fallbackAllowed);
  const whatsappReady = whatsappStatus === "VERIFIED" && templateStatus.abandonedCheckout === "APPROVED";
  const repeatBuyerWhatsappReady = whatsappStatus === "VERIFIED" && templateStatus.repeatBuyer === "APPROVED";
  const abandonedBlockingReasons = [
    ...(emailReady ? [] : ["EMAIL_OR_FALLBACK_NOT_READY"]),
    ...(whatsappReady ? [] : ["WHATSAPP_NOT_READY"])
  ];
  const repeatBuyerBlockingReasons = [
    ...(emailReady ? [] : ["EMAIL_OR_FALLBACK_NOT_READY"]),
    ...(repeatBuyerWhatsappReady ? [] : ["WHATSAPP_REPEAT_BUYER_NOT_READY"])
  ];

  return {
    email: {
      status: emailStatus,
      businessEmailMasked: maskEmail(businessEmail),
      effectiveSenderMasked: maskEmail(effectiveEmail),
      effectiveReplyToMasked: maskEmail(effectiveEmail),
      fallbackUsed,
      fallbackAllowed,
      providerStatus: verifiedBusinessEmail ? "READY" : fallbackAllowed ? "FALLBACK_READY" : emailStatus,
      lastTestAt: latestTestTime(latestEmailTest),
      blockingReasons: emailBlockingReasons
    },
    whatsapp: {
      status: whatsappStatus,
      maskedBusinessNumber,
      phoneNumberIdMasked,
      providerStatus: lastProviderHealth || (whatsappReady ? "READY" : whatsappStatus),
      providerMode,
      templateStatus,
      templateMappings,
      lastProviderCheckAt,
      lastTestAt: latestTestTime(latestWhatsappTest),
      blockingReasons: whatsappBlockingReasons
    },
    abandonedCheckout: {
      emailReady,
      whatsappReady,
      fallbackEmailReady: fallbackAllowed,
      canEnable: emailReady || whatsappReady,
      effectiveSenderMasked: maskEmail(effectiveEmail),
      blockingReasons: emailReady || whatsappReady ? [] : abandonedBlockingReasons
    },
    repeatBuyer: {
      emailReady,
      whatsappReady: repeatBuyerWhatsappReady,
      fallbackEmailReady: fallbackAllowed,
      canEnable: emailReady || repeatBuyerWhatsappReady,
      effectiveSenderMasked: maskEmail(effectiveEmail),
      blockingReasons: emailReady || repeatBuyerWhatsappReady ? [] : repeatBuyerBlockingReasons
    }
  };
}

export async function connectMerchantEmailChannel(input: { merchantId: string; businessEmail: string }) {
  requireMerchantId(input.merchantId);
  const businessEmail = cleanOptionalString(input.businessEmail)?.toLowerCase();
  if (!businessEmail || !businessEmail.includes("@")) throw new Error("VALID_BUSINESS_EMAIL_REQUIRED");

  const metadata = {
    businessEmail,
    lastConnectedAt: new Date().toISOString()
  };

  return prisma.merchantChannelCredential.upsert({
    where: {
      merchantId_channel_provider_label: {
        merchantId: input.merchantId,
        channel: "EMAIL",
        provider: "merchant-email",
        label: "business-email"
      }
    },
    create: {
      merchantId: input.merchantId,
      channel: "EMAIL",
      provider: "merchant-email",
      label: "business-email",
      credentialRef: `merchant-email:${input.merchantId}`,
      status: "PENDING_VERIFICATION",
      metadata
    },
    update: {
      status: "PENDING_VERIFICATION",
      metadata
    }
  });
}

export async function setMerchantEmailFallback(input: { merchantId: string; fallbackAllowed: boolean }) {
  requireMerchantId(input.merchantId);
  const current = await prisma.automationPreference.upsert({
    where: { merchantId: input.merchantId },
    create: { merchantId: input.merchantId },
    update: {}
  });
  const metadata = {
    ...asRecord(current.metadata),
    abandonedCheckoutFallbackSenderAllowed: input.fallbackAllowed,
    repeatBuyerFallbackSenderAllowed: input.fallbackAllowed,
    emailFallbackAllowed: input.fallbackAllowed
  };

  return prisma.automationPreference.update({
    where: { merchantId: input.merchantId },
    data: { metadata: toJson(metadata) }
  });
}

export async function sendMerchantEmailVerification(merchantId: string) {
  requireMerchantId(merchantId);
  const credential = await prisma.merchantChannelCredential.findFirst({
    where: { merchantId, channel: "EMAIL" },
    orderBy: { updatedAt: "desc" }
  });
  const businessEmail = effectiveBusinessEmailFromMetadata(credential?.metadata);
  if (!credential || !businessEmail) throw new Error("BUSINESS_EMAIL_NOT_CONNECTED");

  const code = String(randomInt(100000, 1000000));
  await prisma.merchantChannelCredential.update({
    where: { id: credential.id },
    data: {
      status: "PENDING_VERIFICATION",
      metadata: toJson({
        ...asRecord(credential.metadata),
        verificationCodeHash: verificationHash(merchantId, "EMAIL", code),
        lastVerificationSentAt: new Date().toISOString()
      })
    }
  });

  const event = await emitAutomationEvent({
    merchantId,
    eventKey: "merchant.channel_test",
    source: "merchant-dashboard",
    sourceId: credential.id,
    idempotencyKey: `merchant.channel_verification.email:${merchantId}:${Date.now()}`,
    payload: { channel: "EMAIL", businessEmailMasked: maskEmail(businessEmail) }
  });
  await logCommunication({
    merchantId,
    eventId: event.id,
    idempotencyKey: `channel-email-verification:${event.id}`,
    channel: "EMAIL",
    recipient: businessEmail,
    templateKey: "channel_email_verification_v1",
    status: "SENT",
    provider: "shipmastr",
    providerMessageId: `email_verification_${event.id}`,
    metadata: {
      eventKey: "merchant.channel_test",
      workflowKey: "SM_CHANNEL_TEST",
      sender: SHIPMASTR_FALLBACK_EMAIL,
      replyTo: SHIPMASTR_FALLBACK_EMAIL
    }
  });
  await markAutomationEventProcessed(event.id, { workflowKey: "SM_CHANNEL_TEST", channel: "EMAIL", verificationSent: true });

  return { ok: true, businessEmailMasked: maskEmail(businessEmail) };
}

export async function verifyMerchantEmailChannel(input: { merchantId: string; verificationCode: string }) {
  requireMerchantId(input.merchantId);
  const credential = await prisma.merchantChannelCredential.findFirst({
    where: { merchantId: input.merchantId, channel: "EMAIL" },
    orderBy: { updatedAt: "desc" }
  });
  const metadata = asRecord(credential?.metadata);
  const expectedHash = cleanOptionalString(metadata.verificationCodeHash);
  if (!credential || !expectedHash) throw new Error("EMAIL_VERIFICATION_NOT_REQUESTED");
  if (verificationHash(input.merchantId, "EMAIL", input.verificationCode) !== expectedHash) {
    throw new Error("EMAIL_VERIFICATION_CODE_INVALID");
  }

  return prisma.merchantChannelCredential.update({
    where: { id: credential.id },
    data: {
      status: "VERIFIED",
      lastVerifiedAt: new Date(),
      metadata: toJson({
        ...metadata,
        verificationCodeHash: undefined,
        verifiedAt: new Date().toISOString()
      })
    }
  });
}

export async function connectMerchantWhatsappChannel(input: {
  merchantId: string;
  businessNumber: string;
  templateStatuses?: JsonMap | undefined;
}) {
  requireMerchantId(input.merchantId);
  const businessNumber = cleanOptionalString(input.businessNumber);
  if (!businessNumber) throw new Error("WHATSAPP_BUSINESS_NUMBER_REQUIRED");

  const metadata = {
    whatsappBusinessNumber: businessNumber,
    providerMode: "real",
    templateStatuses: {
      abandonedCheckout: "PENDING",
      repeatBuyer: "PENDING",
      codRisk: "NOT_CONFIGURED",
      addressConfirmation: "NOT_CONFIGURED",
      ndrRecovery: "NOT_CONFIGURED",
      ...(input.templateStatuses || {})
    },
    templateMappings: {
      codRisk: { providerTemplateName: "cod_risk_high_v1", language: "en" },
      addressConfirmation: { providerTemplateName: "address_confirmation_v1", language: "en" },
      ndrRecovery: { providerTemplateName: "ndr_recovery_v1", language: "en" },
      abandonedCheckout: { providerTemplateName: ABANDONED_CHECKOUT_TEMPLATE_KEY, language: "en" },
      repeatBuyer: { providerTemplateName: REPEAT_BUYER_TEMPLATE_KEY, language: "en" }
    },
    lastConnectedAt: new Date().toISOString()
  };

  return prisma.merchantChannelCredential.upsert({
    where: {
      merchantId_channel_provider_label: {
        merchantId: input.merchantId,
        channel: "WHATSAPP",
        provider: "merchant-whatsapp",
        label: "business-whatsapp"
      }
    },
    create: {
      merchantId: input.merchantId,
      channel: "WHATSAPP",
      provider: "merchant-whatsapp",
      label: "business-whatsapp",
      credentialRef: `merchant-whatsapp:${input.merchantId}`,
      status: "PENDING_VERIFICATION",
      metadata
    },
    update: {
      status: "PENDING_VERIFICATION",
      metadata
    }
  });
}

export async function verifyMerchantWhatsappChannel(input: { merchantId: string; verificationCode?: string | undefined }) {
  requireMerchantId(input.merchantId);
  const credential = await prisma.merchantChannelCredential.findFirst({
    where: { merchantId: input.merchantId, channel: "WHATSAPP" },
    orderBy: { updatedAt: "desc" }
  });
  if (!credential) throw new Error("WHATSAPP_NOT_CONNECTED");

  return prisma.merchantChannelCredential.update({
    where: { id: credential.id },
    data: {
      status: "VERIFIED",
      lastVerifiedAt: new Date(),
      metadata: toJson({
        ...asRecord(credential.metadata),
        verifiedAt: new Date().toISOString()
      })
    }
  });
}

export async function disableMerchantChannel(input: { merchantId: string; channel: "EMAIL" | "WHATSAPP" }) {
  requireMerchantId(input.merchantId);
  await prisma.merchantChannelCredential.updateMany({
    where: { merchantId: input.merchantId, channel: input.channel },
    data: { status: "DISABLED" }
  });
  return getMerchantChannelReadiness(input.merchantId);
}

export async function runMerchantChannelTest(input: { merchantId: string; channel: "EMAIL" | "WHATSAPP" }) {
  requireMerchantId(input.merchantId);
  const [readiness, merchant] = await Promise.all([
    getMerchantChannelReadiness(input.merchantId),
    prisma.merchant.findUnique({ where: { id: input.merchantId }, select: { email: true, phone: true, name: true } })
  ]);

  if (!merchant) throw new Error("MERCHANT_NOT_FOUND");

  if (input.channel === "EMAIL") {
    if (!readiness.email.fallbackAllowed && readiness.email.status !== "VERIFIED") {
      throw new Error("EMAIL_CHANNEL_NOT_READY");
    }
    const sender = readiness.email.status === "VERIFIED"
      ? effectiveBusinessEmailFromMetadata((await prisma.merchantChannelCredential.findFirst({
        where: { merchantId: input.merchantId, channel: "EMAIL" },
        orderBy: { updatedAt: "desc" }
      }))?.metadata) || SHIPMASTR_FALLBACK_EMAIL
      : SHIPMASTR_FALLBACK_EMAIL;
    const recipient = sender === SHIPMASTR_FALLBACK_EMAIL
      ? (merchant.email || sender)
      : sender;
    const event = await emitAutomationEvent({
      merchantId: input.merchantId,
      eventKey: "merchant.channel_test",
      source: "merchant-dashboard",
      sourceId: "EMAIL",
      idempotencyKey: `merchant.channel_test.email:${input.merchantId}:${Date.now()}`,
      payload: { channel: "EMAIL", senderMasked: maskEmail(sender), replyToMasked: maskEmail(sender) }
    });
    const communication = await logCommunication({
      merchantId: input.merchantId,
      eventId: event.id,
      channel: "EMAIL",
      recipient,
      templateKey: CHANNEL_TEST_TEMPLATE_KEY,
      status: "SENT",
      provider: sender === SHIPMASTR_FALLBACK_EMAIL ? "shipmastr-fallback" : "merchant-email",
      providerMessageId: `channel_test_email_${event.id}`,
      metadata: {
        eventKey: "merchant.channel_test",
        workflowKey: "SM_CHANNEL_TEST",
        sender,
        replyTo: sender
      }
    });
    await markAutomationEventProcessed(event.id, { workflowKey: "SM_CHANNEL_TEST", channel: "EMAIL" });
    return { event, communication };
  }

  if (readiness.whatsapp.status !== "VERIFIED") {
    throw new Error("WHATSAPP_CHANNEL_NOT_READY");
  }
  const recipient = readiness.whatsapp.maskedBusinessNumber || maskPhone(merchant.phone) || "whatsapp:test";
  const event = await emitAutomationEvent({
    merchantId: input.merchantId,
    eventKey: "merchant.channel_test",
    source: "merchant-dashboard",
    sourceId: "WHATSAPP",
    idempotencyKey: `merchant.channel_test.whatsapp:${input.merchantId}:${Date.now()}`,
    payload: { channel: "WHATSAPP", recipient }
  });
  const communication = await logCommunication({
    merchantId: input.merchantId,
    eventId: event.id,
    channel: "WHATSAPP",
    recipient,
    templateKey: CHANNEL_TEST_TEMPLATE_KEY,
    status: "SENT",
    provider: "merchant-whatsapp",
    providerMessageId: `channel_test_whatsapp_${event.id}`,
    metadata: {
      eventKey: "merchant.channel_test",
      workflowKey: "SM_CHANNEL_TEST",
      sender: readiness.whatsapp.maskedBusinessNumber
    }
  });
  await markAutomationEventProcessed(event.id, { workflowKey: "SM_CHANNEL_TEST", channel: "WHATSAPP" });
  return { event, communication };
}

function buildNdrAddressSummary(input: {
  city?: string | null | undefined;
  state?: string | null | undefined;
  pincode?: string | null | undefined;
}) {
  return [input.city, input.state, input.pincode]
    .map((part) => cleanOptionalString(part))
    .filter(Boolean)
    .join(", ") || undefined;
}

export type BuildNdrRecoveryAutomationEventInput = {
  merchantId: string;
  orderId?: string | null | undefined;
  externalOrderId?: string | null | undefined;
  shipmentId?: string | null | undefined;
  awb?: string | null | undefined;
  awbNumber?: string | null | undefined;
  trackingNumber?: string | null | undefined;
  ndrEventId?: string | null | undefined;
  courierPartnerId?: string | null | undefined;
  courierPartnerName?: string | null | undefined;
  buyerName?: string | null | undefined;
  buyerPhone?: string | null | undefined;
  ndrReason?: string | null | undefined;
  attemptCount?: number | null | undefined;
  city?: string | null | undefined;
  state?: string | null | undefined;
  pincode?: string | null | undefined;
};

export function buildNdrRecoveryAutomationEvent(input: BuildNdrRecoveryAutomationEventInput): EmitAutomationEventInput {
  requireMerchantId(input.merchantId);

  const orderId = cleanOptionalString(input.orderId);
  const shipmentId = cleanOptionalString(input.shipmentId);
  const awb = cleanOptionalString(input.awb) || cleanOptionalString(input.awbNumber) || cleanOptionalString(input.trackingNumber);
  const ndrReason = cleanOptionalString(input.ndrReason) || "OTHER";
  const ndrEventId = cleanOptionalString(input.ndrEventId);
  const attemptCount = cleanOptionalNumber(input.attemptCount) ?? 1;
  const addressSummary = buildNdrAddressSummary({
    city: input.city,
    state: input.state,
    pincode: input.pincode
  });

  const payload: JsonMap = {
    eventIntent: "NDR_RESCUE",
    orderId,
    externalOrderId: cleanOptionalString(input.externalOrderId),
    shipmentId,
    awb,
    courierPartner: {
      id: cleanOptionalString(input.courierPartnerId),
      name: cleanOptionalString(input.courierPartnerName)
    },
    buyerContact: {
      name: cleanOptionalString(input.buyerName),
      phone: cleanOptionalString(input.buyerPhone)
    },
    ndrReason,
    attemptCount,
    addressSummary,
    recommendedActions: [...NDR_RECOMMENDED_ACTIONS],
    recommendedAction: "Ask the buyer to choose a reattempt slot or update the delivery address."
  };

  return {
    merchantId: input.merchantId,
    eventKey: "shipment.ndr_created",
    source: "shipment-ndr",
    sourceId: ndrEventId || shipmentId || awb || orderId,
    idempotencyKey: [
      "shipment.ndr_created",
      orderId || "no-order",
      shipmentId || "no-shipment",
      awb || "no-awb",
      ndrEventId || ndrReason
    ].join(":"),
    payload
  };
}

function safeUrl(value?: string | null | undefined) {
  const candidate = cleanOptionalString(value);
  if (!candidate) return undefined;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function buildAbandonedCheckoutSubject(storeName: string) {
  return `Complete your order from ${cleanOptionalString(storeName) || "your store"}`;
}

export type BuildAbandonedCheckoutAutomationEventInput = {
  merchantId: string;
  cartId: string;
  checkoutId?: string | null | undefined;
  buyerName?: string | null | undefined;
  buyerEmail?: string | null | undefined;
  buyerPhone?: string | null | undefined;
  emailMarketingConsent?: boolean | null | undefined;
  whatsappMarketingConsent?: boolean | null | undefined;
  cartValuePaise?: number | null | undefined;
  itemCount?: number | null | undefined;
  checkoutUrl?: string | null | undefined;
  recoveryUrl?: string | null | undefined;
  recoveryWindowMinutes?: number | null | undefined;
  recommendedOffer?: string | null | undefined;
  merchantName?: string | null | undefined;
  storeName?: string | null | undefined;
  preferredChannels?: string[] | undefined;
};

export function buildAbandonedCheckoutAutomationEvent(input: BuildAbandonedCheckoutAutomationEventInput): EmitAutomationEventInput {
  requireMerchantId(input.merchantId);
  const cartId = cleanOptionalString(input.cartId);
  if (!cartId) {
    throw new Error("ABANDONED_CHECKOUT_REQUIRES_CART_ID");
  }

  const recoveryWindowMinutes = cleanOptionalNumber(input.recoveryWindowMinutes) ?? 45;
  const storeName = cleanOptionalString(input.storeName) || cleanOptionalString(input.merchantName) || "your store";
  const buyerEmail = input.emailMarketingConsent ? cleanOptionalString(input.buyerEmail) : undefined;
  const buyerPhone = input.whatsappMarketingConsent ? cleanOptionalString(input.buyerPhone) : undefined;
  const recoveryUrl = safeUrl(input.recoveryUrl) || safeUrl(input.checkoutUrl);

  const payload: JsonMap = {
    eventIntent: "ABANDONED_CHECKOUT_RECOVERY",
    merchantId: input.merchantId,
    merchantName: cleanOptionalString(input.merchantName),
    storeName,
    cartId,
    checkoutId: cleanOptionalString(input.checkoutId),
    buyerContact: {
      name: cleanOptionalString(input.buyerName),
      email: buyerEmail,
      phone: buyerPhone,
      emailMasked: maskEmail(input.buyerEmail),
      phoneMasked: maskPhone(input.buyerPhone),
      safeIdentifier: maskEmail(input.buyerEmail) || maskPhone(input.buyerPhone) || cartId
    },
    buyerConsent: {
      emailMarketingConsent: input.emailMarketingConsent === true,
      whatsappMarketingConsent: input.whatsappMarketingConsent === true
    },
    cart: {
      valuePaise: cleanOptionalNumber(input.cartValuePaise) ?? 0,
      itemCount: cleanOptionalNumber(input.itemCount) ?? 0
    },
    recoveryWindowMinutes,
    recommendedOffer: cleanOptionalString(input.recommendedOffer),
    recoveryUrl,
    email: {
      subject: buildAbandonedCheckoutSubject(storeName)
    },
    channelPlan: {
      emailEnabled: false,
      whatsappEnabled: false,
      preferredChannels: input.preferredChannels?.filter((channel) => ["EMAIL", "WHATSAPP"].includes(channel)) || ["EMAIL", "WHATSAPP"],
      fallbackSenderAllowed: false,
      skippedChannelReasons: []
    }
  };

  return {
    merchantId: input.merchantId,
    eventKey: "cart.abandoned",
    source: "abandoned-checkout",
    sourceId: cartId,
    idempotencyKey: `cart-abandoned:${input.merchantId}:${cartId}:${recoveryWindowMinutes}`,
    payload
  };
}

export function buildRepeatBuyerSubject(storeName: string) {
  return `New picks from ${cleanOptionalString(storeName) || "your store"}`;
}

export type BuildRepeatBuyerAutomationEventInput = {
  merchantId: string;
  buyerId: string;
  buyerName?: string | null | undefined;
  buyerEmail?: string | null | undefined;
  buyerPhone?: string | null | undefined;
  emailMarketingConsent?: boolean | null | undefined;
  whatsappMarketingConsent?: boolean | null | undefined;
  lastOrderId: string;
  lastOrderDate: string | Date;
  daysSinceLastOrder?: number | null | undefined;
  lastPurchasedCategories?: string[] | undefined;
  suggestedProducts?: Array<{ id?: string; title: string; url?: string }>;
  recommendedOffer?: string | null | undefined;
  recoveryUrl?: string | null | undefined;
  storeUrl?: string | null | undefined;
  merchantName?: string | null | undefined;
  storeName?: string | null | undefined;
  preferredChannels?: string[] | undefined;
  windowDate?: string | undefined;
};

function isoDate(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : isoDateInTimeZone();
}

function daysBetween(from: Date | string, to = new Date()) {
  const fromDate = from instanceof Date ? from : new Date(from);
  if (!Number.isFinite(fromDate.getTime())) return undefined;
  return Math.max(0, Math.floor((to.getTime() - fromDate.getTime()) / 86_400_000));
}

export function buildRepeatBuyerAutomationEvent(input: BuildRepeatBuyerAutomationEventInput): EmitAutomationEventInput {
  requireMerchantId(input.merchantId);
  const buyerId = cleanOptionalString(input.buyerId);
  const lastOrderId = cleanOptionalString(input.lastOrderId);
  if (!buyerId) throw new Error("REPEAT_BUYER_REQUIRES_BUYER_ID");
  if (!lastOrderId) throw new Error("REPEAT_BUYER_REQUIRES_LAST_ORDER_ID");

  const storeName = cleanOptionalString(input.storeName) || cleanOptionalString(input.merchantName) || "your store";
  const windowDate = cleanOptionalString(input.windowDate) || isoDateInTimeZone();
  const lastOrderDate = isoDate(input.lastOrderDate);
  const buyerEmail = input.emailMarketingConsent ? cleanOptionalString(input.buyerEmail) : undefined;
  const buyerPhone = input.whatsappMarketingConsent ? cleanOptionalString(input.buyerPhone) : undefined;
  const safeStoreUrl = safeUrl(input.storeUrl) || safeUrl(input.recoveryUrl);

  const payload: JsonMap = {
    eventIntent: "REPEAT_BUYER_RECOVERY",
    merchantId: input.merchantId,
    merchantName: cleanOptionalString(input.merchantName),
    storeName,
    buyerId,
    buyerContact: {
      name: cleanOptionalString(input.buyerName),
      email: buyerEmail,
      phone: buyerPhone,
      emailMasked: maskEmail(input.buyerEmail),
      phoneMasked: maskPhone(input.buyerPhone),
      safeIdentifier: maskEmail(input.buyerEmail) || maskPhone(input.buyerPhone) || buyerId
    },
    buyerConsent: {
      emailMarketingConsent: input.emailMarketingConsent === true,
      whatsappMarketingConsent: input.whatsappMarketingConsent === true
    },
    lastOrderId,
    lastOrderDate,
    daysSinceLastOrder: cleanOptionalNumber(input.daysSinceLastOrder) ?? daysBetween(input.lastOrderDate),
    lastPurchasedCategories: (input.lastPurchasedCategories || []).slice(0, 5).map((item) => String(item)),
    suggestedProducts: (input.suggestedProducts || []).slice(0, 4).map((product) => ({
      id: cleanOptionalString(product.id),
      title: cleanOptionalString(product.title) || "Suggested product",
      url: safeUrl(product.url)
    })),
    recommendedOffer: cleanOptionalString(input.recommendedOffer),
    storeUrl: safeStoreUrl,
    recoveryUrl: safeStoreUrl,
    email: {
      subject: buildRepeatBuyerSubject(storeName)
    },
    channelPlan: {
      emailEnabled: false,
      whatsappEnabled: false,
      preferredChannels: input.preferredChannels?.filter((channel) => ["EMAIL", "WHATSAPP"].includes(channel)) || ["EMAIL", "WHATSAPP"],
      fallbackSenderAllowed: false,
      skippedChannelReasons: []
    }
  };

  return {
    merchantId: input.merchantId,
    eventKey: "buyer.repeat_purchase_due",
    source: "repeat-buyer",
    sourceId: buyerId,
    idempotencyKey: `repeat-buyer:${input.merchantId}:${buyerId}:${windowDate}`,
    payload
  };
}

function isoDateInTimeZone(date = new Date(), timezone = "Asia/Kolkata") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value || String(date.getUTCFullYear());
  const month = parts.find((part) => part.type === "month")?.value || String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = parts.find((part) => part.type === "day")?.value || String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateFromIsoDate(isoDate: string) {
  const value = isoDate.trim();
  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!dateOnlyMatch) {
    const parsedDateTime = new Date(value);
    if (!Number.isNaN(parsedDateTime.getTime())) return parsedDateTime;
  }

  const dateMatch = dateOnlyMatch || /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!dateMatch) return new Date();
  const [, rawYear, rawMonth, rawDay] = dateMatch;
  const year = Number(rawYear);
  const month = Number(rawMonth);
  const day = Number(rawDay);
  if (!year || !month || !day) return new Date();
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

export function formatMerchantDigestSubjectDate(digestDate: string, timezone = "Asia/Kolkata") {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: timezone,
    day: "2-digit",
    month: "short",
    year: "numeric"
  }).format(dateFromIsoDate(digestDate)).replace(/,/g, "");
}

function dayRangeFromIsoDate(digestDate: string) {
  const [parsedYear, parsedMonth, parsedDay] = digestDate.split("-").map((part) => Number(part));
  const year = parsedYear || new Date().getUTCFullYear();
  const month = parsedMonth || 1;
  const day = parsedDay || 1;
  const start = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  const end = new Date(Date.UTC(year, month - 1, day + 1, 0, 0, 0));
  return { start, end };
}

function makeDailyDigestRecommendedActions(summary: {
  codRiskHighCount: number;
  addressConfirmationsSent: number;
  ndrCreated: number;
  ndrRecovered: number;
  shipmentsPendingPickup: number;
  codDueAmount: number;
  codDelayedAmount: number;
  failedAutomationCount: number;
}) {
  const actions: string[] = [];

  if (summary.codRiskHighCount > 0) {
    actions.push("Review high-risk COD orders before pickup.");
  }
  if (summary.ndrCreated > summary.ndrRecovered) {
    actions.push("Prioritize NDR rescue follow-ups before courier cutoff.");
  }
  if (summary.shipmentsPendingPickup > 0) {
    actions.push("Check pending pickups and escalate delayed handovers.");
  }
  if (summary.codDelayedAmount > 0) {
    actions.push("Review delayed COD remittances and open disputes where needed.");
  } else if (summary.codDueAmount > 0) {
    actions.push("Track today’s COD remittance due amount.");
  }
  if (summary.failedAutomationCount > 0) {
    actions.push("Open Autopilot logs and retry failed operational automations.");
  }

  return actions.length ? actions : ["No urgent action today. Keep shipping momentum steady."];
}

export async function buildMerchantDailyDigestSummary(input: {
  merchantId: string;
  digestDate: string;
  timezone?: string | undefined;
}) {
  requireMerchantId(input.merchantId);
  const { start, end } = dayRangeFromIsoDate(input.digestDate);
  const merchantId = input.merchantId;
  const createdAt = { gte: start, lt: end };
  const processedStatuses = [AutomationEventStatus.DISPATCHED, AutomationEventStatus.PROCESSED];
  const sentStatuses = ["SENT", "DELIVERED", "READ", "RESPONDED"];

  const [
    ordersReceived,
    codOrdersConfirmed,
    codRiskHighCount,
    addressConfirmationsSent,
    ndrCreated,
    ndrRecovered,
    shipmentsPendingPickup,
    codDue,
    codDelayed,
    abandonedRecovered,
    failedAutomationCount
  ] = await Promise.all([
    prisma.order.count({ where: { merchantId, createdAt } }),
    prisma.order.count({
      where: {
        merchantId,
        paymentMode: "COD",
        status: { in: ["VERIFIED", "READY_TO_SHIP", "SHIPPED", "DELIVERED"] },
        createdAt
      }
    }),
    prisma.automationEvent.count({ where: { merchantId, eventKey: "order.cod_risk_high", createdAt } }),
    prisma.communicationLog.count({
      where: {
        merchantId,
        templateKey: "address_confirmation_v1",
        channel: "WHATSAPP",
        status: { in: sentStatuses },
        createdAt
      }
    }),
    prisma.ndrEvent.count({ where: { merchantId, createdAt } }),
    prisma.automationEvent.count({
      where: {
        merchantId,
        eventKey: { in: ["shipment.reattempt_requested", "shipment.delivered"] },
        status: { in: processedStatuses },
        createdAt
      }
    }),
    prisma.shipmentDetails.count({
      where: {
        merchantId,
        OR: [
          { pickupStatus: null },
          { pickupStatus: { in: ["CREATED", "PENDING", "SCHEDULED", "PICKUP_PENDING"] } },
          { shipmentStatus: { in: ["CREATED", "BOOKED", "PICKUP_PENDING"] } }
        ]
      }
    }),
    prisma.financeAutomationAlert.aggregate({
      where: { merchantId, alertKey: "cod.remittance_due", status: { in: ["OPEN", "ACKNOWLEDGED"] } },
      _sum: { amountPaise: true }
    }),
    prisma.financeAutomationAlert.aggregate({
      where: { merchantId, alertKey: "cod.remittance_delayed", status: { in: ["OPEN", "ACKNOWLEDGED"] } },
      _sum: { amountPaise: true }
    }),
    prisma.marketingCampaign.aggregate({
      where: { merchantId, campaignType: "abandoned_checkout" },
      _sum: { recoveredRevenuePaise: true }
    }),
    prisma.automationEvent.count({ where: { merchantId, status: "FAILED", createdAt } })
  ]);

  const summary = {
    ordersReceived,
    codOrdersConfirmed,
    codRiskHighCount,
    addressConfirmationsSent,
    ndrCreated,
    ndrRecovered,
    shipmentsPendingPickup,
    codDueAmount: codDue._sum.amountPaise || 0,
    codDelayedAmount: codDelayed._sum.amountPaise || 0,
    abandonedCartRecoveredAmount: abandonedRecovered._sum.recoveredRevenuePaise || 0,
    failedAutomationCount
  };

  return {
    ...summary,
    digestDate: input.digestDate,
    timezone: input.timezone || "Asia/Kolkata",
    recommendedActions: makeDailyDigestRecommendedActions(summary)
  };
}

export type BuildMerchantDailyDigestAutomationEventInput = {
  merchantId: string;
  merchantName: string;
  merchantEmail: string;
  digestDate?: string | undefined;
  timezone?: string | undefined;
  summary: JsonMap;
};

export function buildMerchantDailyDigestAutomationEvent(input: BuildMerchantDailyDigestAutomationEventInput): EmitAutomationEventInput {
  requireMerchantId(input.merchantId);
  const timezone = cleanOptionalString(input.timezone) || "Asia/Kolkata";
  const digestDate = cleanOptionalString(input.digestDate) || isoDateInTimeZone(new Date(), timezone);
  const merchantName = cleanOptionalString(input.merchantName) || "Merchant";
  const merchantEmail = cleanOptionalString(input.merchantEmail);

  if (!merchantEmail) {
    throw new Error("MERCHANT_DAILY_DIGEST_REQUIRES_EMAIL");
  }

  const subjectDate = formatMerchantDigestSubjectDate(digestDate, timezone);
  const subject = `${merchantName} Daily Summary ${subjectDate}`;

  return {
    merchantId: input.merchantId,
    eventKey: "merchant.daily_digest",
    source: "merchant-daily-digest",
    sourceId: digestDate,
    idempotencyKey: `merchant-daily-digest:${input.merchantId}:${digestDate}`,
    payload: {
      merchantId: input.merchantId,
      merchantName,
      merchantEmail,
      digestDate,
      timezone,
      summary: input.summary,
      email: {
        from: DAILY_DIGEST_FROM_EMAIL,
        to: merchantEmail,
        subject
      }
    }
  };
}

type CodRemittanceEventKey =
  | "cod.remittance_due"
  | "cod.remittance_delayed"
  | "cod.remittance_settled"
  | "cod.remittance_mismatch_detected";

type CodRemittanceAgeingBucket = "0-3" | "4-7" | "8-15" | "15+";

export type BuildCodRemittanceAlertAutomationEventInput = {
  merchantId: string;
  merchantName: string;
  merchantEmail?: string | null | undefined;
  eventKey: CodRemittanceEventKey;
  remittanceId: string;
  courierPartnerId?: string | null | undefined;
  courierPartnerName?: string | null | undefined;
  settlementDate?: string | null | undefined;
  dueDate?: string | null | undefined;
  ageingBucket?: CodRemittanceAgeingBucket | null | undefined;
  codAmountPaise?: number | null | undefined;
  expectedAmountPaise?: number | null | undefined;
  receivedAmountPaise?: number | null | undefined;
  mismatchAmountPaise?: number | null | undefined;
  shipmentCount?: number | null | undefined;
  awbCount?: number | null | undefined;
  actionRequired?: string | null | undefined;
  financeSummaryUrl?: string | null | undefined;
  preferredChannels?: string[] | undefined;
};

function safeMoneyPaise(value: unknown) {
  const amount = cleanOptionalNumber(value);
  return amount === undefined ? 0 : Math.max(0, Math.round(amount));
}

function ageingBucketFromDays(days: number): CodRemittanceAgeingBucket {
  if (days <= 3) return "0-3";
  if (days <= 7) return "4-7";
  if (days <= 15) return "8-15";
  return "15+";
}

function calculateAgeingBucket(dueDate?: string | null | undefined, explicit?: CodRemittanceAgeingBucket | null | undefined) {
  if (explicit) return explicit;
  const parsedDueDate = cleanOptionalString(dueDate) ? new Date(String(dueDate)) : null;
  if (!parsedDueDate || !Number.isFinite(parsedDueDate.getTime())) return "0-3";
  const days = Math.max(0, Math.floor((Date.now() - parsedDueDate.getTime()) / 86_400_000));
  return ageingBucketFromDays(days);
}

function codRemittanceTemplateKey(eventKey: string) {
  return COD_REMITTANCE_TEMPLATE_BY_EVENT[eventKey] || "cod_remittance_due_v1";
}

function codRemittanceAlertLabel(eventKey: string) {
  if (eventKey === "cod.remittance_delayed") return "COD Remittance Delayed";
  if (eventKey === "cod.remittance_settled") return "COD Remittance Settled";
  if (eventKey === "cod.remittance_mismatch_detected") return "COD Mismatch Detected";
  return "COD Remittance Due";
}

export function buildCodRemittanceSubject(input: {
  merchantName: string;
  eventKey: string;
  dueDate?: string | null | undefined;
  settlementDate?: string | null | undefined;
}) {
  const date = cleanOptionalString(input.settlementDate) || cleanOptionalString(input.dueDate) || isoDateInTimeZone();
  const subjectDate = formatMerchantDigestSubjectDate(date, "Asia/Kolkata");
  return `${cleanOptionalString(input.merchantName) || "Merchant"} ${codRemittanceAlertLabel(input.eventKey)} ${subjectDate}`;
}

function codRemittanceAction(eventKey: string) {
  if (eventKey === "cod.remittance_delayed") return "Open Finance Control and review courier follow-up status.";
  if (eventKey === "cod.remittance_settled") return "Reconcile the settlement against courier remittance records.";
  if (eventKey === "cod.remittance_mismatch_detected") return "Review the mismatch and raise a finance dispute if needed.";
  return "Track the remittance due today and verify settlement once received.";
}

export function buildCodRemittanceAlertAutomationEvent(input: BuildCodRemittanceAlertAutomationEventInput): EmitAutomationEventInput {
  requireMerchantId(input.merchantId);
  const remittanceId = cleanOptionalString(input.remittanceId);
  if (!remittanceId) throw new Error("COD_REMITTANCE_ALERT_REQUIRES_REMITTANCE_ID");

  const dueDate = cleanOptionalString(input.dueDate) || isoDateInTimeZone();
  const eventKey = input.eventKey;
  const merchantName = cleanOptionalString(input.merchantName) || "Merchant";
  const templateKey = codRemittanceTemplateKey(eventKey);
  const subject = buildCodRemittanceSubject({
    merchantName,
    eventKey,
    dueDate,
    settlementDate: input.settlementDate
  });
  const codAmountPaise = safeMoneyPaise(input.codAmountPaise);
  const expectedAmountPaise = safeMoneyPaise(input.expectedAmountPaise ?? input.codAmountPaise);
  const receivedAmountPaise = safeMoneyPaise(input.receivedAmountPaise);
  const mismatchAmountPaise = safeMoneyPaise(input.mismatchAmountPaise ??
    Math.abs(expectedAmountPaise - receivedAmountPaise));

  const payload: JsonMap = {
    eventIntent: "COD_REMITTANCE_ALERT",
    merchantId: input.merchantId,
    merchantName,
    merchantEmail: cleanOptionalString(input.merchantEmail),
    eventKey,
    alertType: eventKey.replace("cod.remittance_", ""),
    remittanceId,
    courierPartner: {
      id: cleanOptionalString(input.courierPartnerId),
      name: cleanOptionalString(input.courierPartnerName)
    },
    settlementDate: cleanOptionalString(input.settlementDate),
    dueDate,
    ageingBucket: calculateAgeingBucket(dueDate, input.ageingBucket),
    amounts: {
      currency: "INR",
      codAmountPaise,
      expectedAmountPaise,
      receivedAmountPaise,
      mismatchAmountPaise
    },
    codAmountPaise,
    expectedAmountPaise,
    receivedAmountPaise,
    mismatchAmountPaise,
    shipmentCount: Math.max(0, Math.round(cleanOptionalNumber(input.shipmentCount) ?? 0)),
    awbCount: Math.max(0, Math.round(cleanOptionalNumber(input.awbCount) ?? 0)),
    actionRequired: cleanOptionalString(input.actionRequired) || codRemittanceAction(eventKey),
    financeSummaryUrl: safeUrl(input.financeSummaryUrl),
    email: {
      subject
    },
    templateKey,
    channelPlan: {
      emailEnabled: false,
      whatsappEnabled: false,
      preferredChannels: input.preferredChannels?.filter((channel) => ["EMAIL", "WHATSAPP"].includes(channel)) || ["EMAIL", "WHATSAPP"],
      fallbackSenderAllowed: false,
      skippedChannelReasons: []
    }
  };

  return {
    merchantId: input.merchantId,
    eventKey,
    source: "cod-remittance-alert",
    sourceId: remittanceId,
    idempotencyKey: `cod-remittance-alert:${input.merchantId}:${eventKey}:${remittanceId}:${dueDate}`,
    payload
  };
}

type SellerSettlementEventKey =
  | "seller.settlement_generated"
  | "seller.settlement_scheduled"
  | "seller.settlement_paid"
  | "seller.settlement_held"
  | "seller.settlement_adjusted";

type SellerSettlementStatus = "GENERATED" | "SCHEDULED" | "PAID" | "HELD" | "ADJUSTED";

export type BuildSellerSettlementSummaryAutomationEventInput = {
  merchantId: string;
  merchantName: string;
  merchantEmail?: string | null | undefined;
  eventKey: SellerSettlementEventKey;
  settlementId: string;
  settlementStatus?: string | null | undefined;
  settlementDate?: string | null | undefined;
  expectedPayoutDate?: string | null | undefined;
  paidAt?: string | null | undefined;
  grossCodAmountPaise?: number | null | undefined;
  shippingChargesPaise?: number | null | undefined;
  platformFeesPaise?: number | null | undefined;
  adjustmentAmountPaise?: number | null | undefined;
  holdAmountPaise?: number | null | undefined;
  disputeAmountPaise?: number | null | undefined;
  netPayableAmountPaise?: number | null | undefined;
  shipmentCount?: number | null | undefined;
  awbCount?: number | null | undefined;
  actionRequired?: string | null | undefined;
  statementUrl?: string | null | undefined;
  preferredChannels?: string[] | undefined;
};

function sellerSettlementTemplateKey(eventKey: string) {
  return SELLER_SETTLEMENT_TEMPLATE_BY_EVENT[eventKey] || "seller_settlement_generated_v1";
}

function sellerSettlementStatus(eventKey: string, explicit?: string | null | undefined): SellerSettlementStatus {
  const provided = cleanOptionalString(explicit)?.toUpperCase();
  if (provided && ["GENERATED", "SCHEDULED", "PAID", "HELD", "ADJUSTED"].includes(provided)) {
    return provided as SellerSettlementStatus;
  }
  if (eventKey === "seller.settlement_scheduled") return "SCHEDULED";
  if (eventKey === "seller.settlement_paid") return "PAID";
  if (eventKey === "seller.settlement_held") return "HELD";
  if (eventKey === "seller.settlement_adjusted") return "ADJUSTED";
  return "GENERATED";
}

function sellerSettlementAlertLabel(eventKey: string) {
  if (eventKey === "seller.settlement_scheduled") return "Settlement Scheduled";
  if (eventKey === "seller.settlement_paid") return "Settlement Paid";
  if (eventKey === "seller.settlement_held") return "Settlement Hold Alert";
  if (eventKey === "seller.settlement_adjusted") return "Settlement Adjustment";
  return "Settlement Summary";
}

export function buildSellerSettlementSubject(input: {
  merchantName: string;
  eventKey: string;
  settlementDate?: string | null | undefined;
  expectedPayoutDate?: string | null | undefined;
  paidAt?: string | null | undefined;
}) {
  const date =
    cleanOptionalString(input.paidAt) ||
    cleanOptionalString(input.expectedPayoutDate) ||
    cleanOptionalString(input.settlementDate) ||
    isoDateInTimeZone();
  const subjectDate = formatMerchantDigestSubjectDate(date, "Asia/Kolkata");
  return `${cleanOptionalString(input.merchantName) || "Merchant"} ${sellerSettlementAlertLabel(input.eventKey)} ${subjectDate}`;
}

function sellerSettlementAction(eventKey: string) {
  if (eventKey === "seller.settlement_scheduled") return "Track expected payout date and reconcile once marked paid.";
  if (eventKey === "seller.settlement_paid") return "Reconcile the paid settlement against Finance Control.";
  if (eventKey === "seller.settlement_held") return "Review the hold reason and complete the required action.";
  if (eventKey === "seller.settlement_adjusted") return "Review adjustment details before closing the settlement.";
  return "Review the generated settlement summary in Finance Control.";
}

export function buildSellerSettlementSummaryAutomationEvent(input: BuildSellerSettlementSummaryAutomationEventInput): EmitAutomationEventInput {
  requireMerchantId(input.merchantId);
  const settlementId = cleanOptionalString(input.settlementId);
  if (!settlementId) throw new Error("SELLER_SETTLEMENT_SUMMARY_REQUIRES_SETTLEMENT_ID");

  const eventKey = input.eventKey;
  const merchantName = cleanOptionalString(input.merchantName) || "Merchant";
  const settlementStatus = sellerSettlementStatus(eventKey, input.settlementStatus);
  const settlementDate = cleanOptionalString(input.settlementDate) || isoDateInTimeZone();
  const templateKey = sellerSettlementTemplateKey(eventKey);
  const grossCodAmountPaise = safeMoneyPaise(input.grossCodAmountPaise);
  const shippingChargesPaise = safeMoneyPaise(input.shippingChargesPaise);
  const platformFeesPaise = safeMoneyPaise(input.platformFeesPaise);
  const adjustmentAmountPaise = safeMoneyPaise(input.adjustmentAmountPaise);
  const holdAmountPaise = safeMoneyPaise(input.holdAmountPaise);
  const disputeAmountPaise = safeMoneyPaise(input.disputeAmountPaise);
  const defaultNetPayable = Math.max(
    0,
    grossCodAmountPaise - shippingChargesPaise - platformFeesPaise - holdAmountPaise - disputeAmountPaise + adjustmentAmountPaise
  );
  const netPayableAmountPaise = safeMoneyPaise(input.netPayableAmountPaise ?? defaultNetPayable);
  const subject = buildSellerSettlementSubject({
    merchantName,
    eventKey,
    settlementDate,
    expectedPayoutDate: input.expectedPayoutDate,
    paidAt: input.paidAt
  });

  const payload: JsonMap = {
    eventIntent: "SELLER_SETTLEMENT_SUMMARY",
    merchantId: input.merchantId,
    merchantName,
    merchantEmail: cleanOptionalString(input.merchantEmail),
    eventKey,
    settlementId,
    settlementStatus,
    settlementDate,
    expectedPayoutDate: cleanOptionalString(input.expectedPayoutDate),
    paidAt: cleanOptionalString(input.paidAt),
    amounts: {
      currency: "INR",
      grossCodAmountPaise,
      shippingChargesPaise,
      platformFeesPaise,
      adjustmentAmountPaise,
      holdAmountPaise,
      disputeAmountPaise,
      netPayableAmountPaise
    },
    grossCodAmountPaise,
    shippingChargesPaise,
    platformFeesPaise,
    adjustmentAmountPaise,
    holdAmountPaise,
    disputeAmountPaise,
    netPayableAmountPaise,
    shipmentCount: Math.max(0, Math.round(cleanOptionalNumber(input.shipmentCount) ?? 0)),
    awbCount: Math.max(0, Math.round(cleanOptionalNumber(input.awbCount) ?? 0)),
    actionRequired: cleanOptionalString(input.actionRequired) || sellerSettlementAction(eventKey),
    statementUrl: safeUrl(input.statementUrl),
    email: {
      subject
    },
    templateKey,
    channelPlan: {
      emailEnabled: false,
      whatsappEnabled: false,
      preferredChannels: input.preferredChannels?.filter((channel) => ["EMAIL", "WHATSAPP"].includes(channel)) || ["EMAIL", "WHATSAPP"],
      fallbackSenderAllowed: false,
      skippedChannelReasons: []
    }
  };

  return {
    merchantId: input.merchantId,
    eventKey,
    source: "seller-settlement-summary",
    sourceId: settlementId,
    idempotencyKey: `seller-settlement-summary:${input.merchantId}:${eventKey}:${settlementId}:${settlementStatus}`,
    payload
  };
}

type InvoiceMismatchEventKey =
  | "invoice.mismatch_detected"
  | "invoice.duplicate_awb_charge_detected"
  | "invoice.weight_discrepancy_detected"
  | "invoice.zone_mismatch_detected"
  | "invoice.rto_charge_mismatch_detected"
  | "invoice.cod_fee_mismatch_detected"
  | "invoice.resolved"
  | "invoice.dispute_created";

type InvoiceMismatchSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type BuildInvoiceMismatchAutomationEventInput = {
  merchantId: string;
  merchantName: string;
  merchantEmail?: string | null | undefined;
  eventKey: InvoiceMismatchEventKey;
  invoiceId: string;
  mismatchId: string;
  courierPartnerId?: string | null | undefined;
  courierPartnerName?: string | null | undefined;
  mismatchType?: string | null | undefined;
  severity?: InvoiceMismatchSeverity | null | undefined;
  invoiceDate?: string | null | undefined;
  detectedAt?: string | null | undefined;
  awbCount?: number | null | undefined;
  affectedShipmentCount?: number | null | undefined;
  expectedAmountPaise?: number | null | undefined;
  billedAmountPaise?: number | null | undefined;
  mismatchAmountPaise?: number | null | undefined;
  currency?: string | null | undefined;
  actionRequired?: string | null | undefined;
  safeMismatchSummary?: string | null | undefined;
  financeSummaryUrl?: string | null | undefined;
  disputeUrl?: string | null | undefined;
  preferredChannels?: string[] | undefined;
  adminEscalationEnabled?: boolean | undefined;
};

function invoiceMismatchTemplateKey(eventKey: string) {
  return INVOICE_MISMATCH_TEMPLATE_BY_EVENT[eventKey] || "invoice_mismatch_detected_v1";
}

function invoiceMismatchAlertLabel(eventKey: string) {
  if (eventKey === "invoice.duplicate_awb_charge_detected") return "Duplicate AWB Charge Detected";
  if (eventKey === "invoice.weight_discrepancy_detected") return "Weight Discrepancy Alert";
  if (eventKey === "invoice.zone_mismatch_detected") return "Zone Mismatch Alert";
  if (eventKey === "invoice.rto_charge_mismatch_detected") return "RTO Charge Mismatch Alert";
  if (eventKey === "invoice.cod_fee_mismatch_detected") return "COD Fee Mismatch Alert";
  if (eventKey === "invoice.dispute_created") return "Invoice Dispute Created";
  if (eventKey === "invoice.resolved") return "Invoice Mismatch Resolved";
  return "Invoice Mismatch Detected";
}

function invoiceMismatchType(eventKey: string, explicit?: string | null | undefined) {
  const provided = cleanOptionalString(explicit);
  if (provided) return provided;
  if (eventKey === "invoice.duplicate_awb_charge_detected") return "duplicate_awb";
  if (eventKey === "invoice.weight_discrepancy_detected") return "weight_discrepancy";
  if (eventKey === "invoice.zone_mismatch_detected") return "zone_mismatch";
  if (eventKey === "invoice.rto_charge_mismatch_detected") return "rto_charge_mismatch";
  if (eventKey === "invoice.cod_fee_mismatch_detected") return "cod_fee_mismatch";
  if (eventKey === "invoice.dispute_created") return "dispute_created";
  if (eventKey === "invoice.resolved") return "resolved";
  return "invoice_total_mismatch";
}

function normalizeInvoiceSeverity(value?: InvoiceMismatchSeverity | null | undefined): InvoiceMismatchSeverity {
  return value && ["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(value) ? value : "HIGH";
}

export function buildInvoiceMismatchSubject(input: {
  merchantName: string;
  eventKey: string;
  detectedAt?: string | null | undefined;
  invoiceDate?: string | null | undefined;
}) {
  const date = cleanOptionalString(input.detectedAt) || cleanOptionalString(input.invoiceDate) || isoDateInTimeZone();
  const subjectDate = formatMerchantDigestSubjectDate(date, "Asia/Kolkata");
  return `${cleanOptionalString(input.merchantName) || "Merchant"} ${invoiceMismatchAlertLabel(input.eventKey)} ${subjectDate}`;
}

function invoiceMismatchAction(eventKey: string) {
  if (eventKey === "invoice.duplicate_awb_charge_detected") return "Review duplicate AWB charges and raise a courier dispute before settlement.";
  if (eventKey === "invoice.weight_discrepancy_detected") return "Review charged weight against shipment records before approving the invoice.";
  if (eventKey === "invoice.zone_mismatch_detected") return "Check courier zone mapping and block settlement until the mismatch is explained.";
  if (eventKey === "invoice.rto_charge_mismatch_detected") return "Validate RTO charge eligibility against shipment lifecycle events.";
  if (eventKey === "invoice.cod_fee_mismatch_detected") return "Review COD fee calculations against courier contract terms.";
  if (eventKey === "invoice.dispute_created") return "Track the created dispute until courier response is recorded.";
  if (eventKey === "invoice.resolved") return "Reconcile the resolved invoice mismatch before settlement closure.";
  return "Review invoice mismatch in Finance Control and create a dispute if needed.";
}

function invoiceMismatchSummary(input: {
  eventKey: string;
  courierPartnerName?: string | null | undefined;
  expectedAmountPaise: number;
  billedAmountPaise: number;
  mismatchAmountPaise: number;
}) {
  const courierName = cleanOptionalString(input.courierPartnerName) || "Courier";
  if (input.eventKey === "invoice.duplicate_awb_charge_detected") {
    return `Duplicate AWB charge detected from ${courierName}. Estimated excess billing is INR ${Math.round(input.mismatchAmountPaise / 100)}.`;
  }
  if (input.eventKey === "invoice.weight_discrepancy_detected") {
    return `Weight discrepancy detected from ${courierName}. Review charged weight before settlement.`;
  }
  if (input.eventKey === "invoice.resolved") {
    return `Invoice mismatch for ${courierName} is marked resolved and ready for finance reconciliation.`;
  }
  return `Invoice mismatch detected from ${courierName}. Expected INR ${Math.round(input.expectedAmountPaise / 100)}, billed INR ${Math.round(input.billedAmountPaise / 100)}, difference INR ${Math.round(input.mismatchAmountPaise / 100)}.`;
}

export function buildInvoiceMismatchAutomationEvent(input: BuildInvoiceMismatchAutomationEventInput): EmitAutomationEventInput {
  requireMerchantId(input.merchantId);
  const invoiceId = cleanOptionalString(input.invoiceId);
  const mismatchId = cleanOptionalString(input.mismatchId);
  if (!invoiceId) throw new Error("INVOICE_MISMATCH_REQUIRES_INVOICE_ID");
  if (!mismatchId) throw new Error("INVOICE_MISMATCH_REQUIRES_MISMATCH_ID");

  const eventKey = input.eventKey;
  const merchantName = cleanOptionalString(input.merchantName) || "Merchant";
  const detectedAt = cleanOptionalString(input.detectedAt) || new Date().toISOString();
  const templateKey = invoiceMismatchTemplateKey(eventKey);
  const expectedAmountPaise = safeMoneyPaise(input.expectedAmountPaise);
  const billedAmountPaise = safeMoneyPaise(input.billedAmountPaise);
  const mismatchAmountPaise = safeMoneyPaise(input.mismatchAmountPaise ??
    Math.abs(billedAmountPaise - expectedAmountPaise));
  const safeMismatchSummary = cleanOptionalString(input.safeMismatchSummary) || invoiceMismatchSummary({
    eventKey,
    courierPartnerName: input.courierPartnerName,
    expectedAmountPaise,
    billedAmountPaise,
    mismatchAmountPaise
  });
  const subject = buildInvoiceMismatchSubject({
    merchantName,
    eventKey,
    detectedAt,
    invoiceDate: input.invoiceDate
  });

  const payload: JsonMap = {
    eventIntent: "INVOICE_MISMATCH_ALERT",
    merchantId: input.merchantId,
    merchantName,
    merchantEmail: cleanOptionalString(input.merchantEmail),
    eventKey,
    invoiceId,
    mismatchId,
    mismatchType: invoiceMismatchType(eventKey, input.mismatchType),
    severity: normalizeInvoiceSeverity(input.severity),
    courierPartner: {
      id: cleanOptionalString(input.courierPartnerId),
      name: cleanOptionalString(input.courierPartnerName)
    },
    invoiceDate: cleanOptionalString(input.invoiceDate),
    detectedAt,
    awbCount: Math.max(0, Math.round(cleanOptionalNumber(input.awbCount) ?? 0)),
    affectedShipmentCount: Math.max(0, Math.round(cleanOptionalNumber(input.affectedShipmentCount) ?? 0)),
    amounts: {
      currency: cleanOptionalString(input.currency) || "INR",
      expectedAmountPaise,
      billedAmountPaise,
      mismatchAmountPaise
    },
    expectedAmountPaise,
    billedAmountPaise,
    mismatchAmountPaise,
    actionRequired: cleanOptionalString(input.actionRequired) || invoiceMismatchAction(eventKey),
    safeMismatchSummary,
    financeSummaryUrl: safeUrl(input.financeSummaryUrl),
    disputeUrl: safeUrl(input.disputeUrl),
    email: {
      subject
    },
    templateKey,
    channelPlan: {
      emailEnabled: false,
      whatsappEnabled: false,
      adminEscalationEnabled: input.adminEscalationEnabled !== false,
      preferredChannels: input.preferredChannels?.filter((channel) => ["EMAIL", "WHATSAPP", "INTERNAL"].includes(channel)) || ["EMAIL"],
      fallbackSenderAllowed: false,
      skippedChannelReasons: []
    }
  };

  return {
    merchantId: input.merchantId,
    eventKey,
    source: "invoice-mismatch-alert",
    sourceId: invoiceId,
    idempotencyKey: `invoice-mismatch:${input.merchantId}:${invoiceId}:${mismatchId}:${eventKey}`,
    payload
  };
}

type CourierPickupDelayEventKey =
  | "courier.pickup_delay_detected"
  | "courier.pickup_missed"
  | "courier.pickup_failed"
  | "courier.pickup_escalated"
  | "courier.pickup_resolved";

type CourierPickupSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type BuildCourierPickupDelayAutomationEventInput = {
  merchantId: string;
  merchantName: string;
  merchantEmail?: string | null | undefined;
  courierPartnerId: string;
  courierPartnerName: string;
  courierEmail?: string | null | undefined;
  eventKey: CourierPickupDelayEventKey;
  pickupId: string;
  pickupDate?: string | null | undefined;
  scheduledPickupWindow?: string | null | undefined;
  delayMinutes?: number | null | undefined;
  affectedShipmentCount?: number | null | undefined;
  awbCount?: number | null | undefined;
  oldestAwbAgeMinutes?: number | null | undefined;
  pickupLocationSummary?: string | null | undefined;
  city?: string | null | undefined;
  state?: string | null | undefined;
  pincode?: string | null | undefined;
  severity?: CourierPickupSeverity | null | undefined;
  actionRequired?: string | null | undefined;
  pickupDashboardUrl?: string | null | undefined;
  preferredChannels?: string[] | undefined;
  opsEscalationEnabled?: boolean | undefined;
};

function courierPickupTemplateKey(eventKey: string) {
  return COURIER_PICKUP_DELAY_TEMPLATE_BY_EVENT[eventKey] || "courier_pickup_delay_v1";
}

function courierPickupAlertLabel(eventKey: string) {
  if (eventKey === "courier.pickup_missed") return "Pickup Missed";
  if (eventKey === "courier.pickup_failed") return "Pickup Failed";
  if (eventKey === "courier.pickup_escalated") return "Pickup Escalated";
  if (eventKey === "courier.pickup_resolved") return "Pickup Resolved";
  return "Pickup Delay Alert";
}

function normalizeCourierPickupSeverity(value?: CourierPickupSeverity | null | undefined): CourierPickupSeverity {
  return value && ["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(value) ? value : "HIGH";
}

export function buildCourierPickupDelaySubject(input: {
  eventKey: string;
  courierPartnerName: string;
  pickupDate?: string | null | undefined;
}) {
  const date = cleanOptionalString(input.pickupDate) || isoDateInTimeZone();
  const subjectDate = formatMerchantDigestSubjectDate(date, "Asia/Kolkata");
  return `${courierPickupAlertLabel(input.eventKey)} - ${cleanOptionalString(input.courierPartnerName) || "Courier"} - ${subjectDate}`;
}

function courierPickupAction(eventKey: string) {
  if (eventKey === "courier.pickup_missed") return "Contact courier ops, reschedule pickup, and notify affected sellers.";
  if (eventKey === "courier.pickup_failed") return "Review failed pickup reason and escalate to the Courier Partner operations contact.";
  if (eventKey === "courier.pickup_escalated") return "Shipmastr ops should track the escalation until pickup recovery is confirmed.";
  if (eventKey === "courier.pickup_resolved") return "Confirm affected shipments moved out of pickup pending state.";
  return "Review delayed pickup in Courier Control Tower and escalate if the delay crosses SLA.";
}

function courierPickupEventType(eventKey: string) {
  if (eventKey === "courier.pickup_missed") return "missed";
  if (eventKey === "courier.pickup_failed") return "failed";
  if (eventKey === "courier.pickup_escalated") return "escalated";
  if (eventKey === "courier.pickup_resolved") return "resolved";
  return "delay";
}

export function buildCourierPickupDelayAutomationEvent(input: BuildCourierPickupDelayAutomationEventInput): EmitAutomationEventInput {
  requireMerchantId(input.merchantId);
  const courierPartnerId = cleanOptionalString(input.courierPartnerId);
  const pickupId = cleanOptionalString(input.pickupId);
  if (!courierPartnerId) throw new Error("COURIER_PICKUP_DELAY_REQUIRES_COURIER_PARTNER_ID");
  if (!pickupId) throw new Error("COURIER_PICKUP_DELAY_REQUIRES_PICKUP_ID");

  const eventKey = input.eventKey;
  const merchantName = cleanOptionalString(input.merchantName) || "Merchant";
  const courierPartnerName = cleanOptionalString(input.courierPartnerName) || "Courier";
  const pickupDate = cleanOptionalString(input.pickupDate) || isoDateInTimeZone();
  const templateKey = courierPickupTemplateKey(eventKey);
  const subject = buildCourierPickupDelaySubject({
    eventKey,
    courierPartnerName,
    pickupDate
  });

  const payload: JsonMap = {
    eventIntent: "COURIER_PICKUP_DELAY_ALERT",
    merchantId: input.merchantId,
    merchantName,
    merchantEmail: cleanOptionalString(input.merchantEmail),
    eventKey,
    pickupId,
    pickupDate,
    pickupEventType: courierPickupEventType(eventKey),
    courierPartnerId,
    courierPartnerName,
    courierPartner: {
      id: courierPartnerId,
      name: courierPartnerName
    },
    courierContact: {
      email: cleanOptionalString(input.courierEmail),
      emailMasked: maskEmail(input.courierEmail)
    },
    scheduledPickupWindow: cleanOptionalString(input.scheduledPickupWindow),
    delayMinutes: Math.max(0, Math.round(cleanOptionalNumber(input.delayMinutes) ?? 0)),
    affectedShipmentCount: Math.max(0, Math.round(cleanOptionalNumber(input.affectedShipmentCount) ?? 0)),
    awbCount: Math.max(0, Math.round(cleanOptionalNumber(input.awbCount) ?? 0)),
    oldestAwbAgeMinutes: Math.max(0, Math.round(cleanOptionalNumber(input.oldestAwbAgeMinutes) ?? 0)),
    pickupLocationSummary: cleanOptionalString(input.pickupLocationSummary),
    city: cleanOptionalString(input.city),
    state: cleanOptionalString(input.state),
    pincode: cleanOptionalString(input.pincode),
    severity: normalizeCourierPickupSeverity(input.severity),
    actionRequired: cleanOptionalString(input.actionRequired) || courierPickupAction(eventKey),
    pickupDashboardUrl: safeUrl(input.pickupDashboardUrl),
    email: {
      subject
    },
    templateKey,
    channelPlan: {
      merchantEmailEnabled: false,
      courierEmailEnabled: false,
      opsEscalationEnabled: input.opsEscalationEnabled !== false,
      whatsappEnabled: false,
      preferredChannels: input.preferredChannels?.filter((channel) => ["EMAIL", "WHATSAPP", "INTERNAL"].includes(channel)) || ["EMAIL", "INTERNAL"],
      fallbackSenderAllowed: false,
      skippedChannelReasons: []
    }
  };

  return {
    merchantId: input.merchantId,
    eventKey,
    source: "courier-pickup-delay-alert",
    sourceId: pickupId,
    idempotencyKey: `courier-pickup-delay:${courierPartnerId}:${pickupId}:${eventKey}:${pickupDate}`,
    payload
  };
}

type CourierSlaBreachEventKey =
  | "courier.sla_breach_detected"
  | "courier.pickup_sla_breach"
  | "courier.first_scan_sla_breach"
  | "courier.in_transit_sla_breach"
  | "courier.ofd_sla_breach"
  | "courier.ndr_response_sla_breach"
  | "courier.reattempt_sla_breach"
  | "courier.rto_sla_breach"
  | "courier.cod_remittance_sla_breach"
  | "courier.sla_breach_escalated"
  | "courier.sla_breach_resolved";

type CourierSlaSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type BuildCourierSlaBreachAutomationEventInput = {
  merchantId: string;
  merchantName?: string | null | undefined;
  merchantEmail?: string | null | undefined;
  courierPartnerId: string;
  courierPartnerName: string;
  courierEmail?: string | null | undefined;
  eventKey: CourierSlaBreachEventKey;
  breachId: string;
  breachType?: string | null | undefined;
  severity?: CourierSlaSeverity | null | undefined;
  detectedAt?: string | null | undefined;
  slaTarget?: string | null | undefined;
  actualValue?: string | number | null | undefined;
  breachMinutes?: number | null | undefined;
  affectedShipmentCount?: number | null | undefined;
  awbCount?: number | null | undefined;
  sampleAwbs?: string[] | undefined;
  city?: string | null | undefined;
  state?: string | null | undefined;
  pincode?: string | null | undefined;
  laneSummary?: string | null | undefined;
  actionRequired?: string | null | undefined;
  escalationLevel?: string | null | undefined;
  courierDashboardUrl?: string | null | undefined;
  merchantImpactSummary?: string | null | undefined;
  preferredChannels?: string[] | undefined;
  opsEscalationEnabled?: boolean | undefined;
  financeEscalationEnabled?: boolean | undefined;
};

function courierSlaTemplateKey(eventKey: string) {
  return COURIER_SLA_BREACH_TEMPLATE_BY_EVENT[eventKey] || "courier_sla_breach_v1";
}

function courierSlaAlertLabel(eventKey: string) {
  if (eventKey === "courier.pickup_sla_breach") return "Pickup SLA Breach";
  if (eventKey === "courier.first_scan_sla_breach") return "First Scan SLA Breach";
  if (eventKey === "courier.in_transit_sla_breach") return "In-Transit SLA Breach";
  if (eventKey === "courier.ofd_sla_breach") return "OFD SLA Breach";
  if (eventKey === "courier.ndr_response_sla_breach") return "NDR Response SLA Breach";
  if (eventKey === "courier.reattempt_sla_breach") return "Reattempt SLA Breach";
  if (eventKey === "courier.rto_sla_breach") return "RTO SLA Breach";
  if (eventKey === "courier.cod_remittance_sla_breach") return "COD Remittance SLA Breach";
  if (eventKey === "courier.sla_breach_escalated") return "Courier SLA Escalated";
  if (eventKey === "courier.sla_breach_resolved") return "SLA Breach Resolved";
  return "Courier SLA Breach";
}

function normalizeCourierSlaSeverity(value?: CourierSlaSeverity | null | undefined): CourierSlaSeverity {
  return value && ["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(value) ? value : "HIGH";
}

function courierSlaBreachType(eventKey: string, breachType?: string | null | undefined) {
  const explicit = cleanOptionalString(breachType);
  if (explicit) return explicit;
  if (eventKey === "courier.pickup_sla_breach") return "pickup_sla";
  if (eventKey === "courier.first_scan_sla_breach") return "first_scan_sla";
  if (eventKey === "courier.in_transit_sla_breach") return "in_transit_delay";
  if (eventKey === "courier.ofd_sla_breach") return "out_for_delivery_delay";
  if (eventKey === "courier.ndr_response_sla_breach") return "ndr_response_sla";
  if (eventKey === "courier.reattempt_sla_breach") return "reattempt_sla";
  if (eventKey === "courier.rto_sla_breach") return "rto_delay";
  if (eventKey === "courier.cod_remittance_sla_breach") return "cod_remittance_sla";
  if (eventKey === "courier.sla_breach_escalated") return "sla_escalated";
  if (eventKey === "courier.sla_breach_resolved") return "sla_resolved";
  return "sla_breach";
}

function courierSlaAction(eventKey: string) {
  if (eventKey === "courier.cod_remittance_sla_breach") return "Shipmastr finance should verify COD ageing and escalate with courier settlement ops.";
  if (eventKey === "courier.ndr_response_sla_breach") return "Shipmastr ops should push the courier NDR desk for buyer response and reattempt confirmation.";
  if (eventKey === "courier.reattempt_sla_breach") return "Track reattempt ownership and keep the merchant informed until a final scan appears.";
  if (eventKey === "courier.rto_sla_breach") return "Escalate RTO movement with courier ops and monitor ageing until the parcel returns.";
  if (eventKey === "courier.sla_breach_escalated") return "Ops should hold the escalation owner accountable until breach recovery is confirmed.";
  if (eventKey === "courier.sla_breach_resolved") return "Confirm affected shipments are cleared and close the courier SLA alert.";
  return "Review in Courier Control Tower and escalate if the breach remains open.";
}

function maskAwb(value: string) {
  const clean = value.trim();
  if (clean.length <= 6) return clean;
  return `${clean.slice(0, 3)}***${clean.slice(-3)}`;
}

function safeSampleAwbs(values?: string[] | undefined) {
  return (values || [])
    .map((value) => cleanOptionalString(value))
    .filter((value): value is string => Boolean(value))
    .slice(0, 5)
    .map(maskAwb);
}

export function buildCourierSlaBreachSubject(input: {
  eventKey: string;
  courierPartnerName: string;
  detectedAt?: string | null | undefined;
}) {
  const date = cleanOptionalString(input.detectedAt)?.slice(0, 10) || isoDateInTimeZone();
  const subjectDate = formatMerchantDigestSubjectDate(date, "Asia/Kolkata");
  return `${courierSlaAlertLabel(input.eventKey)} - ${cleanOptionalString(input.courierPartnerName) || "Courier"} - ${subjectDate}`;
}

export function buildCourierSlaBreachAutomationEvent(input: BuildCourierSlaBreachAutomationEventInput): EmitAutomationEventInput {
  requireMerchantId(input.merchantId);
  const courierPartnerId = cleanOptionalString(input.courierPartnerId);
  const breachId = cleanOptionalString(input.breachId);
  if (!courierPartnerId) throw new Error("COURIER_SLA_BREACH_REQUIRES_COURIER_PARTNER_ID");
  if (!breachId) throw new Error("COURIER_SLA_BREACH_REQUIRES_BREACH_ID");

  const eventKey = input.eventKey;
  const merchantName = cleanOptionalString(input.merchantName) || "Merchant";
  const courierPartnerName = cleanOptionalString(input.courierPartnerName) || "Courier";
  const detectedAt = cleanOptionalString(input.detectedAt) || new Date().toISOString();
  const templateKey = courierSlaTemplateKey(eventKey);
  const breachType = courierSlaBreachType(eventKey, input.breachType);
  const subject = buildCourierSlaBreachSubject({
    eventKey,
    courierPartnerName,
    detectedAt
  });

  const payload: JsonMap = {
    eventIntent: "COURIER_SLA_BREACH_ALERT",
    merchantId: input.merchantId,
    merchantName,
    merchantEmail: cleanOptionalString(input.merchantEmail),
    eventKey,
    breachId,
    breachType,
    severity: normalizeCourierSlaSeverity(input.severity),
    detectedAt,
    slaTarget: cleanOptionalString(input.slaTarget),
    actualValue: typeof input.actualValue === "number" ? input.actualValue : cleanOptionalString(input.actualValue),
    breachMinutes: Math.max(0, Math.round(cleanOptionalNumber(input.breachMinutes) ?? 0)),
    affectedShipmentCount: Math.max(0, Math.round(cleanOptionalNumber(input.affectedShipmentCount) ?? 0)),
    awbCount: Math.max(0, Math.round(cleanOptionalNumber(input.awbCount) ?? 0)),
    sampleAwbs: safeSampleAwbs(input.sampleAwbs),
    city: cleanOptionalString(input.city),
    state: cleanOptionalString(input.state),
    pincode: cleanOptionalString(input.pincode),
    laneSummary: cleanOptionalString(input.laneSummary),
    actionRequired: cleanOptionalString(input.actionRequired) || courierSlaAction(eventKey),
    escalationLevel: cleanOptionalString(input.escalationLevel) || (normalizeCourierSlaSeverity(input.severity) === "CRITICAL" ? "L2" : "L1"),
    courierDashboardUrl: safeUrl(input.courierDashboardUrl),
    merchantImpactSummary: cleanOptionalString(input.merchantImpactSummary),
    courierPartnerId,
    courierPartnerName,
    courierPartner: {
      id: courierPartnerId,
      name: courierPartnerName
    },
    courierContact: {
      email: cleanOptionalString(input.courierEmail),
      emailMasked: maskEmail(input.courierEmail)
    },
    email: {
      subject
    },
    templateKey,
    channelPlan: {
      merchantEmailEnabled: false,
      courierEmailEnabled: false,
      opsEscalationEnabled: input.opsEscalationEnabled !== false,
      financeEscalationEnabled: input.financeEscalationEnabled !== false && eventKey === "courier.cod_remittance_sla_breach",
      whatsappEnabled: false,
      preferredChannels: input.preferredChannels?.filter((channel) => ["EMAIL", "WHATSAPP", "INTERNAL"].includes(channel)) || ["EMAIL", "INTERNAL"],
      fallbackSenderAllowed: false,
      skippedChannelReasons: []
    }
  };

  return {
    merchantId: input.merchantId,
    eventKey,
    source: "courier-sla-breach-alert",
    sourceId: breachId,
    idempotencyKey: `courier-sla-breach:${courierPartnerId}:${breachType}:${breachId}:${eventKey}`,
    payload
  };
}

type FakeScanReviewEventKey =
  | "courier.fake_scan_suspected"
  | "courier.pickup_scan_suspected_fake"
  | "courier.delivery_attempt_suspected_fake"
  | "courier.ndr_scan_suspected_fake"
  | "courier.late_scan_detected"
  | "courier.impossible_scan_sequence"
  | "courier.scan_location_mismatch"
  | "courier.duplicate_scan_pattern"
  | "courier.scan_after_terminal_state"
  | "courier.scan_anomaly_escalated"
  | "courier.scan_anomaly_resolved"
  | "courier.scan_anomaly_dismissed";

type FakeScanSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type BuildFakeScanReviewAutomationEventInput = {
  merchantId: string;
  merchantName?: string | null | undefined;
  merchantEmail?: string | null | undefined;
  courierPartnerId: string;
  courierPartnerName: string;
  courierEmail?: string | null | undefined;
  eventKey: FakeScanReviewEventKey;
  anomalyId: string;
  anomalyType?: string | null | undefined;
  severity?: FakeScanSeverity | null | undefined;
  detectedAt?: string | null | undefined;
  shipmentId?: string | null | undefined;
  orderId?: string | null | undefined;
  awb?: string | null | undefined;
  awbMasked?: string | null | undefined;
  affectedShipmentCount?: number | null | undefined;
  awbCount?: number | null | undefined;
  scanStatus?: string | null | undefined;
  previousStatus?: string | null | undefined;
  nextStatus?: string | null | undefined;
  scanTimestamp?: string | null | undefined;
  receivedAt?: string | null | undefined;
  delayMinutes?: number | null | undefined;
  locationSummary?: string | null | undefined;
  expectedLocationSummary?: string | null | undefined;
  routeSummary?: string | null | undefined;
  anomalyReasonCode?: string | null | undefined;
  sellerSafeSummary?: string | null | undefined;
  opsReviewSummary?: string | null | undefined;
  recommendedAction?: "review" | "ask_courier_for_proof" | "hold_courier_score" | "escalate_to_ops" | "mark_false_positive" | string | null | undefined;
  evidenceRefs?: string[] | undefined;
  courierDashboardUrl?: string | null | undefined;
  merchantImpactSummary?: string | null | undefined;
  preferredChannels?: string[] | undefined;
  opsEscalationEnabled?: boolean | undefined;
};

function fakeScanTemplateKey(eventKey: string) {
  return FAKE_SCAN_REVIEW_TEMPLATE_BY_EVENT[eventKey] || "fake_scan_review_v1";
}

function fakeScanAlertLabel(eventKey: string) {
  if (eventKey === "courier.pickup_scan_suspected_fake") return "Pickup Scan Review";
  if (eventKey === "courier.delivery_attempt_suspected_fake") return "Delivery Attempt Review";
  if (eventKey === "courier.ndr_scan_suspected_fake") return "NDR Scan Review";
  if (eventKey === "courier.late_scan_detected") return "Late Scan Detected";
  if (eventKey === "courier.impossible_scan_sequence") return "Impossible Scan Sequence";
  if (eventKey === "courier.scan_location_mismatch") return "Scan Location Mismatch";
  if (eventKey === "courier.duplicate_scan_pattern") return "Duplicate Scan Pattern";
  if (eventKey === "courier.scan_after_terminal_state") return "Scan After Terminal State";
  if (eventKey === "courier.scan_anomaly_escalated") return "Scan Anomaly Escalated";
  if (eventKey === "courier.scan_anomaly_resolved") return "Scan Anomaly Resolved";
  if (eventKey === "courier.scan_anomaly_dismissed") return "Scan Anomaly Dismissed";
  return "Fake Scan Review";
}

function normalizeFakeScanSeverity(value?: FakeScanSeverity | null | undefined): FakeScanSeverity {
  return value && ["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(value) ? value : "HIGH";
}

function fakeScanAnomalyType(eventKey: string, anomalyType?: string | null | undefined) {
  const explicit = cleanOptionalString(anomalyType);
  if (explicit) return explicit;
  if (eventKey === "courier.pickup_scan_suspected_fake") return "pickup_scan_suspected_fake";
  if (eventKey === "courier.delivery_attempt_suspected_fake") return "delivery_attempt_suspected_fake";
  if (eventKey === "courier.ndr_scan_suspected_fake") return "ndr_scan_suspected_fake";
  if (eventKey === "courier.late_scan_detected") return "late_scan";
  if (eventKey === "courier.impossible_scan_sequence") return "impossible_sequence";
  if (eventKey === "courier.scan_location_mismatch") return "location_mismatch";
  if (eventKey === "courier.duplicate_scan_pattern") return "duplicate_pattern";
  if (eventKey === "courier.scan_after_terminal_state") return "after_terminal_state";
  if (eventKey === "courier.scan_anomaly_escalated") return "escalated";
  if (eventKey === "courier.scan_anomaly_resolved") return "resolved";
  if (eventKey === "courier.scan_anomaly_dismissed") return "dismissed";
  return "fake_scan_suspected";
}

function fakeScanDefaultAction(eventKey: string) {
  if (eventKey === "courier.scan_anomaly_resolved") return "Confirm evidence and close the anomaly in Courier Control Tower.";
  if (eventKey === "courier.scan_anomaly_dismissed") return "Record false-positive reasoning and keep the audit trail seller-safe.";
  if (eventKey === "courier.scan_anomaly_escalated") return "Ops should request courier proof and keep escalation ownership until review closes.";
  if (eventKey === "courier.scan_location_mismatch") return "Ask courier for proof of scan location and compare with expected route.";
  if (eventKey === "courier.impossible_scan_sequence") return "Review shipment timeline and hold courier score impact until evidence is checked.";
  return "Review anomaly evidence and ask the courier for proof before applying score or merchant-facing action.";
}

function safeEvidenceRefs(values?: string[] | undefined) {
  return (values || [])
    .map((value) => cleanOptionalString(value))
    .filter((value): value is string => Boolean(value))
    .slice(0, 8);
}

export function buildFakeScanReviewSubject(input: {
  eventKey: string;
  courierPartnerName: string;
  detectedAt?: string | null | undefined;
}) {
  const date = cleanOptionalString(input.detectedAt)?.slice(0, 10) || isoDateInTimeZone();
  const subjectDate = formatMerchantDigestSubjectDate(date, "Asia/Kolkata");
  return `${fakeScanAlertLabel(input.eventKey)} - ${cleanOptionalString(input.courierPartnerName) || "Courier"} - ${subjectDate}`;
}

export function buildFakeScanReviewAutomationEvent(input: BuildFakeScanReviewAutomationEventInput): EmitAutomationEventInput {
  requireMerchantId(input.merchantId);
  const courierPartnerId = cleanOptionalString(input.courierPartnerId);
  const anomalyId = cleanOptionalString(input.anomalyId);
  if (!courierPartnerId) throw new Error("FAKE_SCAN_REVIEW_REQUIRES_COURIER_PARTNER_ID");
  if (!anomalyId) throw new Error("FAKE_SCAN_REVIEW_REQUIRES_ANOMALY_ID");

  const eventKey = input.eventKey;
  const merchantName = cleanOptionalString(input.merchantName) || "Merchant";
  const courierPartnerName = cleanOptionalString(input.courierPartnerName) || "Courier";
  const detectedAt = cleanOptionalString(input.detectedAt) || new Date().toISOString();
  const anomalyType = fakeScanAnomalyType(eventKey, input.anomalyType);
  const templateKey = fakeScanTemplateKey(eventKey);
  const awbMasked = cleanOptionalString(input.awbMasked) || (cleanOptionalString(input.awb) ? maskAwb(cleanOptionalString(input.awb)!) : undefined);
  const subject = buildFakeScanReviewSubject({
    eventKey,
    courierPartnerName,
    detectedAt
  });

  const payload: JsonMap = {
    eventIntent: "FAKE_SCAN_REVIEW_ALERT",
    merchantId: input.merchantId,
    merchantName,
    merchantEmail: cleanOptionalString(input.merchantEmail),
    eventKey,
    anomalyId,
    anomalyType,
    severity: normalizeFakeScanSeverity(input.severity),
    detectedAt,
    shipmentId: cleanOptionalString(input.shipmentId),
    orderId: cleanOptionalString(input.orderId),
    awbMasked,
    awbLast4: cleanOptionalString(input.awb)?.slice(-4),
    affectedShipmentCount: Math.max(0, Math.round(cleanOptionalNumber(input.affectedShipmentCount) ?? 0)),
    awbCount: Math.max(0, Math.round(cleanOptionalNumber(input.awbCount) ?? 0)),
    scanStatus: cleanOptionalString(input.scanStatus),
    previousStatus: cleanOptionalString(input.previousStatus),
    nextStatus: cleanOptionalString(input.nextStatus),
    scanTimestamp: cleanOptionalString(input.scanTimestamp),
    receivedAt: cleanOptionalString(input.receivedAt),
    delayMinutes: Math.max(0, Math.round(cleanOptionalNumber(input.delayMinutes) ?? 0)),
    locationSummary: cleanOptionalString(input.locationSummary),
    expectedLocationSummary: cleanOptionalString(input.expectedLocationSummary),
    routeSummary: cleanOptionalString(input.routeSummary),
    anomalyReasonCode: cleanOptionalString(input.anomalyReasonCode) || anomalyType.toUpperCase(),
    sellerSafeSummary: cleanOptionalString(input.sellerSafeSummary),
    opsReviewSummary: cleanOptionalString(input.opsReviewSummary) || "Ops should review courier scan evidence without exposing raw webhook payloads.",
    recommendedAction: cleanOptionalString(input.recommendedAction) || fakeScanDefaultAction(eventKey),
    evidenceRefs: safeEvidenceRefs(input.evidenceRefs),
    courierDashboardUrl: safeUrl(input.courierDashboardUrl),
    merchantImpactSummary: cleanOptionalString(input.merchantImpactSummary),
    courierPartnerId,
    courierPartnerName,
    courierPartner: {
      id: courierPartnerId,
      name: courierPartnerName
    },
    courierContact: {
      email: cleanOptionalString(input.courierEmail),
      emailMasked: maskEmail(input.courierEmail)
    },
    email: {
      subject
    },
    templateKey,
    channelPlan: {
      opsEscalationEnabled: input.opsEscalationEnabled !== false,
      merchantEmailEnabled: false,
      courierEmailEnabled: false,
      whatsappEnabled: false,
      preferredChannels: input.preferredChannels?.filter((channel) => ["EMAIL", "WHATSAPP", "INTERNAL"].includes(channel)) || ["EMAIL", "INTERNAL"],
      fallbackSenderAllowed: false,
      skippedChannelReasons: []
    }
  };

  return {
    merchantId: input.merchantId,
    eventKey,
    source: "fake-scan-review-alert",
    sourceId: anomalyId,
    idempotencyKey: `fake-scan-review:${courierPartnerId}:${anomalyType}:${anomalyId}:${eventKey}`,
    payload
  };
}

type CourierDailyDigestEventKey =
  | "courier.daily_digest_due"
  | "courier.daily_digest_generated"
  | "courier.daily_digest_failed"
  | "courier.daily_digest_sent"
  | "courier.ops_daily_digest_due"
  | "courier.partner_daily_digest_due";

type CourierDailyDigestScope = "OPS" | "COURIER_PARTNER";

export type BuildCourierDailyDigestAutomationEventInput = {
  merchantId: string;
  merchantName?: string | null | undefined;
  merchantEmail?: string | null | undefined;
  eventKey?: CourierDailyDigestEventKey | undefined;
  digestId: string;
  digestDate: string;
  timezone?: string | null | undefined;
  scope?: CourierDailyDigestScope | undefined;
  courierPartnerId?: string | null | undefined;
  courierPartnerName?: string | null | undefined;
  courierEmail?: string | null | undefined;
  pendingPickupCount?: number | null | undefined;
  missedPickupCount?: number | null | undefined;
  failedPickupCount?: number | null | undefined;
  slaBreachCount?: number | null | undefined;
  ndrBacklogCount?: number | null | undefined;
  reattemptPendingCount?: number | null | undefined;
  fakeScanReviewCount?: number | null | undefined;
  rtoDelayCount?: number | null | undefined;
  codRemittanceSlaIssueCount?: number | null | undefined;
  invoiceMismatchCount?: number | null | undefined;
  invoiceMismatchAmountPaise?: number | null | undefined;
  affectedMerchantCount?: number | null | undefined;
  affectedShipmentCount?: number | null | undefined;
  highSeverityCount?: number | null | undefined;
  criticalSeverityCount?: number | null | undefined;
  topIssues?: Array<string | Record<string, unknown>> | undefined;
  recommendedActions?: string[] | undefined;
  dashboardUrl?: string | null | undefined;
  preferredChannels?: string[] | undefined;
  opsEmailEnabled?: boolean | undefined;
  courierEmailEnabled?: boolean | undefined;
  internalAlertEnabled?: boolean | undefined;
};

function courierDailyDigestTemplateKey(eventKey: string, scope?: string | null | undefined) {
  if (eventKey === "courier.ops_daily_digest_due" || scope === "OPS") return "courier_ops_daily_digest_v1";
  if (eventKey === "courier.partner_daily_digest_due" || scope === "COURIER_PARTNER") return "courier_partner_daily_digest_v1";
  return COURIER_DAILY_DIGEST_TEMPLATE_BY_EVENT[eventKey] || "courier_daily_digest_v1";
}

function safeDigestCount(value: unknown) {
  return Math.max(0, Math.round(cleanOptionalNumber(value) ?? 0));
}

function safeDigestTopIssues(values?: Array<string | Record<string, unknown>> | undefined) {
  const issues = (values || [])
    .map((value) => {
      if (typeof value === "string") {
        const summary = cleanOptionalString(value);
        return summary ? { summary } : null;
      }
      const record = asRecord(value);
      const summary = cleanOptionalString(record.summary) || cleanOptionalString(record.title);
      if (!summary) return null;
      return {
        summary,
        count: cleanOptionalNumber(record.count),
        severity: cleanOptionalString(record.severity),
        recommendedAction: cleanOptionalString(record.recommendedAction) || cleanOptionalString(record.action)
      };
    })
    .filter(Boolean) as JsonMap[];
  return issues.slice(0, 8);
}

function safeDigestRecommendedActions(values?: string[] | undefined) {
  const normalized = (values || [])
    .map((value) => cleanOptionalString(value))
    .filter((value): value is string => Boolean(value))
    .slice(0, 8);
  return normalized.length ? normalized : [
    "Review high-severity courier exceptions first.",
    "Follow up pending pickups and NDR backlog before courier cutoff.",
    "Escalate repeated SLA and scan anomalies to Shipmastr ops."
  ];
}

export function buildCourierDailyDigestSubject(input: {
  scope?: CourierDailyDigestScope | string | null | undefined;
  courierPartnerName?: string | null | undefined;
  digestDate: string;
  timezone?: string | null | undefined;
}) {
  const subjectDate = formatMerchantDigestSubjectDate(input.digestDate, input.timezone || "Asia/Kolkata");
  if (input.scope === "COURIER_PARTNER") {
    return `${cleanOptionalString(input.courierPartnerName) || "Courier Partner"} Daily Digest - ${subjectDate}`;
  }
  if (input.scope === "OPS") {
    return `Shipmastr Courier Ops Daily Digest - ${subjectDate}`;
  }
  return `Courier Exceptions Summary - ${subjectDate}`;
}

export function buildCourierDailyDigestAutomationEvent(input: BuildCourierDailyDigestAutomationEventInput): EmitAutomationEventInput {
  requireMerchantId(input.merchantId);
  const digestId = cleanOptionalString(input.digestId);
  const digestDate = cleanOptionalString(input.digestDate);
  if (!digestId) throw new Error("COURIER_DAILY_DIGEST_REQUIRES_DIGEST_ID");
  if (!digestDate) throw new Error("COURIER_DAILY_DIGEST_REQUIRES_DIGEST_DATE");

  const scope = input.scope || (input.eventKey === "courier.partner_daily_digest_due" ? "COURIER_PARTNER" : "OPS");
  const eventKey = input.eventKey || (scope === "COURIER_PARTNER" ? "courier.partner_daily_digest_due" : "courier.ops_daily_digest_due");
  const courierPartnerId = cleanOptionalString(input.courierPartnerId);
  if (scope === "COURIER_PARTNER" && !courierPartnerId) {
    throw new Error("COURIER_DAILY_DIGEST_REQUIRES_COURIER_PARTNER_ID");
  }

  const timezone = cleanOptionalString(input.timezone) || "Asia/Kolkata";
  const courierPartnerName = cleanOptionalString(input.courierPartnerName);
  const templateKey = courierDailyDigestTemplateKey(eventKey, scope);
  const summary = {
    pendingPickupCount: safeDigestCount(input.pendingPickupCount),
    missedPickupCount: safeDigestCount(input.missedPickupCount),
    failedPickupCount: safeDigestCount(input.failedPickupCount),
    slaBreachCount: safeDigestCount(input.slaBreachCount),
    ndrBacklogCount: safeDigestCount(input.ndrBacklogCount),
    reattemptPendingCount: safeDigestCount(input.reattemptPendingCount),
    fakeScanReviewCount: safeDigestCount(input.fakeScanReviewCount),
    rtoDelayCount: safeDigestCount(input.rtoDelayCount),
    codRemittanceSlaIssueCount: safeDigestCount(input.codRemittanceSlaIssueCount),
    invoiceMismatchCount: safeDigestCount(input.invoiceMismatchCount),
    invoiceMismatchAmountPaise: safeDigestCount(input.invoiceMismatchAmountPaise),
    affectedMerchantCount: safeDigestCount(input.affectedMerchantCount),
    affectedShipmentCount: safeDigestCount(input.affectedShipmentCount),
    highSeverityCount: safeDigestCount(input.highSeverityCount),
    criticalSeverityCount: safeDigestCount(input.criticalSeverityCount)
  };
  const subject = buildCourierDailyDigestSubject({
    scope,
    courierPartnerName,
    digestDate,
    timezone
  });

  const payload: JsonMap = {
    eventIntent: "COURIER_DAILY_DIGEST",
    merchantId: input.merchantId,
    merchantName: cleanOptionalString(input.merchantName) || "Merchant",
    merchantEmail: cleanOptionalString(input.merchantEmail),
    eventKey,
    digestId,
    digestDate,
    timezone,
    scope,
    courierPartnerId,
    courierPartnerName,
    courierPartner: courierPartnerId ? {
      id: courierPartnerId,
      name: courierPartnerName || "Courier Partner"
    } : undefined,
    courierContact: {
      email: cleanOptionalString(input.courierEmail),
      emailMasked: maskEmail(input.courierEmail)
    },
    summary,
    topIssues: safeDigestTopIssues(input.topIssues),
    recommendedActions: safeDigestRecommendedActions(input.recommendedActions),
    dashboardUrl: safeUrl(input.dashboardUrl),
    email: {
      subject
    },
    templateKey,
    channelPlan: {
      opsEmailEnabled: input.opsEmailEnabled !== false && scope === "OPS",
      courierEmailEnabled: Boolean(input.courierEmailEnabled && scope === "COURIER_PARTNER"),
      internalAlertEnabled: input.internalAlertEnabled !== false,
      whatsappEnabled: false,
      preferredChannels: input.preferredChannels?.filter((channel) => ["EMAIL", "WHATSAPP", "INTERNAL"].includes(channel)) || ["EMAIL", "INTERNAL"],
      fallbackSenderAllowed: false,
      skippedChannelReasons: []
    }
  };

  return {
    merchantId: input.merchantId,
    eventKey,
    source: "courier-daily-digest",
    sourceId: digestId,
    idempotencyKey: `courier-daily-digest:${scope}:${courierPartnerId || "OPS"}:${digestDate}`,
    payload
  };
}

export async function runMerchantDailyDigest(input: {
  merchantId: string;
  digestDate?: string | undefined;
}) {
  requireMerchantId(input.merchantId);
  const merchant = await prisma.merchant.findUnique({
    where: { id: input.merchantId },
    select: { id: true, name: true, email: true }
  });

  if (!merchant) {
    throw new Error("MERCHANT_NOT_FOUND");
  }

  const preference = await prisma.automationPreference.upsert({
    where: { merchantId: merchant.id },
    create: { merchantId: merchant.id },
    update: {}
  });
  const timezone = preference.timezone || "Asia/Kolkata";
  const digestDate = input.digestDate || isoDateInTimeZone(new Date(), timezone);
  const summary = await buildMerchantDailyDigestSummary({
    merchantId: merchant.id,
    digestDate,
    timezone
  });
  const event = await emitAutomationEvent(buildMerchantDailyDigestAutomationEvent({
    merchantId: merchant.id,
    merchantName: merchant.name,
    merchantEmail: merchant.email,
    digestDate,
    timezone,
    summary: summary as JsonMap
  }));
  const dispatched = await dispatchAutomationEvent(event.id);

  return {
    merchant,
    event: dispatched,
    summary
  };
}

export async function runAbandonedCheckoutSmoke(input: {
  merchantId: string;
  mode?: "email_only" | "whatsapp_only" | "both" | "fallback_email" | undefined;
  cartId?: string | undefined;
  checkoutId?: string | undefined;
  buyerName?: string | undefined;
  buyerEmail?: string | undefined;
  buyerPhone?: string | undefined;
  recoveryUrl?: string | undefined;
  cartValuePaise?: number | undefined;
  itemCount?: number | undefined;
  recoveryWindowMinutes?: number | undefined;
}) {
  requireMerchantId(input.merchantId);
  const merchant = await prisma.merchant.findUnique({
    where: { id: input.merchantId },
    select: { id: true, name: true, email: true, phone: true }
  });

  if (!merchant) {
    throw new Error("MERCHANT_NOT_FOUND");
  }

  const mode = input.mode || "both";
  const emailMode = mode === "both" || mode === "email_only" || mode === "fallback_email";
  const whatsappMode = mode === "both" || mode === "whatsapp_only";
  const cartId = cleanOptionalString(input.cartId) || `smoke_cart_${Date.now()}`;
  const storeName = merchant.name || "Shipmastr Demo Store";
  const event = await emitAutomationEvent(buildAbandonedCheckoutAutomationEvent({
    merchantId: merchant.id,
    merchantName: merchant.name,
    storeName,
    cartId,
    checkoutId: input.checkoutId || `checkout_${cartId}`,
    buyerName: input.buyerName || "Preview Buyer",
    buyerEmail: input.buyerEmail || "buyer@example.com",
    buyerPhone: input.buyerPhone || "+919999999999",
    emailMarketingConsent: emailMode,
    whatsappMarketingConsent: whatsappMode,
    cartValuePaise: input.cartValuePaise ?? 249900,
    itemCount: input.itemCount ?? 2,
    recoveryWindowMinutes: input.recoveryWindowMinutes ?? 45,
    recoveryUrl: input.recoveryUrl || `https://shipmastr.com/checkout/recover/${cartId}`,
    preferredChannels: mode === "email_only" || mode === "fallback_email"
      ? ["EMAIL"]
      : mode === "whatsapp_only"
        ? ["WHATSAPP"]
        : ["EMAIL", "WHATSAPP"]
  }));
  const dispatched = await dispatchAutomationEvent(event.id);

  return {
    merchant,
    event: dispatched,
    mode
  };
}

function repeatBuyerId(input: { merchantId: string; buyerId?: string | undefined; buyerEmail?: string | undefined; buyerPhone?: string | undefined }) {
  const explicit = cleanOptionalString(input.buyerId);
  if (explicit) return explicit;
  const subject = cleanOptionalString(input.buyerEmail)?.toLowerCase() || cleanOptionalString(input.buyerPhone);
  if (!subject) throw new Error("REPEAT_BUYER_REQUIRES_SAFE_BUYER_REFERENCE");
  return `buyer_${createHash("sha256").update(`${input.merchantId}:${subject}`).digest("hex").slice(0, 24)}`;
}

export async function runRepeatBuyerSmoke(input: {
  merchantId: string;
  mode?: "email_only" | "whatsapp_only" | "both" | "fallback_email" | undefined;
  buyerId?: string | undefined;
  buyerName?: string | undefined;
  buyerEmail?: string | undefined;
  buyerPhone?: string | undefined;
  lastOrderId?: string | undefined;
  lastOrderDate?: string | undefined;
  daysSinceLastOrder?: number | undefined;
  storeUrl?: string | undefined;
  recommendedOffer?: string | undefined;
}) {
  requireMerchantId(input.merchantId);
  const [merchant, preference] = await Promise.all([
    prisma.merchant.findUnique({
      where: { id: input.merchantId },
      select: { id: true, name: true, email: true, phone: true }
    }),
    prisma.automationPreference.upsert({
      where: { merchantId: input.merchantId },
      create: { merchantId: input.merchantId },
      update: {}
    })
  ]);

  if (!merchant) {
    throw new Error("MERCHANT_NOT_FOUND");
  }

  const metadata = repeatBuyerPreferenceMetadata(preference.metadata);
  const mode = input.mode || "both";
  const emailMode = mode === "both" || mode === "email_only" || mode === "fallback_email";
  const whatsappMode = mode === "both" || mode === "whatsapp_only";
  const buyerPhone = cleanOptionalString(input.buyerPhone) || merchant.phone || undefined;
  const buyerEmail = cleanOptionalString(input.buyerEmail) || "buyer@example.com";
  const lastOrder = input.lastOrderId
    ? await prisma.order.findFirst({
      where: {
        merchantId: input.merchantId,
        OR: [{ id: input.lastOrderId }, { externalOrderId: input.lastOrderId }],
        status: "DELIVERED"
      },
      orderBy: { createdAt: "desc" }
    })
    : buyerPhone
      ? await prisma.order.findFirst({
        where: {
          merchantId: input.merchantId,
          buyerPhone,
          status: "DELIVERED"
        },
        orderBy: { createdAt: "desc" }
      })
      : null;

  if (!lastOrder) {
    throw new Error("REPEAT_BUYER_PREVIOUS_DELIVERED_ORDER_REQUIRED");
  }

  const lastOrderDate = input.lastOrderDate || lastOrder.createdAt.toISOString();
  const daysSinceLastOrder = daysBetween(lastOrderDate) ?? 0;
  if (daysSinceLastOrder < metadata.repeatBuyerWindowDays) {
    throw new Error("REPEAT_BUYER_WINDOW_NOT_REACHED");
  }

  const event = await emitAutomationEvent(buildRepeatBuyerAutomationEvent({
    merchantId: merchant.id,
    merchantName: merchant.name,
    storeName: merchant.name || "Shipmastr Demo Store",
    buyerId: repeatBuyerId({
      merchantId: merchant.id,
      buyerId: input.buyerId,
      buyerEmail,
      buyerPhone
    }),
    buyerName: input.buyerName || "Preview Buyer",
    buyerEmail,
    buyerPhone,
    emailMarketingConsent: emailMode,
    whatsappMarketingConsent: whatsappMode,
    lastOrderId: input.lastOrderId || lastOrder?.id || "smoke_last_order",
    lastOrderDate,
    daysSinceLastOrder,
    lastPurchasedCategories: ["New arrivals"],
    suggestedProducts: [
      { title: "Fresh arrivals", url: input.storeUrl || "https://shipmastr.com/" }
    ],
    recommendedOffer: input.recommendedOffer,
    storeUrl: input.storeUrl || "https://shipmastr.com/",
    preferredChannels: mode === "email_only" || mode === "fallback_email"
      ? ["EMAIL"]
      : mode === "whatsapp_only"
        ? ["WHATSAPP"]
        : ["EMAIL", "WHATSAPP"]
  }));
  const dispatched = await dispatchAutomationEvent(event.id);

  return {
    merchant,
    event: dispatched,
    mode
  };
}

export async function runCodRemittanceSmoke(input: {
  merchantId: string;
  alertType?: "due" | "delayed" | "settled" | "mismatch" | undefined;
  mode?: "email_only" | "whatsapp_only" | "both" | "admin_escalation" | undefined;
  remittanceId?: string | undefined;
  courierPartnerId?: string | undefined;
  courierPartnerName?: string | undefined;
  settlementDate?: string | undefined;
  dueDate?: string | undefined;
  codAmountPaise?: number | undefined;
  expectedAmountPaise?: number | undefined;
  receivedAmountPaise?: number | undefined;
  mismatchAmountPaise?: number | undefined;
  shipmentCount?: number | undefined;
  awbCount?: number | undefined;
  financeSummaryUrl?: string | undefined;
}) {
  requireMerchantId(input.merchantId);
  const merchant = await prisma.merchant.findUnique({
    where: { id: input.merchantId },
    select: { id: true, name: true, email: true }
  });

  if (!merchant) {
    throw new Error("MERCHANT_NOT_FOUND");
  }

  const alertType = input.alertType || "due";
  const eventKey: CodRemittanceEventKey = alertType === "delayed"
    ? "cod.remittance_delayed"
    : alertType === "settled"
      ? "cod.remittance_settled"
      : alertType === "mismatch"
        ? "cod.remittance_mismatch_detected"
        : "cod.remittance_due";
  const mode = input.mode || "email_only";
  const preferredChannels = mode === "whatsapp_only"
    ? ["WHATSAPP"]
    : mode === "both"
      ? ["EMAIL", "WHATSAPP"]
      : ["EMAIL"];
  const remittanceId = cleanOptionalString(input.remittanceId) || `smoke_cod_${Date.now()}`;
  const event = await emitAutomationEvent(buildCodRemittanceAlertAutomationEvent({
    merchantId: merchant.id,
    merchantName: merchant.name,
    merchantEmail: merchant.email,
    eventKey,
    remittanceId,
    courierPartnerId: input.courierPartnerId || "courier_smoke",
    courierPartnerName: input.courierPartnerName || "Smoke Courier",
    settlementDate: input.settlementDate,
    dueDate: input.dueDate || isoDateInTimeZone(),
    codAmountPaise: input.codAmountPaise ?? 125000,
    expectedAmountPaise: input.expectedAmountPaise ?? input.codAmountPaise ?? 125000,
    receivedAmountPaise: input.receivedAmountPaise ?? (alertType === "mismatch" ? 95000 : input.expectedAmountPaise ?? input.codAmountPaise ?? 125000),
    mismatchAmountPaise: input.mismatchAmountPaise,
    shipmentCount: input.shipmentCount ?? 12,
    awbCount: input.awbCount ?? 12,
    actionRequired: mode === "admin_escalation"
      ? "Shipmastr finance should escalate this remittance with courier ops."
      : undefined,
    financeSummaryUrl: input.financeSummaryUrl || "https://shipmastr.com/seller/merchant/autopilot?tab=finance-control",
    preferredChannels
  }));
  const dispatched = await dispatchAutomationEvent(event.id);

  return {
    merchant,
    event: dispatched,
    alertType,
    mode
  };
}

export async function runSellerSettlementSmoke(input: {
  merchantId: string;
  alertType?: "generated" | "scheduled" | "paid" | "held" | "adjusted" | undefined;
  mode?: "email_only" | "whatsapp_only" | "both" | undefined;
  settlementId?: string | undefined;
  settlementStatus?: string | undefined;
  settlementDate?: string | undefined;
  expectedPayoutDate?: string | undefined;
  paidAt?: string | undefined;
  grossCodAmountPaise?: number | undefined;
  shippingChargesPaise?: number | undefined;
  platformFeesPaise?: number | undefined;
  adjustmentAmountPaise?: number | undefined;
  holdAmountPaise?: number | undefined;
  disputeAmountPaise?: number | undefined;
  netPayableAmountPaise?: number | undefined;
  shipmentCount?: number | undefined;
  awbCount?: number | undefined;
  statementUrl?: string | undefined;
}) {
  requireMerchantId(input.merchantId);
  const merchant = await prisma.merchant.findUnique({
    where: { id: input.merchantId },
    select: { id: true, name: true, email: true }
  });

  if (!merchant) {
    throw new Error("MERCHANT_NOT_FOUND");
  }

  const alertType = input.alertType || "generated";
  const eventKey: SellerSettlementEventKey = alertType === "scheduled"
    ? "seller.settlement_scheduled"
    : alertType === "paid"
      ? "seller.settlement_paid"
      : alertType === "held"
        ? "seller.settlement_held"
        : alertType === "adjusted"
          ? "seller.settlement_adjusted"
          : "seller.settlement_generated";
  const mode = input.mode || "email_only";
  const preferredChannels = mode === "whatsapp_only"
    ? ["WHATSAPP"]
    : mode === "both"
      ? ["EMAIL", "WHATSAPP"]
      : ["EMAIL"];
  const settlementId = cleanOptionalString(input.settlementId) || `smoke_settlement_${Date.now()}`;
  const event = await emitAutomationEvent(buildSellerSettlementSummaryAutomationEvent({
    merchantId: merchant.id,
    merchantName: merchant.name,
    merchantEmail: merchant.email,
    eventKey,
    settlementId,
    settlementStatus: input.settlementStatus,
    settlementDate: input.settlementDate || isoDateInTimeZone(),
    expectedPayoutDate: input.expectedPayoutDate,
    paidAt: input.paidAt,
    grossCodAmountPaise: input.grossCodAmountPaise ?? 180000,
    shippingChargesPaise: input.shippingChargesPaise ?? 25000,
    platformFeesPaise: input.platformFeesPaise ?? 5000,
    adjustmentAmountPaise: input.adjustmentAmountPaise ?? (alertType === "adjusted" ? 1200 : 0),
    holdAmountPaise: input.holdAmountPaise ?? (alertType === "held" ? 45000 : 0),
    disputeAmountPaise: input.disputeAmountPaise ?? 0,
    netPayableAmountPaise: input.netPayableAmountPaise ?? (alertType === "held" ? 105000 : 150000),
    shipmentCount: input.shipmentCount ?? 18,
    awbCount: input.awbCount ?? 18,
    statementUrl: input.statementUrl || "https://shipmastr.com/seller/merchant/autopilot?tab=finance-control",
    preferredChannels
  }));
  const dispatched = await dispatchAutomationEvent(event.id);

  return {
    merchant,
    event: dispatched,
    alertType,
    mode
  };
}

export async function runInvoiceMismatchSmoke(input: {
  merchantId: string;
  alertType?: "mismatch" | "duplicate_awb" | "weight_discrepancy" | "zone_mismatch" | "rto_charge_mismatch" | "cod_fee_mismatch" | "resolved" | "dispute_created" | undefined;
  mode?: "email_only" | "whatsapp_only" | "both" | "admin_escalation" | undefined;
  invoiceId?: string | undefined;
  mismatchId?: string | undefined;
  courierPartnerId?: string | undefined;
  courierPartnerName?: string | undefined;
  severity?: InvoiceMismatchSeverity | undefined;
  invoiceDate?: string | undefined;
  detectedAt?: string | undefined;
  awbCount?: number | undefined;
  affectedShipmentCount?: number | undefined;
  expectedAmountPaise?: number | undefined;
  billedAmountPaise?: number | undefined;
  mismatchAmountPaise?: number | undefined;
  financeSummaryUrl?: string | undefined;
  disputeUrl?: string | undefined;
}) {
  requireMerchantId(input.merchantId);
  const merchant = await prisma.merchant.findUnique({
    where: { id: input.merchantId },
    select: { id: true, name: true, email: true }
  });

  if (!merchant) {
    throw new Error("MERCHANT_NOT_FOUND");
  }

  const alertType = input.alertType || "mismatch";
  const eventKey: InvoiceMismatchEventKey = alertType === "duplicate_awb"
    ? "invoice.duplicate_awb_charge_detected"
    : alertType === "weight_discrepancy"
      ? "invoice.weight_discrepancy_detected"
      : alertType === "zone_mismatch"
        ? "invoice.zone_mismatch_detected"
        : alertType === "rto_charge_mismatch"
          ? "invoice.rto_charge_mismatch_detected"
          : alertType === "cod_fee_mismatch"
            ? "invoice.cod_fee_mismatch_detected"
            : alertType === "resolved"
              ? "invoice.resolved"
              : alertType === "dispute_created"
                ? "invoice.dispute_created"
                : "invoice.mismatch_detected";
  const mode = input.mode || "email_only";
  const preferredChannels = mode === "whatsapp_only"
    ? ["WHATSAPP"]
    : mode === "both"
      ? ["EMAIL", "WHATSAPP"]
      : mode === "admin_escalation"
        ? ["EMAIL", "INTERNAL"]
        : ["EMAIL"];
  const invoiceId = cleanOptionalString(input.invoiceId) || `smoke_invoice_${Date.now()}`;
  const mismatchId = cleanOptionalString(input.mismatchId) || `smoke_mismatch_${Date.now()}`;
  const event = await emitAutomationEvent(buildInvoiceMismatchAutomationEvent({
    merchantId: merchant.id,
    merchantName: merchant.name,
    merchantEmail: merchant.email,
    eventKey,
    invoiceId,
    mismatchId,
    courierPartnerId: input.courierPartnerId || "courier_smoke",
    courierPartnerName: input.courierPartnerName || "Smoke Courier",
    mismatchType: invoiceMismatchType(eventKey),
    severity: input.severity || (alertType === "resolved" ? "LOW" : "HIGH"),
    invoiceDate: input.invoiceDate || isoDateInTimeZone(),
    detectedAt: input.detectedAt || new Date().toISOString(),
    awbCount: input.awbCount ?? (alertType === "duplicate_awb" ? 2 : 9),
    affectedShipmentCount: input.affectedShipmentCount ?? (alertType === "weight_discrepancy" ? 4 : 3),
    expectedAmountPaise: input.expectedAmountPaise ?? 175000,
    billedAmountPaise: input.billedAmountPaise ?? (alertType === "resolved" ? 175000 : 205000),
    mismatchAmountPaise: input.mismatchAmountPaise,
    actionRequired: mode === "admin_escalation"
      ? "Shipmastr finance should review and create a courier dispute if the mismatch is confirmed."
      : undefined,
    financeSummaryUrl: input.financeSummaryUrl || "https://shipmastr.com/seller/merchant/autopilot?tab=finance-control",
    disputeUrl: input.disputeUrl,
    preferredChannels,
    adminEscalationEnabled: mode === "admin_escalation"
  }));
  const dispatched = await dispatchAutomationEvent(event.id);

  return {
    merchant,
    event: dispatched,
    alertType,
    mode
  };
}

export async function runCourierPickupDelaySmoke(input: {
  merchantId: string;
  alertType?: "delay" | "missed" | "failed" | "escalated" | "resolved" | undefined;
  mode?: "delay" | "missed" | "failed" | "escalated" | "resolved" | "merchant_email" | "courier_email" | "ops_escalation" | "both" | "whatsapp_only" | undefined;
  pickupId?: string | undefined;
  courierPartnerId?: string | undefined;
  courierPartnerName?: string | undefined;
  courierEmail?: string | undefined;
  pickupDate?: string | undefined;
  scheduledPickupWindow?: string | undefined;
  delayMinutes?: number | undefined;
  affectedShipmentCount?: number | undefined;
  awbCount?: number | undefined;
  oldestAwbAgeMinutes?: number | undefined;
  pickupLocationSummary?: string | undefined;
  city?: string | undefined;
  state?: string | undefined;
  pincode?: string | undefined;
  severity?: CourierPickupSeverity | undefined;
  pickupDashboardUrl?: string | undefined;
}) {
  requireMerchantId(input.merchantId);
  const merchant = await prisma.merchant.findUnique({
    where: { id: input.merchantId },
    select: { id: true, name: true, email: true }
  });

  if (!merchant) {
    throw new Error("MERCHANT_NOT_FOUND");
  }

  const alertType = input.alertType || "delay";
  const eventKey: CourierPickupDelayEventKey = alertType === "missed"
    ? "courier.pickup_missed"
    : alertType === "failed"
      ? "courier.pickup_failed"
      : alertType === "escalated"
        ? "courier.pickup_escalated"
        : alertType === "resolved"
          ? "courier.pickup_resolved"
          : "courier.pickup_delay_detected";
  const mode = input.mode || "both";
  const preferredChannels = mode === "whatsapp_only"
    ? ["WHATSAPP"]
    : mode === "ops_escalation"
      ? ["EMAIL", "INTERNAL"]
      : mode === "courier_email" || mode === "merchant_email"
        ? ["EMAIL"]
        : ["EMAIL", "INTERNAL", "WHATSAPP"];
  const pickupId = cleanOptionalString(input.pickupId) || `smoke_pickup_${Date.now()}`;
  const event = await emitAutomationEvent(buildCourierPickupDelayAutomationEvent({
    merchantId: merchant.id,
    merchantName: merchant.name,
    merchantEmail: mode === "courier_email" ? undefined : merchant.email,
    courierPartnerId: input.courierPartnerId || "courier_smoke",
    courierPartnerName: input.courierPartnerName || "Smoke Courier",
    courierEmail: mode === "merchant_email" ? undefined : input.courierEmail || "pickup.ops@example.com",
    eventKey,
    pickupId,
    pickupDate: input.pickupDate || isoDateInTimeZone(),
    scheduledPickupWindow: input.scheduledPickupWindow || "14:00-17:00",
    delayMinutes: input.delayMinutes ?? (alertType === "resolved" ? 0 : 95),
    affectedShipmentCount: input.affectedShipmentCount ?? 12,
    awbCount: input.awbCount ?? 12,
    oldestAwbAgeMinutes: input.oldestAwbAgeMinutes ?? 180,
    pickupLocationSummary: input.pickupLocationSummary || "Warehouse cluster, Andheri East",
    city: input.city || "Mumbai",
    state: input.state || "Maharashtra",
    pincode: input.pincode || "400059",
    severity: input.severity || (alertType === "resolved" ? "LOW" : alertType === "escalated" ? "CRITICAL" : "HIGH"),
    actionRequired: mode === "ops_escalation"
      ? "Shipmastr ops should contact courier control and keep the seller updated until pickup is recovered."
      : undefined,
    pickupDashboardUrl: input.pickupDashboardUrl || "https://shipmastr.com/seller/merchant/autopilot?tab=courier-control-tower",
    preferredChannels,
    opsEscalationEnabled: mode === "ops_escalation" || alertType === "escalated"
  }));
  const dispatched = await dispatchAutomationEvent(event.id);

  return {
    merchant,
    event: dispatched,
    alertType,
    mode
  };
}

export async function runCourierSlaBreachSmoke(input: {
  merchantId: string;
  alertType?: "general" | "pickup" | "first_scan" | "in_transit" | "ofd" | "ndr_response" | "reattempt" | "rto" | "cod_remittance" | "escalated" | "resolved" | undefined;
  mode?: "pickup" | "first_scan" | "in_transit" | "ofd" | "ndr_response" | "reattempt" | "rto" | "cod_remittance" | "escalated" | "resolved" | "merchant_email" | "courier_email" | "ops_escalation" | "finance_escalation" | "both" | "whatsapp_only" | undefined;
  breachId?: string | undefined;
  breachType?: string | undefined;
  courierPartnerId?: string | undefined;
  courierPartnerName?: string | undefined;
  courierEmail?: string | undefined;
  detectedAt?: string | undefined;
  slaTarget?: string | undefined;
  actualValue?: string | number | undefined;
  breachMinutes?: number | undefined;
  affectedShipmentCount?: number | undefined;
  awbCount?: number | undefined;
  sampleAwbs?: string[] | undefined;
  city?: string | undefined;
  state?: string | undefined;
  pincode?: string | undefined;
  laneSummary?: string | undefined;
  severity?: CourierSlaSeverity | undefined;
  courierDashboardUrl?: string | undefined;
}) {
  requireMerchantId(input.merchantId);
  const merchant = await prisma.merchant.findUnique({
    where: { id: input.merchantId },
    select: { id: true, name: true, email: true }
  });

  if (!merchant) {
    throw new Error("MERCHANT_NOT_FOUND");
  }

  const alertType = input.alertType || "pickup";
  const eventKey: CourierSlaBreachEventKey = alertType === "first_scan"
    ? "courier.first_scan_sla_breach"
    : alertType === "in_transit"
      ? "courier.in_transit_sla_breach"
      : alertType === "ofd"
        ? "courier.ofd_sla_breach"
        : alertType === "ndr_response"
          ? "courier.ndr_response_sla_breach"
          : alertType === "reattempt"
            ? "courier.reattempt_sla_breach"
            : alertType === "rto"
              ? "courier.rto_sla_breach"
              : alertType === "cod_remittance"
                ? "courier.cod_remittance_sla_breach"
                : alertType === "escalated"
                  ? "courier.sla_breach_escalated"
                  : alertType === "resolved"
                    ? "courier.sla_breach_resolved"
                    : alertType === "general"
                      ? "courier.sla_breach_detected"
                      : "courier.pickup_sla_breach";
  const mode = input.mode || "both";
  const preferredChannels = mode === "whatsapp_only"
    ? ["WHATSAPP"]
    : mode === "ops_escalation" || mode === "finance_escalation"
      ? ["EMAIL", "INTERNAL"]
      : mode === "courier_email" || mode === "merchant_email"
        ? ["EMAIL"]
        : ["EMAIL", "INTERNAL", "WHATSAPP"];
  const breachId = cleanOptionalString(input.breachId) || `smoke_sla_${Date.now()}`;
  const event = await emitAutomationEvent(buildCourierSlaBreachAutomationEvent({
    merchantId: merchant.id,
    merchantName: merchant.name,
    merchantEmail: mode === "courier_email" ? undefined : merchant.email,
    courierPartnerId: input.courierPartnerId || "courier_smoke",
    courierPartnerName: input.courierPartnerName || "Smoke Courier",
    courierEmail: mode === "merchant_email" ? undefined : input.courierEmail || "sla.ops@example.com",
    eventKey,
    breachId,
    breachType: input.breachType,
    detectedAt: input.detectedAt || new Date().toISOString(),
    slaTarget: input.slaTarget || (eventKey === "courier.cod_remittance_sla_breach" ? "T+2 remittance" : "Courier SLA target"),
    actualValue: input.actualValue || (eventKey === "courier.cod_remittance_sla_breach" ? "T+5" : "180 minutes"),
    breachMinutes: input.breachMinutes ?? (alertType === "resolved" ? 0 : 180),
    affectedShipmentCount: input.affectedShipmentCount ?? (eventKey === "courier.cod_remittance_sla_breach" ? 18 : 14),
    awbCount: input.awbCount ?? 14,
    sampleAwbs: input.sampleAwbs || ["BLISS17774438577588613", "BLISS17774438577588614"],
    city: input.city || "Mumbai",
    state: input.state || "Maharashtra",
    pincode: input.pincode || "400059",
    laneSummary: input.laneSummary || "Mumbai metro lane",
    severity: input.severity || (alertType === "resolved" ? "LOW" : alertType === "escalated" || alertType === "cod_remittance" ? "CRITICAL" : "HIGH"),
    actionRequired: mode === "ops_escalation"
      ? "Shipmastr ops should hold courier control accountable until SLA recovery is confirmed."
      : mode === "finance_escalation"
        ? "Shipmastr finance should verify COD ageing and open courier follow-up."
        : undefined,
    courierDashboardUrl: input.courierDashboardUrl || "https://shipmastr.com/seller/merchant/autopilot?tab=courier-control-tower",
    merchantImpactSummary: "Affected shipments are scoped to this merchant only.",
    preferredChannels,
    opsEscalationEnabled: mode === "ops_escalation" || alertType === "escalated" || input.severity === "CRITICAL",
    financeEscalationEnabled: mode === "finance_escalation" || eventKey === "courier.cod_remittance_sla_breach"
  }));
  const dispatched = await dispatchAutomationEvent(event.id);

  return {
    merchant,
    event: dispatched,
    alertType,
    mode
  };
}

export async function runFakeScanReviewSmoke(input: {
  merchantId: string;
  alertType?: "general" | "pickup_fake" | "delivery_attempt_fake" | "ndr_fake" | "late_scan" | "impossible_sequence" | "location_mismatch" | "duplicate_pattern" | "after_terminal_state" | "escalated" | "resolved" | "dismissed" | undefined;
  mode?: "pickup_fake" | "delivery_attempt_fake" | "ndr_fake" | "late_scan" | "impossible_sequence" | "location_mismatch" | "duplicate_pattern" | "after_terminal_state" | "escalated" | "resolved" | "dismissed" | "ops_internal" | "merchant_email" | "courier_email" | "both" | "whatsapp_only" | undefined;
  anomalyId?: string | undefined;
  anomalyType?: string | undefined;
  courierPartnerId?: string | undefined;
  courierPartnerName?: string | undefined;
  courierEmail?: string | undefined;
  detectedAt?: string | undefined;
  shipmentId?: string | undefined;
  orderId?: string | undefined;
  awb?: string | undefined;
  affectedShipmentCount?: number | undefined;
  awbCount?: number | undefined;
  scanStatus?: string | undefined;
  previousStatus?: string | undefined;
  nextStatus?: string | undefined;
  scanTimestamp?: string | undefined;
  receivedAt?: string | undefined;
  delayMinutes?: number | undefined;
  locationSummary?: string | undefined;
  expectedLocationSummary?: string | undefined;
  routeSummary?: string | undefined;
  anomalyReasonCode?: string | undefined;
  sellerSafeSummary?: string | undefined;
  opsReviewSummary?: string | undefined;
  severity?: FakeScanSeverity | undefined;
  courierDashboardUrl?: string | undefined;
}) {
  requireMerchantId(input.merchantId);
  const merchant = await prisma.merchant.findUnique({
    where: { id: input.merchantId },
    select: { id: true, name: true, email: true }
  });

  if (!merchant) {
    throw new Error("MERCHANT_NOT_FOUND");
  }

  const alertType = input.alertType || "pickup_fake";
  const eventKey: FakeScanReviewEventKey = alertType === "delivery_attempt_fake"
    ? "courier.delivery_attempt_suspected_fake"
    : alertType === "ndr_fake"
      ? "courier.ndr_scan_suspected_fake"
      : alertType === "late_scan"
        ? "courier.late_scan_detected"
        : alertType === "impossible_sequence"
          ? "courier.impossible_scan_sequence"
          : alertType === "location_mismatch"
            ? "courier.scan_location_mismatch"
            : alertType === "duplicate_pattern"
              ? "courier.duplicate_scan_pattern"
              : alertType === "after_terminal_state"
                ? "courier.scan_after_terminal_state"
                : alertType === "escalated"
                  ? "courier.scan_anomaly_escalated"
                  : alertType === "resolved"
                    ? "courier.scan_anomaly_resolved"
                    : alertType === "dismissed"
                      ? "courier.scan_anomaly_dismissed"
                      : alertType === "general"
                        ? "courier.fake_scan_suspected"
                        : "courier.pickup_scan_suspected_fake";
  const mode = input.mode || "ops_internal";
  const preferredChannels = mode === "whatsapp_only"
    ? ["WHATSAPP"]
    : mode === "merchant_email" || mode === "courier_email"
      ? ["EMAIL"]
      : ["EMAIL", "INTERNAL", "WHATSAPP"];
  const anomalyId = cleanOptionalString(input.anomalyId) || `smoke_scan_${Date.now()}`;
  const event = await emitAutomationEvent(buildFakeScanReviewAutomationEvent({
    merchantId: merchant.id,
    merchantName: merchant.name,
    merchantEmail: mode === "courier_email" ? undefined : merchant.email,
    courierPartnerId: input.courierPartnerId || "courier_smoke",
    courierPartnerName: input.courierPartnerName || "Smoke Courier",
    courierEmail: mode === "merchant_email" ? undefined : input.courierEmail || "scan.ops@example.com",
    eventKey,
    anomalyId,
    anomalyType: input.anomalyType,
    detectedAt: input.detectedAt || new Date().toISOString(),
    shipmentId: input.shipmentId || "shipment_scan_smoke",
    orderId: input.orderId || "order_scan_smoke",
    awb: input.awb || "BLISS17774438577588613",
    affectedShipmentCount: input.affectedShipmentCount ?? (alertType === "duplicate_pattern" ? 6 : 1),
    awbCount: input.awbCount ?? (alertType === "duplicate_pattern" ? 6 : 1),
    scanStatus: input.scanStatus || (eventKey === "courier.ndr_scan_suspected_fake" ? "NDR" : "PICKUP_DONE"),
    previousStatus: input.previousStatus || "BOOKED",
    nextStatus: input.nextStatus || "FIRST_SCAN_PENDING",
    scanTimestamp: input.scanTimestamp || "2026-05-17T08:00:00.000Z",
    receivedAt: input.receivedAt || "2026-05-17T12:30:00.000Z",
    delayMinutes: input.delayMinutes ?? (eventKey === "courier.late_scan_detected" ? 270 : 45),
    locationSummary: input.locationSummary || "Courier scan city: Mumbai",
    expectedLocationSummary: input.expectedLocationSummary || "Expected pickup city: Mumbai",
    routeSummary: input.routeSummary || "Mumbai local pickup lane",
    anomalyReasonCode: input.anomalyReasonCode,
    sellerSafeSummary: input.sellerSafeSummary || "Courier scan timing needs Shipmastr ops review.",
    opsReviewSummary: input.opsReviewSummary || "Compare scan timestamp, received timestamp, route, and courier proof before taking action.",
    severity: input.severity || (alertType === "resolved" || alertType === "dismissed" ? "LOW" : alertType === "escalated" ? "CRITICAL" : "HIGH"),
    courierDashboardUrl: input.courierDashboardUrl || "https://shipmastr.com/seller/merchant/autopilot?tab=courier-control-tower",
    merchantImpactSummary: "Affected scan summary is scoped to this merchant only.",
    preferredChannels,
    opsEscalationEnabled: mode === "ops_internal" || mode === "both" || alertType === "escalated"
  }));
  const dispatched = await dispatchAutomationEvent(event.id);

  return {
    merchant,
    event: dispatched,
    alertType,
    mode
  };
}

export async function runCourierDailyDigestSmoke(input: {
  merchantId: string;
  scope?: "OPS" | "COURIER_PARTNER" | undefined;
  mode?: "ops" | "courier_partner" | "email_only" | "internal_only" | "both" | "whatsapp_only" | "failure" | undefined;
  digestId?: string | undefined;
  digestDate?: string | undefined;
  timezone?: string | undefined;
  courierPartnerId?: string | undefined;
  courierPartnerName?: string | undefined;
  courierEmail?: string | undefined;
  pendingPickupCount?: number | undefined;
  missedPickupCount?: number | undefined;
  failedPickupCount?: number | undefined;
  slaBreachCount?: number | undefined;
  ndrBacklogCount?: number | undefined;
  reattemptPendingCount?: number | undefined;
  fakeScanReviewCount?: number | undefined;
  rtoDelayCount?: number | undefined;
  codRemittanceSlaIssueCount?: number | undefined;
  invoiceMismatchCount?: number | undefined;
  invoiceMismatchAmountPaise?: number | undefined;
  affectedMerchantCount?: number | undefined;
  affectedShipmentCount?: number | undefined;
  highSeverityCount?: number | undefined;
  criticalSeverityCount?: number | undefined;
  topIssues?: Array<string | Record<string, unknown>> | undefined;
  recommendedActions?: string[] | undefined;
  dashboardUrl?: string | undefined;
}) {
  requireMerchantId(input.merchantId);
  const merchant = await prisma.merchant.findUnique({
    where: { id: input.merchantId },
    select: { id: true, name: true, email: true }
  });

  if (!merchant) {
    throw new Error("MERCHANT_NOT_FOUND");
  }

  const mode = input.mode || "ops";
  const scope = input.scope || (mode === "courier_partner" ? "COURIER_PARTNER" : "OPS");
  const eventKey: CourierDailyDigestEventKey = scope === "COURIER_PARTNER"
    ? "courier.partner_daily_digest_due"
    : "courier.ops_daily_digest_due";
  const preferredChannels = mode === "whatsapp_only"
    ? ["WHATSAPP"]
    : mode === "internal_only"
      ? ["EMAIL", "INTERNAL"]
      : ["EMAIL", "INTERNAL", "WHATSAPP"];
  const digestId = cleanOptionalString(input.digestId) || `courier_digest_${Date.now()}`;
  const event = await emitAutomationEvent(buildCourierDailyDigestAutomationEvent({
    merchantId: merchant.id,
    merchantName: merchant.name,
    merchantEmail: merchant.email,
    eventKey,
    digestId,
    digestDate: input.digestDate || isoDateInTimeZone(),
    timezone: input.timezone || "Asia/Kolkata",
    scope,
    courierPartnerId: input.courierPartnerId || (scope === "COURIER_PARTNER" ? "courier_smoke" : undefined),
    courierPartnerName: input.courierPartnerName || (scope === "COURIER_PARTNER" ? "Smoke Courier" : undefined),
    courierEmail: scope === "COURIER_PARTNER" ? input.courierEmail || "courier.digest@example.com" : undefined,
    pendingPickupCount: input.pendingPickupCount ?? 18,
    missedPickupCount: input.missedPickupCount ?? 3,
    failedPickupCount: input.failedPickupCount ?? 2,
    slaBreachCount: input.slaBreachCount ?? 7,
    ndrBacklogCount: input.ndrBacklogCount ?? 11,
    reattemptPendingCount: input.reattemptPendingCount ?? 5,
    fakeScanReviewCount: input.fakeScanReviewCount ?? 4,
    rtoDelayCount: input.rtoDelayCount ?? 6,
    codRemittanceSlaIssueCount: input.codRemittanceSlaIssueCount ?? 2,
    invoiceMismatchCount: input.invoiceMismatchCount ?? 3,
    invoiceMismatchAmountPaise: input.invoiceMismatchAmountPaise ?? 45000,
    affectedMerchantCount: input.affectedMerchantCount ?? (scope === "OPS" ? 6 : 2),
    affectedShipmentCount: input.affectedShipmentCount ?? 42,
    highSeverityCount: input.highSeverityCount ?? 5,
    criticalSeverityCount: input.criticalSeverityCount ?? 1,
    topIssues: input.topIssues || [
      { summary: "Pending pickups need morning follow-up", count: 18, severity: "HIGH" },
      { summary: "SLA breaches are concentrated on the metro lane", count: 7, severity: "HIGH" }
    ],
    recommendedActions: input.recommendedActions || [
      "Call courier control for pickup backlog.",
      "Prioritize NDR and reattempt follow-up before noon.",
      "Review scan anomalies before updating courier score."
    ],
    dashboardUrl: input.dashboardUrl || "https://shipmastr.com/seller/merchant/autopilot?tab=courier-control-tower",
    preferredChannels,
    opsEmailEnabled: scope === "OPS",
    courierEmailEnabled: scope === "COURIER_PARTNER" && mode !== "internal_only",
    internalAlertEnabled: mode !== "email_only"
  }));
  const dispatched = await dispatchAutomationEvent(event.id);

  return {
    merchant,
    event: dispatched,
    scope,
    mode
  };
}

export async function checkConsent(merchantId: string, channel: string, subject: string) {
  requireMerchantId(merchantId);

  const [preference, optOut] = await Promise.all([
    prisma.automationPreference.upsert({
      where: { merchantId },
      create: { merchantId },
      update: {}
    }),
    prisma.automationOptOut.findFirst({
      where: {
        merchantId,
        channel,
        subject,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
      }
    })
  ]);

  const channelEnabled =
    channel === "WHATSAPP"
      ? preference.whatsappEnabled
      : channel === "SMS"
        ? preference.smsEnabled
        : channel === "EMAIL"
          ? preference.emailEnabled
          : true;

  return {
    allowed: preference.autopilotEnabled && preference.notificationsEnabled && channelEnabled && !optOut,
    reason: !preference.autopilotEnabled
      ? "AUTOPILOT_PAUSED"
      : !preference.notificationsEnabled
        ? "NOTIFICATIONS_DISABLED"
        : !channelEnabled
          ? "CHANNEL_DISABLED"
          : optOut
            ? "RECIPIENT_OPTED_OUT"
            : "CONSENT_OK"
  };
}

export async function checkQuietHours(merchantId: string, now = new Date()) {
  requireMerchantId(merchantId);

  const preference = await prisma.automationPreference.upsert({
    where: { merchantId },
    create: { merchantId },
    update: {}
  });

  const quiet = inQuietHours(now, preference.quietHoursStart, preference.quietHoursEnd);

  return {
    allowed: !quiet,
    reason: quiet ? "QUIET_HOURS" : "QUIET_HOURS_OK",
    quietHoursStart: preference.quietHoursStart,
    quietHoursEnd: preference.quietHoursEnd,
    timezone: preference.timezone
  };
}

export async function checkFrequencyCap(merchantId: string, channel: string, subject: string) {
  requireMerchantId(merchantId);

  const preference = await prisma.automationPreference.upsert({
    where: { merchantId },
    create: { merchantId },
    update: {}
  });
  const now = new Date();
  const windowKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  const ledger = await prisma.automationFrequencyLedger.findUnique({
    where: {
      merchantId_subject_channel_windowKey: {
        merchantId,
        subject,
        channel,
        windowKey
      }
    }
  });

  const count = ledger?.count || 0;
  const allowed = count < preference.dailyBuyerMessageCap;

  return {
    allowed,
    reason: allowed ? "FREQUENCY_OK" : "DAILY_CAP_REACHED",
    count,
    cap: preference.dailyBuyerMessageCap,
    windowKey
  };
}

type AbandonedChannelSkip = {
  channel: "EMAIL" | "WHATSAPP";
  reason: string;
  recipientMasked?: string | undefined;
};

type AbandonedCheckoutDispatchPlan = {
  allowedChannels: Array<"EMAIL" | "WHATSAPP">;
  primaryChannel: string;
  payload: JsonMap;
  skippedChannelReasons: AbandonedChannelSkip[];
};

function preferredAbandonedChannels(payload: Record<string, unknown>, workflowChannelOrder: string[]) {
  const channelPlan = asRecord(payload.channelPlan);
  const preferred = Array.isArray(channelPlan.preferredChannels)
    ? channelPlan.preferredChannels.filter((channel): channel is "EMAIL" | "WHATSAPP" => channel === "EMAIL" || channel === "WHATSAPP")
    : workflowChannelOrder.filter((channel): channel is "EMAIL" | "WHATSAPP" => channel === "EMAIL" || channel === "WHATSAPP");

  return preferred.length ? preferred : ["EMAIL", "WHATSAPP"];
}

function getChannelCredential(
  channelCredentials: Awaited<ReturnType<typeof prisma.merchantChannelCredential.findMany>>,
  channel: "EMAIL" | "WHATSAPP"
) {
  return channelCredentials.find((credential) =>
    credential.channel === channel && isVerifiedCredentialStatus(credential.status)
  );
}

async function evaluateAbandonedChannel(input: {
  merchantId: string;
  channel: "EMAIL" | "WHATSAPP";
  cartId: string;
  recipient?: string | undefined;
  recipientMasked?: string | undefined;
  buyerConsent: boolean;
  merchantChannelEnabled: boolean;
  credentialAvailable: boolean;
  workflowFrequencyCap?: number | null | undefined;
}) {
  const skipped = (reason: string): { allowed: false; reason: string } => ({ allowed: false, reason });

  if (!input.merchantChannelEnabled) return skipped(`${input.channel}_MARKETING_DISABLED`);
  if (!input.buyerConsent) return skipped(`${input.channel}_BUYER_CONSENT_MISSING`);
  if (!input.recipient) return skipped(`${input.channel}_RECIPIENT_MISSING`);
  if (!input.credentialAvailable) return skipped(`${input.channel}_MERCHANT_CHANNEL_NOT_VERIFIED`);

  const consent = await checkConsent(input.merchantId, input.channel, input.recipient);
  if (!consent.allowed) return skipped(consent.reason);

  const frequencySubject = `abandoned-checkout:${input.cartId}`;
  const frequency = await checkFrequencyCap(input.merchantId, input.channel, frequencySubject);
  const cap = input.workflowFrequencyCap ?? 1;
  if (!frequency.allowed || frequency.count >= cap) {
    return skipped("ABANDONED_CHECKOUT_FREQUENCY_CAP_REACHED");
  }

  return { allowed: true as const };
}

async function planAbandonedCheckoutDispatch(input: {
  event: { merchantId: string; payload: Prisma.JsonValue | null; id: string };
  preference: {
    metadata: Prisma.JsonValue;
    marketingEnabled: boolean;
    emailEnabled: boolean;
    whatsappEnabled: boolean;
  };
  workflowSetting: {
    channelOrder: string[];
    frequencyCap?: number | null | undefined;
  };
  channelCredentials: Awaited<ReturnType<typeof prisma.merchantChannelCredential.findMany>>;
}): Promise<AbandonedCheckoutDispatchPlan> {
  const payload = asRecord(input.event.payload);
  const cartId = cleanOptionalString(payload.cartId);
  if (!cartId) {
    return {
      allowedChannels: [],
      primaryChannel: "NONE",
      payload: payload as JsonMap,
      skippedChannelReasons: [
        { channel: "EMAIL" as const, reason: "ABANDONED_CHECKOUT_CART_ID_MISSING" },
        { channel: "WHATSAPP" as const, reason: "ABANDONED_CHECKOUT_CART_ID_MISSING" }
      ]
    };
  }

  const preferenceMetadata = asRecord(input.preference.metadata);
  const abandonedCheckoutEnabled = metadataFlag(preferenceMetadata, "abandonedCheckoutEnabled", false);
  const emailMarketingEnabled = metadataFlag(preferenceMetadata, "emailMarketingEnabled", true);
  const whatsappMarketingEnabled = metadataFlag(preferenceMetadata, "whatsappMarketingEnabled", true);
  const fallbackSenderAllowed = metadataFlag(preferenceMetadata, "abandonedCheckoutFallbackSenderAllowed", false) ||
    metadataFlag(preferenceMetadata, "fallbackSenderAllowed", false);

  if (!input.preference.marketingEnabled || !abandonedCheckoutEnabled) {
    return {
      allowedChannels: [],
      primaryChannel: "NONE",
      payload: {
        ...payload,
        channelPlan: {
          ...asRecord(payload.channelPlan),
          emailEnabled: false,
          whatsappEnabled: false,
          fallbackSenderAllowed,
          skippedChannelReasons: [
            { channel: "EMAIL", reason: !input.preference.marketingEnabled ? "MARKETING_DISABLED" : "ABANDONED_CHECKOUT_DISABLED" },
            { channel: "WHATSAPP", reason: !input.preference.marketingEnabled ? "MARKETING_DISABLED" : "ABANDONED_CHECKOUT_DISABLED" }
          ]
        }
      },
      skippedChannelReasons: [
        { channel: "EMAIL", reason: !input.preference.marketingEnabled ? "MARKETING_DISABLED" : "ABANDONED_CHECKOUT_DISABLED" },
        { channel: "WHATSAPP", reason: !input.preference.marketingEnabled ? "MARKETING_DISABLED" : "ABANDONED_CHECKOUT_DISABLED" }
      ]
    };
  }

  const buyerContact = asRecord(payload.buyerContact);
  const buyerConsent = asRecord(payload.buyerConsent);
  const emailCredential = getChannelCredential(input.channelCredentials, "EMAIL");
  const whatsappCredential = getChannelCredential(input.channelCredentials, "WHATSAPP");
  const emailMetadata = sanitizeCredentialMetadata(emailCredential?.metadata);
  const whatsappMetadata = sanitizeCredentialMetadata(whatsappCredential?.metadata);
  const whatsappProviderPlan = resolveWhatsappProviderPlan({
    credential: whatsappCredential,
    templateKey: ABANDONED_CHECKOUT_TEMPLATE_KEY
  });
  const emailSender =
    cleanOptionalString(emailMetadata.businessEmail) ||
    cleanOptionalString(emailMetadata.senderEmail) ||
    (fallbackSenderAllowed ? SHIPMASTR_FALLBACK_EMAIL : undefined);
  const emailReplyTo = emailSender;
  const whatsappBusinessNumber = cleanOptionalString(whatsappMetadata.whatsappBusinessNumber);
  const preferredChannels = preferredAbandonedChannels(payload, input.workflowSetting.channelOrder);
  const skippedChannelReasons: AbandonedChannelSkip[] = [];
  const allowedChannels: Array<"EMAIL" | "WHATSAPP"> = [];

  const emailRecipient = cleanOptionalString(buyerContact.email);
  const whatsappRecipient = cleanOptionalString(buyerContact.phone);
  const emailAllowed = await evaluateAbandonedChannel({
    merchantId: input.event.merchantId,
    channel: "EMAIL",
    cartId,
    recipient: emailRecipient,
    recipientMasked: cleanOptionalString(buyerContact.emailMasked) || maskEmail(emailRecipient),
    buyerConsent: buyerConsent.emailMarketingConsent === true,
    merchantChannelEnabled: input.preference.emailEnabled && emailMarketingEnabled && preferredChannels.includes("EMAIL"),
    credentialAvailable: Boolean(emailCredential || (fallbackSenderAllowed && emailSender === SHIPMASTR_FALLBACK_EMAIL)),
    workflowFrequencyCap: input.workflowSetting.frequencyCap
  });

  if (emailAllowed.allowed) {
    allowedChannels.push("EMAIL");
  } else {
    skippedChannelReasons.push({
      channel: "EMAIL",
      reason: emailAllowed.reason,
      recipientMasked: cleanOptionalString(buyerContact.emailMasked) || maskEmail(emailRecipient)
    });
  }

  const whatsappAllowed = await evaluateAbandonedChannel({
    merchantId: input.event.merchantId,
    channel: "WHATSAPP",
    cartId,
    recipient: whatsappRecipient,
    recipientMasked: cleanOptionalString(buyerContact.phoneMasked) || maskPhone(whatsappRecipient),
    buyerConsent: buyerConsent.whatsappMarketingConsent === true,
    merchantChannelEnabled: input.preference.whatsappEnabled && whatsappMarketingEnabled && preferredChannels.includes("WHATSAPP"),
    credentialAvailable: whatsappProviderPlan.allowed,
    workflowFrequencyCap: input.workflowSetting.frequencyCap
  });

  if (whatsappAllowed.allowed) {
    allowedChannels.push("WHATSAPP");
  } else {
    const reason = whatsappCredential && whatsappBusinessNumber && !whatsappProviderPlan.allowed
      ? whatsappProviderPlan.reason
      : whatsappAllowed.reason;
    skippedChannelReasons.push({
      channel: "WHATSAPP",
      reason,
      recipientMasked: cleanOptionalString(buyerContact.phoneMasked) || maskPhone(whatsappRecipient)
    });
  }

  const storeName = cleanOptionalString(payload.storeName) || "your store";
  const nextPayload = {
    ...payload,
    email: {
      ...asRecord(payload.email),
      subject: buildAbandonedCheckoutSubject(storeName)
    },
    channelPlan: {
      ...asRecord(payload.channelPlan),
      emailEnabled: allowedChannels.includes("EMAIL"),
      whatsappEnabled: allowedChannels.includes("WHATSAPP"),
      preferredChannels,
      allowedChannels,
      emailProvider: emailCredential?.provider || (allowedChannels.includes("EMAIL") ? "shipmastr-fallback" : undefined),
      emailSender,
      emailSenderDomain: safeDomainFromEmail(emailSender),
      replyTo: emailReplyTo,
      whatsappProvider: whatsappCredential?.provider,
      whatsappProviderMode: whatsappProviderPlan.allowed ? whatsappProviderPlan.mode : undefined,
      whatsappBusinessNumber: whatsappProviderPlan.businessNumberMasked || maskPhone(whatsappBusinessNumber),
      whatsappPhoneNumberIdMasked: whatsappProviderPlan.allowed ? whatsappProviderPlan.phoneNumberIdMasked : undefined,
      whatsappTemplateNamespace: whatsappProviderPlan.allowed ? whatsappProviderPlan.templateNamespace : cleanOptionalString(whatsappMetadata.templateNamespace),
      whatsappTemplateKey: ABANDONED_CHECKOUT_TEMPLATE_KEY,
      whatsappTemplateName: whatsappProviderPlan.allowed
        ? whatsappProviderPlan.providerTemplateName
        : cleanOptionalString(whatsappMetadata.templateName),
      whatsappTemplateLanguage: whatsappProviderPlan.allowed ? whatsappProviderPlan.language : undefined,
      fallbackSenderAllowed,
      skippedChannelReasons
    }
  } as JsonMap;

  return {
    allowedChannels,
    primaryChannel: allowedChannels.length > 1 ? "MULTI" : allowedChannels[0] || "NONE",
    payload: nextPayload,
    skippedChannelReasons
  } satisfies AbandonedCheckoutDispatchPlan;
}

async function logAbandonedCheckoutSkips(input: {
  event: { id: string; merchantId: string; eventKey: string; payload: Prisma.JsonValue | null };
  workflowKey: string;
  skippedChannelReasons: AbandonedChannelSkip[];
}) {
  const payload = asRecord(input.event.payload);
  const cartId = cleanOptionalString(payload.cartId) || input.event.id;
  await Promise.all(input.skippedChannelReasons.map((skip) =>
    logCommunication({
      merchantId: input.event.merchantId,
      eventId: input.event.id,
      idempotencyKey: `abandoned-checkout-skip:${input.event.id}:${skip.channel}:${skip.reason}`,
      channel: skip.channel,
      recipient: `cart:${cartId}`,
      templateKey: ABANDONED_CHECKOUT_TEMPLATE_KEY,
      status: "SKIPPED",
      provider: "shipmastr",
      providerMessageId: `skip_${input.event.id}_${skip.channel}_${skip.reason}`,
      metadata: {
        eventKey: input.event.eventKey,
        workflowKey: input.workflowKey,
        cartId,
        skipReason: skip.reason,
        recipientMasked: skip.recipientMasked
      }
    }).catch(() => undefined)
  ));
}

function preferredRepeatBuyerChannels(payload: Record<string, unknown>, workflowChannelOrder: string[]) {
  return preferredAbandonedChannels(payload, workflowChannelOrder);
}

function repeatBuyerPreferenceMetadata(metadata: Prisma.JsonValue) {
  const source = asRecord(metadata);
  return {
    repeatBuyerEnabled: metadataFlag(source, "repeatBuyerEnabled", false),
    repeatBuyerEmailEnabled: metadataFlag(source, "repeatBuyerEmailEnabled", true),
    repeatBuyerWhatsappEnabled: metadataFlag(source, "repeatBuyerWhatsappEnabled", true),
    repeatBuyerFallbackSenderAllowed:
      metadataFlag(source, "repeatBuyerFallbackSenderAllowed", false) ||
      metadataFlag(source, "emailFallbackAllowed", false),
    repeatBuyerWindowDays: cleanOptionalNumber(source.repeatBuyerWindowDays) ?? 45,
    maxMessagesPerMonth: cleanOptionalNumber(source.maxRepeatBuyerMessagesPerBuyerPerMonth) ?? 1
  };
}

async function checkRepeatBuyerMonthlyFrequency(input: {
  merchantId: string;
  channel: "EMAIL" | "WHATSAPP";
  buyerId: string;
  cap: number;
}) {
  const now = new Date();
  const windowKey = getMonthKey(now);
  const subject = `repeat-buyer:${input.buyerId}`;
  const ledger = await prisma.automationFrequencyLedger.findUnique({
    where: {
      merchantId_subject_channel_windowKey: {
        merchantId: input.merchantId,
        subject,
        channel: input.channel,
        windowKey
      }
    }
  });

  const count = ledger?.count || 0;
  return {
    allowed: count < input.cap,
    count,
    cap: input.cap,
    windowKey,
    subject
  };
}

async function reserveRepeatBuyerMonthlyFrequency(input: {
  merchantId: string;
  channel: "EMAIL" | "WHATSAPP";
  buyerId: string;
}) {
  const now = new Date();
  const windowKey = getMonthKey(now);
  const resetAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
  await prisma.automationFrequencyLedger.upsert({
    where: {
      merchantId_subject_channel_windowKey: {
        merchantId: input.merchantId,
        subject: `repeat-buyer:${input.buyerId}`,
        channel: input.channel,
        windowKey
      }
    },
    create: {
      merchantId: input.merchantId,
      subject: `repeat-buyer:${input.buyerId}`,
      channel: input.channel,
      windowKey,
      count: 1,
      resetAt
    },
    update: {
      count: { increment: 1 }
    }
  });
}

async function evaluateRepeatBuyerChannel(input: {
  merchantId: string;
  channel: "EMAIL" | "WHATSAPP";
  buyerId: string;
  recipient?: string | undefined;
  buyerConsent: boolean;
  merchantChannelEnabled: boolean;
  credentialAvailable: boolean;
  maxMessagesPerMonth: number;
}) {
  const skipped = (reason: string): { allowed: false; reason: string } => ({ allowed: false, reason });

  if (!input.merchantChannelEnabled) return skipped(`${input.channel}_REPEAT_BUYER_DISABLED`);
  if (!input.buyerConsent) return skipped(`${input.channel}_BUYER_CONSENT_MISSING`);
  if (!input.recipient) return skipped(`${input.channel}_RECIPIENT_MISSING`);
  if (!input.credentialAvailable) return skipped(`${input.channel}_MERCHANT_CHANNEL_NOT_VERIFIED`);

  const consent = await checkConsent(input.merchantId, input.channel, input.recipient);
  if (!consent.allowed) return skipped(consent.reason);

  const frequency = await checkRepeatBuyerMonthlyFrequency({
    merchantId: input.merchantId,
    channel: input.channel,
    buyerId: input.buyerId,
    cap: input.maxMessagesPerMonth
  });
  if (!frequency.allowed) {
    return skipped("REPEAT_BUYER_FREQUENCY_CAP_REACHED");
  }

  return { allowed: true as const };
}

async function planRepeatBuyerDispatch(input: {
  event: { merchantId: string; payload: Prisma.JsonValue | null; id: string };
  preference: {
    metadata: Prisma.JsonValue;
    marketingEnabled: boolean;
    emailEnabled: boolean;
    whatsappEnabled: boolean;
  };
  workflowSetting: {
    channelOrder: string[];
    frequencyCap?: number | null | undefined;
  };
  channelCredentials: Awaited<ReturnType<typeof prisma.merchantChannelCredential.findMany>>;
}): Promise<AbandonedCheckoutDispatchPlan> {
  const payload = asRecord(input.event.payload);
  const buyerId = cleanOptionalString(payload.buyerId);
  if (!buyerId) {
    return {
      allowedChannels: [],
      primaryChannel: "NONE",
      payload: payload as JsonMap,
      skippedChannelReasons: [
        { channel: "EMAIL", reason: "REPEAT_BUYER_BUYER_ID_MISSING" },
        { channel: "WHATSAPP", reason: "REPEAT_BUYER_BUYER_ID_MISSING" }
      ]
    };
  }

  const preferenceMetadata = repeatBuyerPreferenceMetadata(input.preference.metadata);
  const fallbackSenderAllowed = preferenceMetadata.repeatBuyerFallbackSenderAllowed;

  if (!input.preference.marketingEnabled || !preferenceMetadata.repeatBuyerEnabled) {
    const reason = !input.preference.marketingEnabled ? "MARKETING_DISABLED" : "REPEAT_BUYER_DISABLED";
    return {
      allowedChannels: [],
      primaryChannel: "NONE",
      payload: {
        ...payload,
        channelPlan: {
          ...asRecord(payload.channelPlan),
          emailEnabled: false,
          whatsappEnabled: false,
          fallbackSenderAllowed,
          skippedChannelReasons: [
            { channel: "EMAIL", reason },
            { channel: "WHATSAPP", reason }
          ]
        }
      },
      skippedChannelReasons: [
        { channel: "EMAIL", reason },
        { channel: "WHATSAPP", reason }
      ]
    };
  }

  const daysSinceLastOrder = cleanOptionalNumber(payload.daysSinceLastOrder) ?? 0;
  if (daysSinceLastOrder < preferenceMetadata.repeatBuyerWindowDays) {
    const reason = "REPEAT_BUYER_WINDOW_NOT_REACHED";
    return {
      allowedChannels: [],
      primaryChannel: "NONE",
      payload: {
        ...payload,
        channelPlan: {
          ...asRecord(payload.channelPlan),
          emailEnabled: false,
          whatsappEnabled: false,
          fallbackSenderAllowed,
          skippedChannelReasons: [
            { channel: "EMAIL", reason },
            { channel: "WHATSAPP", reason }
          ]
        }
      },
      skippedChannelReasons: [
        { channel: "EMAIL", reason },
        { channel: "WHATSAPP", reason }
      ]
    };
  }

  const buyerContact = asRecord(payload.buyerContact);
  const buyerConsent = asRecord(payload.buyerConsent);
  const emailCredential = getChannelCredential(input.channelCredentials, "EMAIL");
  const whatsappCredential = getChannelCredential(input.channelCredentials, "WHATSAPP");
  const emailMetadata = sanitizeCredentialMetadata(emailCredential?.metadata);
  const whatsappMetadata = sanitizeCredentialMetadata(whatsappCredential?.metadata);
  const templateStatus = templateStatusesFromMetadata(whatsappCredential?.metadata);
  const whatsappProviderPlan = resolveWhatsappProviderPlan({
    credential: whatsappCredential,
    templateKey: REPEAT_BUYER_TEMPLATE_KEY
  });
  const emailSender =
    cleanOptionalString(emailMetadata.businessEmail) ||
    cleanOptionalString(emailMetadata.senderEmail) ||
    (fallbackSenderAllowed ? SHIPMASTR_FALLBACK_EMAIL : undefined);
  const whatsappBusinessNumber = cleanOptionalString(whatsappMetadata.whatsappBusinessNumber);
  const preferredChannels = preferredRepeatBuyerChannels(payload, input.workflowSetting.channelOrder);
  const skippedChannelReasons: AbandonedChannelSkip[] = [];
  const allowedChannels: Array<"EMAIL" | "WHATSAPP"> = [];
  const frequencyCap = input.workflowSetting.frequencyCap ?? preferenceMetadata.maxMessagesPerMonth;

  const emailRecipient = cleanOptionalString(buyerContact.email);
  const whatsappRecipient = cleanOptionalString(buyerContact.phone);
  const emailAllowed = await evaluateRepeatBuyerChannel({
    merchantId: input.event.merchantId,
    channel: "EMAIL",
    buyerId,
    recipient: emailRecipient,
    buyerConsent: buyerConsent.emailMarketingConsent === true,
    merchantChannelEnabled: input.preference.emailEnabled && preferenceMetadata.repeatBuyerEmailEnabled && preferredChannels.includes("EMAIL"),
    credentialAvailable: Boolean(emailCredential || (fallbackSenderAllowed && emailSender === SHIPMASTR_FALLBACK_EMAIL)),
    maxMessagesPerMonth: frequencyCap
  });

  if (emailAllowed.allowed) {
    allowedChannels.push("EMAIL");
  } else {
    skippedChannelReasons.push({
      channel: "EMAIL",
      reason: emailAllowed.reason,
      recipientMasked: cleanOptionalString(buyerContact.emailMasked) || maskEmail(emailRecipient)
    });
  }

  const whatsappAllowed = await evaluateRepeatBuyerChannel({
    merchantId: input.event.merchantId,
    channel: "WHATSAPP",
    buyerId,
    recipient: whatsappRecipient,
    buyerConsent: buyerConsent.whatsappMarketingConsent === true,
    merchantChannelEnabled: input.preference.whatsappEnabled && preferenceMetadata.repeatBuyerWhatsappEnabled && preferredChannels.includes("WHATSAPP"),
    credentialAvailable: whatsappProviderPlan.allowed,
    maxMessagesPerMonth: frequencyCap
  });

  if (whatsappAllowed.allowed) {
    allowedChannels.push("WHATSAPP");
  } else {
    const reason = whatsappCredential && whatsappBusinessNumber && templateStatus.repeatBuyer !== "APPROVED"
      ? "WHATSAPP_REPEAT_BUYER_TEMPLATE_NOT_APPROVED"
      : whatsappAllowed.reason;
    skippedChannelReasons.push({
      channel: "WHATSAPP",
      reason,
      recipientMasked: cleanOptionalString(buyerContact.phoneMasked) || maskPhone(whatsappRecipient)
    });
  }

  const storeName = cleanOptionalString(payload.storeName) || "your store";
  const nextPayload = {
    ...payload,
    email: {
      ...asRecord(payload.email),
      subject: buildRepeatBuyerSubject(storeName)
    },
    channelPlan: {
      ...asRecord(payload.channelPlan),
      emailEnabled: allowedChannels.includes("EMAIL"),
      whatsappEnabled: allowedChannels.includes("WHATSAPP"),
      preferredChannels,
      allowedChannels,
      emailProvider: emailCredential?.provider || (allowedChannels.includes("EMAIL") ? "shipmastr-fallback" : undefined),
      emailSender,
      emailSenderDomain: safeDomainFromEmail(emailSender),
      replyTo: emailSender,
      whatsappProvider: whatsappCredential?.provider,
      whatsappProviderMode: whatsappProviderPlan.allowed ? whatsappProviderPlan.mode : undefined,
      whatsappBusinessNumber: whatsappProviderPlan.businessNumberMasked || maskPhone(whatsappBusinessNumber),
      whatsappPhoneNumberIdMasked: whatsappProviderPlan.allowed ? whatsappProviderPlan.phoneNumberIdMasked : undefined,
      whatsappTemplateNamespace: whatsappProviderPlan.allowed ? whatsappProviderPlan.templateNamespace : cleanOptionalString(whatsappMetadata.templateNamespace),
      whatsappTemplateKey: REPEAT_BUYER_TEMPLATE_KEY,
      whatsappTemplateName: REPEAT_BUYER_TEMPLATE_KEY,
      whatsappTemplateLanguage: whatsappProviderPlan.allowed ? whatsappProviderPlan.language : undefined,
      fallbackSenderAllowed,
      skippedChannelReasons
    }
  } as JsonMap;

  return {
    allowedChannels,
    primaryChannel: allowedChannels.length > 1 ? "MULTI" : allowedChannels[0] || "NONE",
    payload: nextPayload,
    skippedChannelReasons
  } satisfies AbandonedCheckoutDispatchPlan;
}

async function logRepeatBuyerSkips(input: {
  event: { id: string; merchantId: string; eventKey: string; payload: Prisma.JsonValue | null };
  workflowKey: string;
  skippedChannelReasons: AbandonedChannelSkip[];
}) {
  const payload = asRecord(input.event.payload);
  const buyerId = cleanOptionalString(payload.buyerId) || input.event.id;
  const lastOrderId = cleanOptionalString(payload.lastOrderId);
  await Promise.all(input.skippedChannelReasons.map((skip) =>
    logCommunication({
      merchantId: input.event.merchantId,
      eventId: input.event.id,
      idempotencyKey: `repeat-buyer-skip:${input.event.id}:${skip.channel}:${skip.reason}`,
      channel: skip.channel,
      recipient: `buyer:${buyerId}`,
      templateKey: REPEAT_BUYER_TEMPLATE_KEY,
      status: "SKIPPED",
      provider: "shipmastr",
      providerMessageId: `skip_${input.event.id}_${skip.channel}_${skip.reason}`,
      metadata: {
        eventKey: input.event.eventKey,
        workflowKey: input.workflowKey,
        buyerId,
        lastOrderId,
        skipReason: skip.reason,
        recipientMasked: skip.recipientMasked
      }
    }).catch(() => undefined)
  ));
}

function codRemittancePreferenceMetadata(metadata: Prisma.JsonValue) {
  const source = asRecord(metadata);
  return {
    financeAlertsEnabled: metadataFlag(source, "financeAlertsEnabled", true),
    codDueAlertsEnabled: metadataFlag(source, "codDueAlertsEnabled", true),
    codDelayedAlertsEnabled: metadataFlag(source, "codDelayedAlertsEnabled", true),
    codSettledAlertsEnabled: metadataFlag(source, "codSettledAlertsEnabled", true),
    codMismatchAlertsEnabled: metadataFlag(source, "codMismatchAlertsEnabled", true),
    financeAlertEmailEnabled: metadataFlag(source, "financeAlertEmailEnabled", true),
    financeAlertWhatsappEnabled: metadataFlag(source, "financeAlertWhatsappEnabled", false),
    financeAlertFallbackSenderAllowed:
      metadataFlag(source, "financeAlertFallbackSenderAllowed", true) ||
      metadataFlag(source, "emailFallbackAllowed", false)
  };
}

function codRemittancePreferenceReason(eventKey: string, metadata: ReturnType<typeof codRemittancePreferenceMetadata>) {
  if (!metadata.financeAlertsEnabled) return "FINANCE_ALERTS_DISABLED";
  if (eventKey === "cod.remittance_due" && !metadata.codDueAlertsEnabled) return "COD_DUE_ALERTS_DISABLED";
  if (eventKey === "cod.remittance_delayed" && !metadata.codDelayedAlertsEnabled) return "COD_DELAYED_ALERTS_DISABLED";
  if (eventKey === "cod.remittance_settled" && !metadata.codSettledAlertsEnabled) return "COD_SETTLED_ALERTS_DISABLED";
  if (eventKey === "cod.remittance_mismatch_detected" && !metadata.codMismatchAlertsEnabled) return "COD_MISMATCH_ALERTS_DISABLED";
  return null;
}

async function planCodRemittanceDispatch(input: {
  event: { merchantId: string; payload: Prisma.JsonValue | null; id: string; eventKey: string };
  preference: {
    metadata: Prisma.JsonValue;
    financeControlEnabled: boolean;
    emailEnabled: boolean;
    whatsappEnabled: boolean;
  };
  workflowSetting: {
    channelOrder: string[];
  };
  channelCredentials: Awaited<ReturnType<typeof prisma.merchantChannelCredential.findMany>>;
}): Promise<AbandonedCheckoutDispatchPlan> {
  const payload = asRecord(input.event.payload);
  const metadata = codRemittancePreferenceMetadata(input.preference.metadata);
  const disabledReason = !input.preference.financeControlEnabled
    ? "FINANCE_CONTROL_DISABLED"
    : codRemittancePreferenceReason(input.event.eventKey, metadata);
  const templateKey = codRemittanceTemplateKey(input.event.eventKey);
  const preferredChannels = preferredAbandonedChannels(payload, input.workflowSetting.channelOrder);
  const skippedChannelReasons: AbandonedChannelSkip[] = [];
  const allowedChannels: Array<"EMAIL" | "WHATSAPP"> = [];
  const emailCredential = getChannelCredential(input.channelCredentials, "EMAIL");
  const emailMetadata = sanitizeCredentialMetadata(emailCredential?.metadata);
  const emailSender =
    cleanOptionalString(emailMetadata.businessEmail) ||
    cleanOptionalString(emailMetadata.senderEmail) ||
    (metadata.financeAlertFallbackSenderAllowed ? SHIPMASTR_FALLBACK_EMAIL : undefined);
  const emailRecipient =
    cleanOptionalString(payload.merchantEmail) ||
    cleanOptionalString(emailMetadata.businessEmail) ||
    cleanOptionalString(emailMetadata.senderEmail);

  if (disabledReason) {
    return {
      allowedChannels: [],
      primaryChannel: "NONE",
      payload: {
        ...payload,
        channelPlan: {
          ...asRecord(payload.channelPlan),
          emailEnabled: false,
          whatsappEnabled: false,
          fallbackSenderAllowed: metadata.financeAlertFallbackSenderAllowed,
          skippedChannelReasons: [
            { channel: "EMAIL", reason: disabledReason },
            { channel: "WHATSAPP", reason: disabledReason }
          ]
        }
      },
      skippedChannelReasons: [
        { channel: "EMAIL", reason: disabledReason },
        { channel: "WHATSAPP", reason: disabledReason }
      ]
    };
  }

  if (!metadata.financeAlertEmailEnabled || !input.preference.emailEnabled || !preferredChannels.includes("EMAIL")) {
    skippedChannelReasons.push({ channel: "EMAIL", reason: "COD_REMITTANCE_EMAIL_DISABLED", recipientMasked: maskEmail(emailRecipient) });
  } else if (!emailRecipient) {
    skippedChannelReasons.push({ channel: "EMAIL", reason: "COD_REMITTANCE_EMAIL_RECIPIENT_MISSING" });
  } else if (!emailSender) {
    skippedChannelReasons.push({ channel: "EMAIL", reason: "COD_REMITTANCE_EMAIL_SENDER_NOT_READY", recipientMasked: maskEmail(emailRecipient) });
  } else {
    const consent = await checkConsent(input.event.merchantId, "EMAIL", emailRecipient);
    if (consent.allowed) {
      allowedChannels.push("EMAIL");
    } else {
      skippedChannelReasons.push({ channel: "EMAIL", reason: consent.reason, recipientMasked: maskEmail(emailRecipient) });
    }
  }

  if (!metadata.financeAlertWhatsappEnabled || !input.preference.whatsappEnabled || !preferredChannels.includes("WHATSAPP")) {
    skippedChannelReasons.push({ channel: "WHATSAPP", reason: "COD_REMITTANCE_WHATSAPP_DISABLED" });
  } else {
    skippedChannelReasons.push({ channel: "WHATSAPP", reason: "WHATSAPP_FINANCE_TEMPLATE_NOT_READY" });
  }

  const merchantName = cleanOptionalString(payload.merchantName) || "Merchant";
  const nextPayload = {
    ...payload,
    templateKey,
    email: {
      ...asRecord(payload.email),
      from: emailSender,
      to: emailRecipient,
      replyTo: emailSender,
      subject: buildCodRemittanceSubject({
        merchantName,
        eventKey: input.event.eventKey,
        dueDate: cleanOptionalString(payload.dueDate),
        settlementDate: cleanOptionalString(payload.settlementDate)
      })
    },
    channelPlan: {
      ...asRecord(payload.channelPlan),
      emailEnabled: allowedChannels.includes("EMAIL"),
      whatsappEnabled: allowedChannels.includes("WHATSAPP"),
      preferredChannels,
      allowedChannels,
      emailProvider: emailCredential?.provider || (allowedChannels.includes("EMAIL") ? "shipmastr-fallback" : undefined),
      emailSender,
      emailSenderDomain: safeDomainFromEmail(emailSender),
      replyTo: emailSender,
      fallbackSenderAllowed: metadata.financeAlertFallbackSenderAllowed,
      whatsappTemplateKey: templateKey,
      skippedChannelReasons
    }
  } as JsonMap;

  return {
    allowedChannels,
    primaryChannel: allowedChannels.length > 1 ? "MULTI" : allowedChannels[0] || "NONE",
    payload: nextPayload,
    skippedChannelReasons
  };
}

async function logCodRemittanceSkips(input: {
  event: { id: string; merchantId: string; eventKey: string; payload: Prisma.JsonValue | null };
  workflowKey: string;
  skippedChannelReasons: AbandonedChannelSkip[];
}) {
  const payload = asRecord(input.event.payload);
  const remittanceId = cleanOptionalString(payload.remittanceId) || input.event.id;
  await Promise.all(input.skippedChannelReasons.map((skip) =>
    logCommunication({
      merchantId: input.event.merchantId,
      eventId: input.event.id,
      idempotencyKey: `cod-remittance-skip:${input.event.id}:${skip.channel}:${skip.reason}`,
      channel: skip.channel,
      recipient: `remittance:${remittanceId}`,
      templateKey: codRemittanceTemplateKey(input.event.eventKey),
      status: "SKIPPED",
      provider: "shipmastr",
      providerMessageId: `skip_${input.event.id}_${skip.channel}_${skip.reason}`,
      metadata: {
        eventKey: input.event.eventKey,
        workflowKey: input.workflowKey,
        remittanceId,
        skipReason: skip.reason,
        recipientMasked: skip.recipientMasked
      }
    }).catch(() => undefined)
  ));
}

function sellerSettlementPreferenceMetadata(metadata: Prisma.JsonValue) {
  const source = asRecord(metadata);
  return {
    settlementAlertsEnabled: metadataFlag(source, "settlementAlertsEnabled", true),
    settlementGeneratedAlertsEnabled: metadataFlag(source, "settlementGeneratedAlertsEnabled", true),
    settlementScheduledAlertsEnabled: metadataFlag(source, "settlementScheduledAlertsEnabled", true),
    settlementPaidAlertsEnabled: metadataFlag(source, "settlementPaidAlertsEnabled", true),
    settlementHoldAlertsEnabled: metadataFlag(source, "settlementHoldAlertsEnabled", true),
    settlementAdjustmentAlertsEnabled: metadataFlag(source, "settlementAdjustmentAlertsEnabled", true),
    settlementEmailEnabled: metadataFlag(source, "settlementEmailEnabled", true),
    settlementWhatsappEnabled: metadataFlag(source, "settlementWhatsappEnabled", false),
    settlementFallbackSenderAllowed:
      metadataFlag(source, "settlementFallbackSenderAllowed", true) ||
      metadataFlag(source, "financeAlertFallbackSenderAllowed", true) ||
      metadataFlag(source, "emailFallbackAllowed", false)
  };
}

function sellerSettlementPreferenceReason(eventKey: string, metadata: ReturnType<typeof sellerSettlementPreferenceMetadata>) {
  if (!metadata.settlementAlertsEnabled) return "SETTLEMENT_ALERTS_DISABLED";
  if (eventKey === "seller.settlement_generated" && !metadata.settlementGeneratedAlertsEnabled) return "SETTLEMENT_GENERATED_ALERTS_DISABLED";
  if (eventKey === "seller.settlement_scheduled" && !metadata.settlementScheduledAlertsEnabled) return "SETTLEMENT_SCHEDULED_ALERTS_DISABLED";
  if (eventKey === "seller.settlement_paid" && !metadata.settlementPaidAlertsEnabled) return "SETTLEMENT_PAID_ALERTS_DISABLED";
  if (eventKey === "seller.settlement_held" && !metadata.settlementHoldAlertsEnabled) return "SETTLEMENT_HOLD_ALERTS_DISABLED";
  if (eventKey === "seller.settlement_adjusted" && !metadata.settlementAdjustmentAlertsEnabled) return "SETTLEMENT_ADJUSTMENT_ALERTS_DISABLED";
  return null;
}

async function planSellerSettlementDispatch(input: {
  event: { merchantId: string; payload: Prisma.JsonValue | null; id: string; eventKey: string };
  preference: {
    metadata: Prisma.JsonValue;
    financeControlEnabled: boolean;
    emailEnabled: boolean;
    whatsappEnabled: boolean;
  };
  workflowSetting: {
    channelOrder: string[];
  };
  channelCredentials: Awaited<ReturnType<typeof prisma.merchantChannelCredential.findMany>>;
}): Promise<AbandonedCheckoutDispatchPlan> {
  const payload = asRecord(input.event.payload);
  const metadata = sellerSettlementPreferenceMetadata(input.preference.metadata);
  const disabledReason = !input.preference.financeControlEnabled
    ? "FINANCE_CONTROL_DISABLED"
    : sellerSettlementPreferenceReason(input.event.eventKey, metadata);
  const templateKey = sellerSettlementTemplateKey(input.event.eventKey);
  const preferredChannels = preferredAbandonedChannels(payload, input.workflowSetting.channelOrder);
  const skippedChannelReasons: AbandonedChannelSkip[] = [];
  const allowedChannels: Array<"EMAIL" | "WHATSAPP"> = [];
  const emailCredential = getChannelCredential(input.channelCredentials, "EMAIL");
  const emailMetadata = sanitizeCredentialMetadata(emailCredential?.metadata);
  const emailSender =
    cleanOptionalString(emailMetadata.businessEmail) ||
    cleanOptionalString(emailMetadata.senderEmail) ||
    (metadata.settlementFallbackSenderAllowed ? SHIPMASTR_FALLBACK_EMAIL : undefined);
  const emailRecipient =
    cleanOptionalString(payload.merchantEmail) ||
    cleanOptionalString(emailMetadata.businessEmail) ||
    cleanOptionalString(emailMetadata.senderEmail);

  if (disabledReason) {
    return {
      allowedChannels: [],
      primaryChannel: "NONE",
      payload: {
        ...payload,
        channelPlan: {
          ...asRecord(payload.channelPlan),
          emailEnabled: false,
          whatsappEnabled: false,
          fallbackSenderAllowed: metadata.settlementFallbackSenderAllowed,
          skippedChannelReasons: [
            { channel: "EMAIL", reason: disabledReason },
            { channel: "WHATSAPP", reason: disabledReason }
          ]
        }
      },
      skippedChannelReasons: [
        { channel: "EMAIL", reason: disabledReason },
        { channel: "WHATSAPP", reason: disabledReason }
      ]
    };
  }

  if (!metadata.settlementEmailEnabled || !input.preference.emailEnabled || !preferredChannels.includes("EMAIL")) {
    skippedChannelReasons.push({ channel: "EMAIL", reason: "SETTLEMENT_EMAIL_DISABLED", recipientMasked: maskEmail(emailRecipient) });
  } else if (!emailRecipient) {
    skippedChannelReasons.push({ channel: "EMAIL", reason: "SETTLEMENT_EMAIL_RECIPIENT_MISSING" });
  } else if (!emailSender) {
    skippedChannelReasons.push({ channel: "EMAIL", reason: "SETTLEMENT_EMAIL_SENDER_NOT_READY", recipientMasked: maskEmail(emailRecipient) });
  } else {
    const consent = await checkConsent(input.event.merchantId, "EMAIL", emailRecipient);
    if (consent.allowed) {
      allowedChannels.push("EMAIL");
    } else {
      skippedChannelReasons.push({ channel: "EMAIL", reason: consent.reason, recipientMasked: maskEmail(emailRecipient) });
    }
  }

  if (!metadata.settlementWhatsappEnabled || !input.preference.whatsappEnabled || !preferredChannels.includes("WHATSAPP")) {
    skippedChannelReasons.push({ channel: "WHATSAPP", reason: "SETTLEMENT_WHATSAPP_DISABLED" });
  } else {
    skippedChannelReasons.push({ channel: "WHATSAPP", reason: "WHATSAPP_SETTLEMENT_TEMPLATE_NOT_READY" });
  }

  const merchantName = cleanOptionalString(payload.merchantName) || "Merchant";
  const nextPayload = {
    ...payload,
    templateKey,
    email: {
      ...asRecord(payload.email),
      from: emailSender,
      to: emailRecipient,
      replyTo: emailSender,
      subject: buildSellerSettlementSubject({
        merchantName,
        eventKey: input.event.eventKey,
        settlementDate: cleanOptionalString(payload.settlementDate),
        expectedPayoutDate: cleanOptionalString(payload.expectedPayoutDate),
        paidAt: cleanOptionalString(payload.paidAt)
      })
    },
    channelPlan: {
      ...asRecord(payload.channelPlan),
      emailEnabled: allowedChannels.includes("EMAIL"),
      whatsappEnabled: allowedChannels.includes("WHATSAPP"),
      preferredChannels,
      allowedChannels,
      emailProvider: emailCredential?.provider || (allowedChannels.includes("EMAIL") ? "shipmastr-fallback" : undefined),
      emailSender,
      emailSenderDomain: safeDomainFromEmail(emailSender),
      replyTo: emailSender,
      fallbackSenderAllowed: metadata.settlementFallbackSenderAllowed,
      whatsappTemplateKey: templateKey,
      skippedChannelReasons
    }
  } as JsonMap;

  return {
    allowedChannels,
    primaryChannel: allowedChannels.length > 1 ? "MULTI" : allowedChannels[0] || "NONE",
    payload: nextPayload,
    skippedChannelReasons
  };
}

async function logSellerSettlementSkips(input: {
  event: { id: string; merchantId: string; eventKey: string; payload: Prisma.JsonValue | null };
  workflowKey: string;
  skippedChannelReasons: AbandonedChannelSkip[];
}) {
  const payload = asRecord(input.event.payload);
  const settlementId = cleanOptionalString(payload.settlementId) || input.event.id;
  await Promise.all(input.skippedChannelReasons.map((skip) =>
    logCommunication({
      merchantId: input.event.merchantId,
      eventId: input.event.id,
      idempotencyKey: `seller-settlement-skip:${input.event.id}:${skip.channel}:${skip.reason}`,
      channel: skip.channel,
      recipient: `settlement:${settlementId}`,
      templateKey: sellerSettlementTemplateKey(input.event.eventKey),
      status: "SKIPPED",
      provider: "shipmastr",
      providerMessageId: `skip_${input.event.id}_${skip.channel}_${skip.reason}`,
      metadata: {
        eventKey: input.event.eventKey,
        workflowKey: input.workflowKey,
        settlementId,
        settlementStatus: cleanOptionalString(payload.settlementStatus),
        skipReason: skip.reason,
        recipientMasked: skip.recipientMasked
      }
    }).catch(() => undefined)
  ));
}

function invoiceMismatchPreferenceMetadata(metadata: Prisma.JsonValue) {
  const source = asRecord(metadata);
  return {
    invoiceMismatchAlertsEnabled: metadataFlag(source, "invoiceMismatchAlertsEnabled", true),
    duplicateAwbChargeAlertsEnabled: metadataFlag(source, "duplicateAwbChargeAlertsEnabled", true),
    weightDiscrepancyAlertsEnabled: metadataFlag(source, "weightDiscrepancyAlertsEnabled", true),
    zoneMismatchAlertsEnabled: metadataFlag(source, "zoneMismatchAlertsEnabled", true),
    rtoChargeMismatchAlertsEnabled: metadataFlag(source, "rtoChargeMismatchAlertsEnabled", true),
    codFeeMismatchAlertsEnabled: metadataFlag(source, "codFeeMismatchAlertsEnabled", true),
    invoiceResolvedAlertsEnabled: metadataFlag(source, "invoiceResolvedAlertsEnabled", true),
    invoiceDisputeCreatedAlertsEnabled: metadataFlag(source, "invoiceDisputeCreatedAlertsEnabled", true),
    adminFinanceEscalationEnabled: metadataFlag(source, "adminFinanceEscalationEnabled", true),
    invoiceMismatchEmailEnabled: metadataFlag(source, "invoiceMismatchEmailEnabled", true),
    invoiceMismatchWhatsappEnabled: metadataFlag(source, "invoiceMismatchWhatsappEnabled", false),
    invoiceMismatchFallbackSenderAllowed:
      metadataFlag(source, "invoiceMismatchFallbackSenderAllowed", true) ||
      metadataFlag(source, "financeAlertFallbackSenderAllowed", true) ||
      metadataFlag(source, "emailFallbackAllowed", false)
  };
}

function invoiceMismatchPreferenceReason(eventKey: string, metadata: ReturnType<typeof invoiceMismatchPreferenceMetadata>) {
  if (!metadata.invoiceMismatchAlertsEnabled) return "INVOICE_MISMATCH_ALERTS_DISABLED";
  if (eventKey === "invoice.duplicate_awb_charge_detected" && !metadata.duplicateAwbChargeAlertsEnabled) return "DUPLICATE_AWB_ALERTS_DISABLED";
  if (eventKey === "invoice.weight_discrepancy_detected" && !metadata.weightDiscrepancyAlertsEnabled) return "WEIGHT_DISCREPANCY_ALERTS_DISABLED";
  if (eventKey === "invoice.zone_mismatch_detected" && !metadata.zoneMismatchAlertsEnabled) return "ZONE_MISMATCH_ALERTS_DISABLED";
  if (eventKey === "invoice.rto_charge_mismatch_detected" && !metadata.rtoChargeMismatchAlertsEnabled) return "RTO_CHARGE_MISMATCH_ALERTS_DISABLED";
  if (eventKey === "invoice.cod_fee_mismatch_detected" && !metadata.codFeeMismatchAlertsEnabled) return "COD_FEE_MISMATCH_ALERTS_DISABLED";
  if (eventKey === "invoice.resolved" && !metadata.invoiceResolvedAlertsEnabled) return "INVOICE_RESOLVED_ALERTS_DISABLED";
  if (eventKey === "invoice.dispute_created" && !metadata.invoiceDisputeCreatedAlertsEnabled) return "INVOICE_DISPUTE_ALERTS_DISABLED";
  return null;
}

async function planInvoiceMismatchDispatch(input: {
  event: { merchantId: string; payload: Prisma.JsonValue | null; id: string; eventKey: string };
  preference: {
    metadata: Prisma.JsonValue;
    financeControlEnabled: boolean;
    emailEnabled: boolean;
    whatsappEnabled: boolean;
  };
  workflowSetting: {
    channelOrder: string[];
  };
  channelCredentials: Awaited<ReturnType<typeof prisma.merchantChannelCredential.findMany>>;
}): Promise<AbandonedCheckoutDispatchPlan> {
  const payload = asRecord(input.event.payload);
  const metadata = invoiceMismatchPreferenceMetadata(input.preference.metadata);
  const disabledReason = !input.preference.financeControlEnabled
    ? "FINANCE_CONTROL_DISABLED"
    : invoiceMismatchPreferenceReason(input.event.eventKey, metadata);
  const templateKey = invoiceMismatchTemplateKey(input.event.eventKey);
  const preferredChannels = preferredAbandonedChannels(payload, input.workflowSetting.channelOrder);
  const skippedChannelReasons: AbandonedChannelSkip[] = [];
  const allowedChannels: Array<"EMAIL" | "WHATSAPP"> = [];
  const emailCredential = getChannelCredential(input.channelCredentials, "EMAIL");
  const emailMetadata = sanitizeCredentialMetadata(emailCredential?.metadata);
  const emailSender =
    cleanOptionalString(emailMetadata.businessEmail) ||
    cleanOptionalString(emailMetadata.senderEmail) ||
    (metadata.invoiceMismatchFallbackSenderAllowed ? SHIPMASTR_FALLBACK_EMAIL : undefined);
  const emailRecipient =
    cleanOptionalString(payload.merchantEmail) ||
    cleanOptionalString(emailMetadata.businessEmail) ||
    cleanOptionalString(emailMetadata.senderEmail);

  if (disabledReason) {
    return {
      allowedChannels: [],
      primaryChannel: "NONE",
      payload: {
        ...payload,
        channelPlan: {
          ...asRecord(payload.channelPlan),
          emailEnabled: false,
          whatsappEnabled: false,
          adminEscalationEnabled: false,
          fallbackSenderAllowed: metadata.invoiceMismatchFallbackSenderAllowed,
          skippedChannelReasons: [
            { channel: "EMAIL", reason: disabledReason },
            { channel: "WHATSAPP", reason: disabledReason }
          ]
        }
      },
      skippedChannelReasons: [
        { channel: "EMAIL", reason: disabledReason },
        { channel: "WHATSAPP", reason: disabledReason }
      ]
    };
  }

  if (!metadata.invoiceMismatchEmailEnabled || !input.preference.emailEnabled || !preferredChannels.includes("EMAIL")) {
    skippedChannelReasons.push({ channel: "EMAIL", reason: "INVOICE_MISMATCH_EMAIL_DISABLED", recipientMasked: maskEmail(emailRecipient) });
  } else if (!emailRecipient) {
    skippedChannelReasons.push({ channel: "EMAIL", reason: "INVOICE_MISMATCH_EMAIL_RECIPIENT_MISSING" });
  } else if (!emailSender) {
    skippedChannelReasons.push({ channel: "EMAIL", reason: "INVOICE_MISMATCH_EMAIL_SENDER_NOT_READY", recipientMasked: maskEmail(emailRecipient) });
  } else {
    const consent = await checkConsent(input.event.merchantId, "EMAIL", emailRecipient);
    if (consent.allowed) {
      allowedChannels.push("EMAIL");
    } else {
      skippedChannelReasons.push({ channel: "EMAIL", reason: consent.reason, recipientMasked: maskEmail(emailRecipient) });
    }
  }

  if (!metadata.invoiceMismatchWhatsappEnabled || !input.preference.whatsappEnabled || !preferredChannels.includes("WHATSAPP")) {
    skippedChannelReasons.push({ channel: "WHATSAPP", reason: "INVOICE_MISMATCH_WHATSAPP_DISABLED" });
  } else {
    skippedChannelReasons.push({ channel: "WHATSAPP", reason: "WHATSAPP_INVOICE_TEMPLATE_NOT_READY" });
  }

  const merchantName = cleanOptionalString(payload.merchantName) || "Merchant";
  const nextPayload = {
    ...payload,
    templateKey,
    email: {
      ...asRecord(payload.email),
      from: emailSender,
      to: emailRecipient,
      replyTo: emailSender,
      subject: buildInvoiceMismatchSubject({
        merchantName,
        eventKey: input.event.eventKey,
        detectedAt: cleanOptionalString(payload.detectedAt),
        invoiceDate: cleanOptionalString(payload.invoiceDate)
      })
    },
    channelPlan: {
      ...asRecord(payload.channelPlan),
      emailEnabled: allowedChannels.includes("EMAIL"),
      whatsappEnabled: allowedChannels.includes("WHATSAPP"),
      preferredChannels,
      allowedChannels,
      adminEscalationEnabled: metadata.adminFinanceEscalationEnabled,
      emailProvider: emailCredential?.provider || (allowedChannels.includes("EMAIL") ? "shipmastr-fallback" : undefined),
      emailSender,
      emailSenderDomain: safeDomainFromEmail(emailSender),
      replyTo: emailSender,
      fallbackSenderAllowed: metadata.invoiceMismatchFallbackSenderAllowed,
      whatsappTemplateKey: templateKey,
      skippedChannelReasons
    }
  } as JsonMap;

  return {
    allowedChannels,
    primaryChannel: allowedChannels.length > 1 ? "MULTI" : allowedChannels[0] || "NONE",
    payload: nextPayload,
    skippedChannelReasons
  };
}

async function logInvoiceMismatchSkips(input: {
  event: { id: string; merchantId: string; eventKey: string; payload: Prisma.JsonValue | null };
  workflowKey: string;
  skippedChannelReasons: AbandonedChannelSkip[];
}) {
  const payload = asRecord(input.event.payload);
  const invoiceId = cleanOptionalString(payload.invoiceId) || input.event.id;
  const mismatchId = cleanOptionalString(payload.mismatchId) || input.event.id;
  await Promise.all(input.skippedChannelReasons.map((skip) =>
    logCommunication({
      merchantId: input.event.merchantId,
      eventId: input.event.id,
      idempotencyKey: `invoice-mismatch-skip:${input.event.id}:${skip.channel}:${skip.reason}`,
      channel: skip.channel,
      recipient: `invoice:${invoiceId}`,
      templateKey: invoiceMismatchTemplateKey(input.event.eventKey),
      status: "SKIPPED",
      provider: "shipmastr",
      providerMessageId: `skip_${input.event.id}_${skip.channel}_${skip.reason}`,
      metadata: {
        eventKey: input.event.eventKey,
        workflowKey: input.workflowKey,
        invoiceId,
        mismatchId,
        skipReason: skip.reason,
        recipientMasked: skip.recipientMasked
      }
    }).catch(() => undefined)
  ));
}

function courierPickupPreferenceMetadata(metadata: Prisma.JsonValue) {
  const source = asRecord(metadata);
  return {
    courierPickupAlertsEnabled: metadataFlag(source, "courierPickupAlertsEnabled", true),
    merchantPickupDelayAlertsEnabled: metadataFlag(source, "merchantPickupDelayAlertsEnabled", true),
    courierPartnerPickupAlertsEnabled: metadataFlag(source, "courierPartnerPickupAlertsEnabled", true),
    pickupMissedAlertsEnabled: metadataFlag(source, "pickupMissedAlertsEnabled", true),
    pickupFailedAlertsEnabled: metadataFlag(source, "pickupFailedAlertsEnabled", true),
    pickupEscalatedAlertsEnabled: metadataFlag(source, "pickupEscalatedAlertsEnabled", true),
    pickupResolvedAlertsEnabled: metadataFlag(source, "pickupResolvedAlertsEnabled", true),
    pickupDelayEmailEnabled: metadataFlag(source, "pickupDelayEmailEnabled", true),
    pickupDelayWhatsappEnabled: metadataFlag(source, "pickupDelayWhatsappEnabled", false),
    opsEscalationEnabled: metadataFlag(source, "opsEscalationEnabled", true),
    pickupAlertFallbackSenderAllowed:
      metadataFlag(source, "pickupAlertFallbackSenderAllowed", true) ||
      metadataFlag(source, "emailFallbackAllowed", false)
  };
}

function courierPickupPreferenceReason(eventKey: string, metadata: ReturnType<typeof courierPickupPreferenceMetadata>) {
  if (!metadata.courierPickupAlertsEnabled) return "COURIER_PICKUP_ALERTS_DISABLED";
  if (eventKey === "courier.pickup_missed" && !metadata.pickupMissedAlertsEnabled) return "PICKUP_MISSED_ALERTS_DISABLED";
  if (eventKey === "courier.pickup_failed" && !metadata.pickupFailedAlertsEnabled) return "PICKUP_FAILED_ALERTS_DISABLED";
  if (eventKey === "courier.pickup_escalated" && !metadata.pickupEscalatedAlertsEnabled) return "PICKUP_ESCALATED_ALERTS_DISABLED";
  if (eventKey === "courier.pickup_resolved" && !metadata.pickupResolvedAlertsEnabled) return "PICKUP_RESOLVED_ALERTS_DISABLED";
  return null;
}

async function planCourierPickupDelayDispatch(input: {
  event: { merchantId: string; payload: Prisma.JsonValue | null; id: string; eventKey: string };
  preference: {
    metadata: Prisma.JsonValue;
    courierControlEnabled: boolean;
    emailEnabled: boolean;
    whatsappEnabled: boolean;
  };
  workflowSetting: {
    channelOrder: string[];
  };
  channelCredentials: Awaited<ReturnType<typeof prisma.merchantChannelCredential.findMany>>;
}): Promise<AbandonedCheckoutDispatchPlan> {
  const payload = asRecord(input.event.payload);
  const metadata = courierPickupPreferenceMetadata(input.preference.metadata);
  const disabledReason = !input.preference.courierControlEnabled
    ? "COURIER_CONTROL_DISABLED"
    : courierPickupPreferenceReason(input.event.eventKey, metadata);
  const templateKey = courierPickupTemplateKey(input.event.eventKey);
  const preferredChannels = preferredAbandonedChannels(payload, input.workflowSetting.channelOrder);
  const channelPlan = asRecord(payload.channelPlan);
  const skippedChannelReasons: AbandonedChannelSkip[] = [];
  const allowedChannels: Array<"EMAIL" | "WHATSAPP"> = [];
  const emailCredential = getChannelCredential(input.channelCredentials, "EMAIL");
  const emailMetadata = sanitizeCredentialMetadata(emailCredential?.metadata);
  const emailSender =
    cleanOptionalString(emailMetadata.businessEmail) ||
    cleanOptionalString(emailMetadata.senderEmail) ||
    (metadata.pickupAlertFallbackSenderAllowed ? SHIPMASTR_FALLBACK_EMAIL : undefined);
  const merchantRecipient =
    cleanOptionalString(payload.merchantEmail) ||
    cleanOptionalString(emailMetadata.businessEmail) ||
    cleanOptionalString(emailMetadata.senderEmail);
  const courierContact = asRecord(payload.courierContact);
  const courierRecipient = cleanOptionalString(courierContact.email);
  const severity = cleanOptionalString(payload.severity) || "HIGH";
  const opsEscalationAllowed = metadata.opsEscalationEnabled &&
    channelPlan.opsEscalationEnabled !== false &&
    (["HIGH", "CRITICAL"].includes(severity) || preferredChannels.includes("INTERNAL"));

  if (disabledReason) {
    return {
      allowedChannels: [],
      primaryChannel: "NONE",
      payload: {
        ...payload,
        channelPlan: {
          ...channelPlan,
          merchantEmailEnabled: false,
          courierEmailEnabled: false,
          opsEscalationEnabled: false,
          whatsappEnabled: false,
          fallbackSenderAllowed: metadata.pickupAlertFallbackSenderAllowed,
          skippedChannelReasons: [
            { channel: "EMAIL", reason: disabledReason },
            { channel: "WHATSAPP", reason: disabledReason }
          ]
        }
      },
      skippedChannelReasons: [
        { channel: "EMAIL", reason: disabledReason },
        { channel: "WHATSAPP", reason: disabledReason }
      ]
    };
  }

  const emailAllowedByPreference = metadata.pickupDelayEmailEnabled && input.preference.emailEnabled && preferredChannels.includes("EMAIL");
  const merchantEmailEnabled = emailAllowedByPreference && metadata.merchantPickupDelayAlertsEnabled;
  const courierEmailEnabled = emailAllowedByPreference && metadata.courierPartnerPickupAlertsEnabled;
  if (!emailAllowedByPreference) {
    skippedChannelReasons.push({ channel: "EMAIL", reason: "PICKUP_DELAY_EMAIL_DISABLED", recipientMasked: maskEmail(merchantRecipient) });
  } else if (!emailSender) {
    skippedChannelReasons.push({ channel: "EMAIL", reason: "PICKUP_DELAY_EMAIL_SENDER_NOT_READY", recipientMasked: maskEmail(merchantRecipient) });
  } else {
    if (merchantEmailEnabled && merchantRecipient) {
      const consent = await checkConsent(input.event.merchantId, "EMAIL", merchantRecipient);
      if (consent.allowed) {
        allowedChannels.push("EMAIL");
      } else {
        skippedChannelReasons.push({ channel: "EMAIL", reason: consent.reason, recipientMasked: maskEmail(merchantRecipient) });
      }
    } else if (metadata.merchantPickupDelayAlertsEnabled) {
      skippedChannelReasons.push({ channel: "EMAIL", reason: "PICKUP_DELAY_MERCHANT_EMAIL_RECIPIENT_MISSING" });
    }

    if (!courierEmailEnabled) {
      skippedChannelReasons.push({ channel: "EMAIL", reason: "PICKUP_DELAY_COURIER_EMAIL_DISABLED", recipientMasked: maskEmail(courierRecipient) });
    } else if (!courierRecipient) {
      skippedChannelReasons.push({ channel: "EMAIL", reason: "PICKUP_DELAY_COURIER_EMAIL_RECIPIENT_MISSING" });
    } else if (!allowedChannels.includes("EMAIL")) {
      allowedChannels.push("EMAIL");
    }
  }

  if (!metadata.pickupDelayWhatsappEnabled || !input.preference.whatsappEnabled || !preferredChannels.includes("WHATSAPP")) {
    skippedChannelReasons.push({ channel: "WHATSAPP", reason: "PICKUP_DELAY_WHATSAPP_DISABLED" });
  } else {
    skippedChannelReasons.push({ channel: "WHATSAPP", reason: "WHATSAPP_PICKUP_DELAY_TEMPLATE_NOT_READY" });
  }

  if (opsEscalationAllowed && !allowedChannels.includes("EMAIL")) {
    allowedChannels.push("EMAIL");
  }

  const courierPartnerName = cleanOptionalString(payload.courierPartnerName) ||
    cleanOptionalString(asRecord(payload.courierPartner).name) ||
    "Courier";
  const nextPayload = {
    ...payload,
    templateKey,
    email: {
      ...asRecord(payload.email),
      from: emailSender,
      to: merchantRecipient,
      courierTo: courierRecipient,
      replyTo: emailSender,
      subject: buildCourierPickupDelaySubject({
        eventKey: input.event.eventKey,
        courierPartnerName,
        pickupDate: cleanOptionalString(payload.pickupDate)
      })
    },
    channelPlan: {
      ...channelPlan,
      merchantEmailEnabled: Boolean(merchantEmailEnabled && merchantRecipient && emailSender),
      courierEmailEnabled: Boolean(courierEmailEnabled && courierRecipient && emailSender),
      opsEscalationEnabled: opsEscalationAllowed,
      whatsappEnabled: false,
      preferredChannels,
      allowedChannels,
      emailProvider: emailCredential?.provider || (allowedChannels.includes("EMAIL") ? "shipmastr-fallback" : undefined),
      emailSender,
      emailSenderDomain: safeDomainFromEmail(emailSender),
      replyTo: emailSender,
      fallbackSenderAllowed: metadata.pickupAlertFallbackSenderAllowed,
      courierEmailRecipientMasked: maskEmail(courierRecipient),
      merchantEmailRecipientMasked: maskEmail(merchantRecipient),
      whatsappTemplateKey: templateKey,
      skippedChannelReasons
    }
  } as JsonMap;

  return {
    allowedChannels,
    primaryChannel: allowedChannels.length > 1 ? "MULTI" : allowedChannels[0] || "NONE",
    payload: nextPayload,
    skippedChannelReasons
  };
}

async function logCourierPickupDelaySkips(input: {
  event: { id: string; merchantId: string; eventKey: string; payload: Prisma.JsonValue | null };
  workflowKey: string;
  skippedChannelReasons: AbandonedChannelSkip[];
}) {
  const payload = asRecord(input.event.payload);
  const pickupId = cleanOptionalString(payload.pickupId) || input.event.id;
  await Promise.all(input.skippedChannelReasons.map((skip) =>
    logCommunication({
      merchantId: input.event.merchantId,
      eventId: input.event.id,
      idempotencyKey: `courier-pickup-delay-skip:${input.event.id}:${skip.channel}:${skip.reason}`,
      channel: skip.channel,
      recipient: `pickup:${pickupId}`,
      templateKey: courierPickupTemplateKey(input.event.eventKey),
      status: "SKIPPED",
      provider: "shipmastr",
      providerMessageId: `skip_${input.event.id}_${skip.channel}_${skip.reason}`,
      metadata: {
        eventKey: input.event.eventKey,
        workflowKey: input.workflowKey,
        pickupId,
        courierPartnerId: cleanOptionalString(payload.courierPartnerId) || cleanOptionalString(asRecord(payload.courierPartner).id),
        skipReason: skip.reason,
        recipientMasked: skip.recipientMasked
      }
    }).catch(() => undefined)
  ));
}

function courierSlaPreferenceMetadata(metadata: Prisma.JsonValue) {
  const source = asRecord(metadata);
  return {
    courierSlaAlertsEnabled: metadataFlag(source, "courierSlaAlertsEnabled", true),
    merchantSlaAlertsEnabled: metadataFlag(source, "merchantSlaAlertsEnabled", true),
    courierPartnerSlaAlertsEnabled: metadataFlag(source, "courierPartnerSlaAlertsEnabled", true),
    pickupSlaBreachAlertsEnabled: metadataFlag(source, "pickupSlaBreachAlertsEnabled", true),
    firstScanSlaBreachAlertsEnabled: metadataFlag(source, "firstScanSlaBreachAlertsEnabled", true),
    inTransitSlaBreachAlertsEnabled: metadataFlag(source, "inTransitSlaBreachAlertsEnabled", true),
    ofdSlaBreachAlertsEnabled: metadataFlag(source, "ofdSlaBreachAlertsEnabled", true),
    ndrSlaBreachAlertsEnabled: metadataFlag(source, "ndrSlaBreachAlertsEnabled", true),
    reattemptSlaBreachAlertsEnabled: metadataFlag(source, "reattemptSlaBreachAlertsEnabled", true),
    rtoSlaBreachAlertsEnabled: metadataFlag(source, "rtoSlaBreachAlertsEnabled", true),
    codRemittanceSlaBreachAlertsEnabled: metadataFlag(source, "codRemittanceSlaBreachAlertsEnabled", true),
    slaBreachEscalatedAlertsEnabled: metadataFlag(source, "slaBreachEscalatedAlertsEnabled", true),
    slaBreachResolvedAlertsEnabled: metadataFlag(source, "slaBreachResolvedAlertsEnabled", true),
    slaBreachEmailEnabled: metadataFlag(source, "slaBreachEmailEnabled", true),
    slaBreachWhatsappEnabled: metadataFlag(source, "slaBreachWhatsappEnabled", false),
    opsEscalationEnabled: metadataFlag(source, "opsEscalationEnabled", true),
    financeEscalationEnabled: metadataFlag(source, "financeEscalationEnabled", true),
    slaAlertFallbackSenderAllowed:
      metadataFlag(source, "slaAlertFallbackSenderAllowed", true) ||
      metadataFlag(source, "pickupAlertFallbackSenderAllowed", true) ||
      metadataFlag(source, "emailFallbackAllowed", false)
  };
}

function courierSlaPreferenceReason(eventKey: string, metadata: ReturnType<typeof courierSlaPreferenceMetadata>) {
  if (!metadata.courierSlaAlertsEnabled) return "COURIER_SLA_ALERTS_DISABLED";
  if (eventKey === "courier.pickup_sla_breach" && !metadata.pickupSlaBreachAlertsEnabled) return "PICKUP_SLA_ALERTS_DISABLED";
  if (eventKey === "courier.first_scan_sla_breach" && !metadata.firstScanSlaBreachAlertsEnabled) return "FIRST_SCAN_SLA_ALERTS_DISABLED";
  if (eventKey === "courier.in_transit_sla_breach" && !metadata.inTransitSlaBreachAlertsEnabled) return "IN_TRANSIT_SLA_ALERTS_DISABLED";
  if (eventKey === "courier.ofd_sla_breach" && !metadata.ofdSlaBreachAlertsEnabled) return "OFD_SLA_ALERTS_DISABLED";
  if (eventKey === "courier.ndr_response_sla_breach" && !metadata.ndrSlaBreachAlertsEnabled) return "NDR_SLA_ALERTS_DISABLED";
  if (eventKey === "courier.reattempt_sla_breach" && !metadata.reattemptSlaBreachAlertsEnabled) return "REATTEMPT_SLA_ALERTS_DISABLED";
  if (eventKey === "courier.rto_sla_breach" && !metadata.rtoSlaBreachAlertsEnabled) return "RTO_SLA_ALERTS_DISABLED";
  if (eventKey === "courier.cod_remittance_sla_breach" && !metadata.codRemittanceSlaBreachAlertsEnabled) return "COD_REMITTANCE_SLA_ALERTS_DISABLED";
  if (eventKey === "courier.sla_breach_escalated" && !metadata.slaBreachEscalatedAlertsEnabled) return "SLA_ESCALATED_ALERTS_DISABLED";
  if (eventKey === "courier.sla_breach_resolved" && !metadata.slaBreachResolvedAlertsEnabled) return "SLA_RESOLVED_ALERTS_DISABLED";
  return null;
}

async function planCourierSlaBreachDispatch(input: {
  event: { merchantId: string; payload: Prisma.JsonValue | null; id: string; eventKey: string };
  preference: {
    metadata: Prisma.JsonValue;
    courierControlEnabled: boolean;
    emailEnabled: boolean;
    whatsappEnabled: boolean;
  };
  workflowSetting: {
    channelOrder: string[];
  };
  channelCredentials: Awaited<ReturnType<typeof prisma.merchantChannelCredential.findMany>>;
}): Promise<AbandonedCheckoutDispatchPlan> {
  const payload = asRecord(input.event.payload);
  const metadata = courierSlaPreferenceMetadata(input.preference.metadata);
  const disabledReason = !input.preference.courierControlEnabled
    ? "COURIER_CONTROL_DISABLED"
    : courierSlaPreferenceReason(input.event.eventKey, metadata);
  const templateKey = courierSlaTemplateKey(input.event.eventKey);
  const preferredChannels = preferredAbandonedChannels(payload, input.workflowSetting.channelOrder);
  const channelPlan = asRecord(payload.channelPlan);
  const skippedChannelReasons: AbandonedChannelSkip[] = [];
  const allowedChannels: Array<"EMAIL" | "WHATSAPP"> = [];
  const emailCredential = getChannelCredential(input.channelCredentials, "EMAIL");
  const emailMetadata = sanitizeCredentialMetadata(emailCredential?.metadata);
  const emailSender =
    cleanOptionalString(emailMetadata.businessEmail) ||
    cleanOptionalString(emailMetadata.senderEmail) ||
    (metadata.slaAlertFallbackSenderAllowed ? SHIPMASTR_FALLBACK_EMAIL : undefined);
  const merchantRecipient =
    cleanOptionalString(payload.merchantEmail) ||
    cleanOptionalString(emailMetadata.businessEmail) ||
    cleanOptionalString(emailMetadata.senderEmail);
  const courierContact = asRecord(payload.courierContact);
  const courierRecipient = cleanOptionalString(courierContact.email);
  const severity = cleanOptionalString(payload.severity) || "HIGH";
  const opsEscalationAllowed = metadata.opsEscalationEnabled &&
    channelPlan.opsEscalationEnabled !== false &&
    (["HIGH", "CRITICAL"].includes(severity) || preferredChannels.includes("INTERNAL"));
  const financeEscalationAllowed = metadata.financeEscalationEnabled &&
    input.event.eventKey === "courier.cod_remittance_sla_breach" &&
    channelPlan.financeEscalationEnabled !== false;

  if (disabledReason) {
    return {
      allowedChannels: [],
      primaryChannel: "NONE",
      payload: {
        ...payload,
        channelPlan: {
          ...channelPlan,
          merchantEmailEnabled: false,
          courierEmailEnabled: false,
          opsEscalationEnabled: false,
          financeEscalationEnabled: false,
          whatsappEnabled: false,
          fallbackSenderAllowed: metadata.slaAlertFallbackSenderAllowed,
          skippedChannelReasons: [
            { channel: "EMAIL", reason: disabledReason },
            { channel: "WHATSAPP", reason: disabledReason }
          ]
        }
      },
      skippedChannelReasons: [
        { channel: "EMAIL", reason: disabledReason },
        { channel: "WHATSAPP", reason: disabledReason }
      ]
    };
  }

  const emailAllowedByPreference = metadata.slaBreachEmailEnabled && input.preference.emailEnabled && preferredChannels.includes("EMAIL");
  const merchantEmailEnabled = emailAllowedByPreference && metadata.merchantSlaAlertsEnabled;
  const courierEmailEnabled = emailAllowedByPreference && metadata.courierPartnerSlaAlertsEnabled;
  if (!emailAllowedByPreference) {
    skippedChannelReasons.push({ channel: "EMAIL", reason: "COURIER_SLA_EMAIL_DISABLED", recipientMasked: maskEmail(merchantRecipient) });
  } else if (!emailSender) {
    skippedChannelReasons.push({ channel: "EMAIL", reason: "COURIER_SLA_EMAIL_SENDER_NOT_READY", recipientMasked: maskEmail(merchantRecipient) });
  } else {
    if (merchantEmailEnabled && merchantRecipient) {
      const consent = await checkConsent(input.event.merchantId, "EMAIL", merchantRecipient);
      if (consent.allowed) {
        allowedChannels.push("EMAIL");
      } else {
        skippedChannelReasons.push({ channel: "EMAIL", reason: consent.reason, recipientMasked: maskEmail(merchantRecipient) });
      }
    } else if (metadata.merchantSlaAlertsEnabled) {
      skippedChannelReasons.push({ channel: "EMAIL", reason: "COURIER_SLA_MERCHANT_EMAIL_RECIPIENT_MISSING" });
    }

    if (!courierEmailEnabled) {
      skippedChannelReasons.push({ channel: "EMAIL", reason: "COURIER_SLA_COURIER_EMAIL_DISABLED", recipientMasked: maskEmail(courierRecipient) });
    } else if (!courierRecipient) {
      skippedChannelReasons.push({ channel: "EMAIL", reason: "COURIER_SLA_COURIER_EMAIL_RECIPIENT_MISSING" });
    } else if (!allowedChannels.includes("EMAIL")) {
      allowedChannels.push("EMAIL");
    }
  }

  if (!metadata.slaBreachWhatsappEnabled || !input.preference.whatsappEnabled || !preferredChannels.includes("WHATSAPP")) {
    skippedChannelReasons.push({ channel: "WHATSAPP", reason: "COURIER_SLA_WHATSAPP_DISABLED" });
  } else {
    skippedChannelReasons.push({ channel: "WHATSAPP", reason: "WHATSAPP_COURIER_SLA_TEMPLATE_NOT_READY" });
  }

  if ((opsEscalationAllowed || financeEscalationAllowed) && !allowedChannels.includes("EMAIL")) {
    allowedChannels.push("EMAIL");
  }

  const courierPartnerName = cleanOptionalString(payload.courierPartnerName) ||
    cleanOptionalString(asRecord(payload.courierPartner).name) ||
    "Courier";
  const nextPayload = {
    ...payload,
    templateKey,
    email: {
      ...asRecord(payload.email),
      from: emailSender,
      to: merchantRecipient,
      courierTo: courierRecipient,
      replyTo: emailSender,
      subject: buildCourierSlaBreachSubject({
        eventKey: input.event.eventKey,
        courierPartnerName,
        detectedAt: cleanOptionalString(payload.detectedAt)
      })
    },
    channelPlan: {
      ...channelPlan,
      merchantEmailEnabled: Boolean(merchantEmailEnabled && merchantRecipient && emailSender),
      courierEmailEnabled: Boolean(courierEmailEnabled && courierRecipient && emailSender),
      opsEscalationEnabled: opsEscalationAllowed,
      financeEscalationEnabled: financeEscalationAllowed,
      whatsappEnabled: false,
      preferredChannels,
      allowedChannels,
      emailProvider: emailCredential?.provider || (allowedChannels.includes("EMAIL") ? "shipmastr-fallback" : undefined),
      emailSender,
      emailSenderDomain: safeDomainFromEmail(emailSender),
      replyTo: emailSender,
      fallbackSenderAllowed: metadata.slaAlertFallbackSenderAllowed,
      courierEmailRecipientMasked: maskEmail(courierRecipient),
      merchantEmailRecipientMasked: maskEmail(merchantRecipient),
      whatsappTemplateKey: templateKey,
      skippedChannelReasons
    }
  } as JsonMap;

  return {
    allowedChannels,
    primaryChannel: allowedChannels.length > 1 ? "MULTI" : allowedChannels[0] || "NONE",
    payload: nextPayload,
    skippedChannelReasons
  };
}

async function logCourierSlaBreachSkips(input: {
  event: { id: string; merchantId: string; eventKey: string; payload: Prisma.JsonValue | null };
  workflowKey: string;
  skippedChannelReasons: AbandonedChannelSkip[];
}) {
  const payload = asRecord(input.event.payload);
  const breachId = cleanOptionalString(payload.breachId) || input.event.id;
  await Promise.all(input.skippedChannelReasons.map((skip) =>
    logCommunication({
      merchantId: input.event.merchantId,
      eventId: input.event.id,
      idempotencyKey: `courier-sla-breach-skip:${input.event.id}:${skip.channel}:${skip.reason}`,
      channel: skip.channel,
      recipient: `sla-breach:${breachId}`,
      templateKey: courierSlaTemplateKey(input.event.eventKey),
      status: "SKIPPED",
      provider: "shipmastr",
      providerMessageId: `skip_${input.event.id}_${skip.channel}_${skip.reason}`,
      metadata: {
        eventKey: input.event.eventKey,
        workflowKey: input.workflowKey,
        breachId,
        breachType: cleanOptionalString(payload.breachType),
        courierPartnerId: cleanOptionalString(payload.courierPartnerId) || cleanOptionalString(asRecord(payload.courierPartner).id),
        severity: cleanOptionalString(payload.severity),
        skipReason: skip.reason,
        recipientMasked: skip.recipientMasked
      }
    }).catch(() => undefined)
  ));
}

function fakeScanPreferenceMetadata(metadata: Prisma.JsonValue) {
  const source = asRecord(metadata);
  return {
    fakeScanReviewEnabled: metadataFlag(source, "fakeScanReviewEnabled", true),
    merchantFakeScanAlertsEnabled: metadataFlag(source, "merchantFakeScanAlertsEnabled", false),
    courierFakeScanAlertsEnabled: metadataFlag(source, "courierFakeScanAlertsEnabled", false),
    pickupFakeScanAlertsEnabled: metadataFlag(source, "pickupFakeScanAlertsEnabled", true),
    deliveryAttemptFakeScanAlertsEnabled: metadataFlag(source, "deliveryAttemptFakeScanAlertsEnabled", true),
    ndrFakeScanAlertsEnabled: metadataFlag(source, "ndrFakeScanAlertsEnabled", true),
    lateScanAlertsEnabled: metadataFlag(source, "lateScanAlertsEnabled", true),
    impossibleScanSequenceAlertsEnabled: metadataFlag(source, "impossibleScanSequenceAlertsEnabled", true),
    scanLocationMismatchAlertsEnabled: metadataFlag(source, "scanLocationMismatchAlertsEnabled", true),
    duplicateScanPatternAlertsEnabled: metadataFlag(source, "duplicateScanPatternAlertsEnabled", true),
    scanAfterTerminalStateAlertsEnabled: metadataFlag(source, "scanAfterTerminalStateAlertsEnabled", true),
    scanAnomalyEscalatedAlertsEnabled: metadataFlag(source, "scanAnomalyEscalatedAlertsEnabled", true),
    scanAnomalyResolvedAlertsEnabled: metadataFlag(source, "scanAnomalyResolvedAlertsEnabled", true),
    scanAnomalyDismissedAlertsEnabled: metadataFlag(source, "scanAnomalyDismissedAlertsEnabled", true),
    fakeScanEmailEnabled: metadataFlag(source, "fakeScanEmailEnabled", true),
    fakeScanWhatsappEnabled: metadataFlag(source, "fakeScanWhatsappEnabled", false),
    opsEscalationEnabled: metadataFlag(source, "opsEscalationEnabled", true),
    highSeverityAutoEscalationEnabled: metadataFlag(source, "highSeverityAutoEscalationEnabled", true),
    fakeScanFallbackSenderAllowed:
      metadataFlag(source, "fakeScanFallbackSenderAllowed", true) ||
      metadataFlag(source, "slaAlertFallbackSenderAllowed", true) ||
      metadataFlag(source, "pickupAlertFallbackSenderAllowed", true) ||
      metadataFlag(source, "emailFallbackAllowed", false)
  };
}

function fakeScanPreferenceReason(eventKey: string, metadata: ReturnType<typeof fakeScanPreferenceMetadata>) {
  if (!metadata.fakeScanReviewEnabled) return "FAKE_SCAN_REVIEW_DISABLED";
  if (eventKey === "courier.pickup_scan_suspected_fake" && !metadata.pickupFakeScanAlertsEnabled) return "PICKUP_FAKE_SCAN_ALERTS_DISABLED";
  if (eventKey === "courier.delivery_attempt_suspected_fake" && !metadata.deliveryAttemptFakeScanAlertsEnabled) return "DELIVERY_ATTEMPT_FAKE_SCAN_ALERTS_DISABLED";
  if (eventKey === "courier.ndr_scan_suspected_fake" && !metadata.ndrFakeScanAlertsEnabled) return "NDR_FAKE_SCAN_ALERTS_DISABLED";
  if (eventKey === "courier.late_scan_detected" && !metadata.lateScanAlertsEnabled) return "LATE_SCAN_ALERTS_DISABLED";
  if (eventKey === "courier.impossible_scan_sequence" && !metadata.impossibleScanSequenceAlertsEnabled) return "IMPOSSIBLE_SCAN_SEQUENCE_ALERTS_DISABLED";
  if (eventKey === "courier.scan_location_mismatch" && !metadata.scanLocationMismatchAlertsEnabled) return "SCAN_LOCATION_MISMATCH_ALERTS_DISABLED";
  if (eventKey === "courier.duplicate_scan_pattern" && !metadata.duplicateScanPatternAlertsEnabled) return "DUPLICATE_SCAN_PATTERN_ALERTS_DISABLED";
  if (eventKey === "courier.scan_after_terminal_state" && !metadata.scanAfterTerminalStateAlertsEnabled) return "SCAN_AFTER_TERMINAL_STATE_ALERTS_DISABLED";
  if (eventKey === "courier.scan_anomaly_escalated" && !metadata.scanAnomalyEscalatedAlertsEnabled) return "SCAN_ANOMALY_ESCALATED_ALERTS_DISABLED";
  if (eventKey === "courier.scan_anomaly_resolved" && !metadata.scanAnomalyResolvedAlertsEnabled) return "SCAN_ANOMALY_RESOLVED_ALERTS_DISABLED";
  if (eventKey === "courier.scan_anomaly_dismissed" && !metadata.scanAnomalyDismissedAlertsEnabled) return "SCAN_ANOMALY_DISMISSED_ALERTS_DISABLED";
  return null;
}

async function planFakeScanReviewDispatch(input: {
  event: { merchantId: string; payload: Prisma.JsonValue | null; id: string; eventKey: string };
  preference: {
    metadata: Prisma.JsonValue;
    courierControlEnabled: boolean;
    emailEnabled: boolean;
    whatsappEnabled: boolean;
  };
  workflowSetting: {
    channelOrder: string[];
  };
  channelCredentials: Awaited<ReturnType<typeof prisma.merchantChannelCredential.findMany>>;
}): Promise<AbandonedCheckoutDispatchPlan> {
  const payload = asRecord(input.event.payload);
  const metadata = fakeScanPreferenceMetadata(input.preference.metadata);
  const disabledReason = !input.preference.courierControlEnabled
    ? "COURIER_CONTROL_DISABLED"
    : fakeScanPreferenceReason(input.event.eventKey, metadata);
  const templateKey = fakeScanTemplateKey(input.event.eventKey);
  const preferredChannels = preferredAbandonedChannels(payload, input.workflowSetting.channelOrder);
  const channelPlan = asRecord(payload.channelPlan);
  const skippedChannelReasons: AbandonedChannelSkip[] = [];
  const allowedChannels: Array<"EMAIL" | "WHATSAPP"> = [];
  const emailCredential = getChannelCredential(input.channelCredentials, "EMAIL");
  const emailMetadata = sanitizeCredentialMetadata(emailCredential?.metadata);
  const emailSender =
    cleanOptionalString(emailMetadata.businessEmail) ||
    cleanOptionalString(emailMetadata.senderEmail) ||
    (metadata.fakeScanFallbackSenderAllowed ? SHIPMASTR_FALLBACK_EMAIL : undefined);
  const merchantRecipient =
    cleanOptionalString(payload.merchantEmail) ||
    cleanOptionalString(emailMetadata.businessEmail) ||
    cleanOptionalString(emailMetadata.senderEmail);
  const courierContact = asRecord(payload.courierContact);
  const courierRecipient = cleanOptionalString(courierContact.email);
  const severity = cleanOptionalString(payload.severity) || "HIGH";
  const highSeverityEscalation = metadata.highSeverityAutoEscalationEnabled && ["HIGH", "CRITICAL"].includes(severity);
  const opsEscalationAllowed = metadata.opsEscalationEnabled &&
    channelPlan.opsEscalationEnabled !== false &&
    (highSeverityEscalation || preferredChannels.includes("EMAIL"));
  const sellerSafeSummary = cleanOptionalString(payload.sellerSafeSummary);
  const courierSafeSummary = cleanOptionalString(payload.opsReviewSummary) || cleanOptionalString(payload.sellerSafeSummary);

  if (disabledReason) {
    return {
      allowedChannels: [],
      primaryChannel: "NONE",
      payload: {
        ...payload,
        channelPlan: {
          ...channelPlan,
          opsEscalationEnabled: false,
          merchantEmailEnabled: false,
          courierEmailEnabled: false,
          whatsappEnabled: false,
          fallbackSenderAllowed: metadata.fakeScanFallbackSenderAllowed,
          skippedChannelReasons: [
            { channel: "EMAIL", reason: disabledReason },
            { channel: "WHATSAPP", reason: disabledReason }
          ]
        }
      },
      skippedChannelReasons: [
        { channel: "EMAIL", reason: disabledReason },
        { channel: "WHATSAPP", reason: disabledReason }
      ]
    };
  }

  const emailAllowedByPreference = metadata.fakeScanEmailEnabled && input.preference.emailEnabled && preferredChannels.includes("EMAIL");
  const merchantEmailEnabled = emailAllowedByPreference && metadata.merchantFakeScanAlertsEnabled && Boolean(sellerSafeSummary);
  const courierEmailEnabled = emailAllowedByPreference && metadata.courierFakeScanAlertsEnabled && Boolean(courierSafeSummary);
  if (!emailAllowedByPreference) {
    skippedChannelReasons.push({ channel: "EMAIL", reason: "FAKE_SCAN_EMAIL_DISABLED", recipientMasked: maskEmail(merchantRecipient) });
  } else if (!emailSender) {
    skippedChannelReasons.push({ channel: "EMAIL", reason: "FAKE_SCAN_EMAIL_SENDER_NOT_READY", recipientMasked: maskEmail(merchantRecipient) });
  } else {
    if (merchantEmailEnabled && merchantRecipient) {
      allowedChannels.push("EMAIL");
    } else if (metadata.merchantFakeScanAlertsEnabled && !sellerSafeSummary) {
      skippedChannelReasons.push({ channel: "EMAIL", reason: "FAKE_SCAN_SELLER_SAFE_SUMMARY_MISSING", recipientMasked: maskEmail(merchantRecipient) });
    } else if (metadata.merchantFakeScanAlertsEnabled) {
      skippedChannelReasons.push({ channel: "EMAIL", reason: "FAKE_SCAN_MERCHANT_EMAIL_RECIPIENT_MISSING" });
    } else {
      skippedChannelReasons.push({ channel: "EMAIL", reason: "FAKE_SCAN_MERCHANT_EMAIL_DISABLED", recipientMasked: maskEmail(merchantRecipient) });
    }

    if (!courierEmailEnabled) {
      skippedChannelReasons.push({ channel: "EMAIL", reason: metadata.courierFakeScanAlertsEnabled ? "FAKE_SCAN_COURIER_SAFE_SUMMARY_MISSING" : "FAKE_SCAN_COURIER_EMAIL_DISABLED", recipientMasked: maskEmail(courierRecipient) });
    } else if (!courierRecipient) {
      skippedChannelReasons.push({ channel: "EMAIL", reason: "FAKE_SCAN_COURIER_EMAIL_RECIPIENT_MISSING" });
    } else if (!allowedChannels.includes("EMAIL")) {
      allowedChannels.push("EMAIL");
    }
  }

  if (!metadata.fakeScanWhatsappEnabled || !input.preference.whatsappEnabled || !preferredChannels.includes("WHATSAPP")) {
    skippedChannelReasons.push({ channel: "WHATSAPP", reason: "FAKE_SCAN_WHATSAPP_DISABLED" });
  } else {
    skippedChannelReasons.push({ channel: "WHATSAPP", reason: "WHATSAPP_FAKE_SCAN_TEMPLATE_NOT_READY" });
  }

  if (opsEscalationAllowed && !allowedChannels.includes("EMAIL")) {
    allowedChannels.push("EMAIL");
  }

  const courierPartnerName = cleanOptionalString(payload.courierPartnerName) ||
    cleanOptionalString(asRecord(payload.courierPartner).name) ||
    "Courier";
  const nextPayload = {
    ...payload,
    templateKey,
    email: {
      ...asRecord(payload.email),
      from: emailSender,
      to: merchantRecipient,
      courierTo: courierRecipient,
      replyTo: emailSender,
      subject: buildFakeScanReviewSubject({
        eventKey: input.event.eventKey,
        courierPartnerName,
        detectedAt: cleanOptionalString(payload.detectedAt)
      })
    },
    channelPlan: {
      ...channelPlan,
      opsEscalationEnabled: opsEscalationAllowed,
      merchantEmailEnabled: Boolean(merchantEmailEnabled && merchantRecipient && emailSender),
      courierEmailEnabled: Boolean(courierEmailEnabled && courierRecipient && emailSender),
      whatsappEnabled: false,
      preferredChannels,
      allowedChannels,
      emailProvider: emailCredential?.provider || (allowedChannels.includes("EMAIL") ? "shipmastr-fallback" : undefined),
      emailSender,
      emailSenderDomain: safeDomainFromEmail(emailSender),
      replyTo: emailSender,
      fallbackSenderAllowed: metadata.fakeScanFallbackSenderAllowed,
      courierEmailRecipientMasked: maskEmail(courierRecipient),
      merchantEmailRecipientMasked: maskEmail(merchantRecipient),
      whatsappTemplateKey: templateKey,
      skippedChannelReasons
    }
  } as JsonMap;

  return {
    allowedChannels,
    primaryChannel: allowedChannels.length > 1 ? "MULTI" : allowedChannels[0] || "NONE",
    payload: nextPayload,
    skippedChannelReasons
  };
}

async function logFakeScanReviewSkips(input: {
  event: { id: string; merchantId: string; eventKey: string; payload: Prisma.JsonValue | null };
  workflowKey: string;
  skippedChannelReasons: AbandonedChannelSkip[];
}) {
  const payload = asRecord(input.event.payload);
  const anomalyId = cleanOptionalString(payload.anomalyId) || input.event.id;
  await Promise.all(input.skippedChannelReasons.map((skip) =>
    logCommunication({
      merchantId: input.event.merchantId,
      eventId: input.event.id,
      idempotencyKey: `fake-scan-review-skip:${input.event.id}:${skip.channel}:${skip.reason}`,
      channel: skip.channel,
      recipient: `scan-anomaly:${anomalyId}`,
      templateKey: fakeScanTemplateKey(input.event.eventKey),
      status: "SKIPPED",
      provider: "shipmastr",
      providerMessageId: `skip_${input.event.id}_${skip.channel}_${skip.reason}`,
      metadata: {
        eventKey: input.event.eventKey,
        workflowKey: input.workflowKey,
        anomalyId,
        anomalyType: cleanOptionalString(payload.anomalyType),
        courierPartnerId: cleanOptionalString(payload.courierPartnerId) || cleanOptionalString(asRecord(payload.courierPartner).id),
        severity: cleanOptionalString(payload.severity),
        skipReason: skip.reason,
        recipientMasked: skip.recipientMasked
      }
    }).catch(() => undefined)
  ));
}

function courierDailyDigestPreferenceMetadata(metadata: Prisma.JsonValue) {
  const source = asRecord(metadata);
  return {
    courierDailyDigestEnabled: metadataFlag(source, "courierDailyDigestEnabled", true),
    courierPartnerDailyDigestEnabled: metadataFlag(source, "courierPartnerDailyDigestEnabled", false),
    opsDigestEnabled: metadataFlag(source, "opsDigestEnabled", true),
    courierDailyDigestEmailEnabled: metadataFlag(source, "courierDailyDigestEmailEnabled", true),
    courierDailyDigestInternalAlertEnabled: metadataFlag(source, "courierDailyDigestInternalAlertEnabled", true),
    courierDailyDigestWhatsappEnabled: metadataFlag(source, "courierDailyDigestWhatsappEnabled", false),
    courierDailyDigestFallbackSenderAllowed:
      metadataFlag(source, "courierDailyDigestFallbackSenderAllowed", true) ||
      metadataFlag(source, "pickupAlertFallbackSenderAllowed", true) ||
      metadataFlag(source, "emailFallbackAllowed", false)
  };
}

async function planCourierDailyDigestDispatch(input: {
  event: { merchantId: string; payload: Prisma.JsonValue | null; id: string; eventKey: string };
  preference: {
    metadata: Prisma.JsonValue;
    courierControlEnabled: boolean;
    emailEnabled: boolean;
    whatsappEnabled: boolean;
  };
  workflowSetting: {
    channelOrder: string[];
  };
  channelCredentials: Awaited<ReturnType<typeof prisma.merchantChannelCredential.findMany>>;
}): Promise<AbandonedCheckoutDispatchPlan> {
  const payload = asRecord(input.event.payload);
  const channelPlan = asRecord(payload.channelPlan);
  const metadata = courierDailyDigestPreferenceMetadata(input.preference.metadata);
  const scope = cleanOptionalString(payload.scope) === "COURIER_PARTNER" ? "COURIER_PARTNER" : "OPS";
  const templateKey = courierDailyDigestTemplateKey(input.event.eventKey, scope);
  const preferredChannels = preferredAbandonedChannels(payload, input.workflowSetting.channelOrder);
  const skippedChannelReasons: AbandonedChannelSkip[] = [];
  const allowedChannels: Array<"EMAIL" | "WHATSAPP"> = [];
  const emailCredential = getChannelCredential(input.channelCredentials, "EMAIL");
  const emailMetadata = sanitizeCredentialMetadata(emailCredential?.metadata);
  const emailSender =
    cleanOptionalString(emailMetadata.businessEmail) ||
    cleanOptionalString(emailMetadata.senderEmail) ||
    (metadata.courierDailyDigestFallbackSenderAllowed ? SHIPMASTR_FALLBACK_EMAIL : undefined);
  const courierContact = asRecord(payload.courierContact);
  const courierRecipient = cleanOptionalString(courierContact.email);
  const opsRecipient =
    cleanOptionalString(payload.merchantEmail) ||
    cleanOptionalString(emailMetadata.businessEmail) ||
    cleanOptionalString(emailMetadata.senderEmail);
  const emailRecipient = scope === "COURIER_PARTNER" ? courierRecipient : opsRecipient;
  const partnerExplicitlyEnabled = channelPlan.courierPartnerDailyDigestEnabled === true;
  const disabledReason = !input.preference.courierControlEnabled
    ? "COURIER_CONTROL_DISABLED"
    : !metadata.courierDailyDigestEnabled
      ? "COURIER_DAILY_DIGEST_DISABLED"
      : scope === "OPS" && !metadata.opsDigestEnabled
        ? "COURIER_OPS_DAILY_DIGEST_DISABLED"
        : scope === "COURIER_PARTNER" && !metadata.courierPartnerDailyDigestEnabled && !partnerExplicitlyEnabled
          ? "COURIER_PARTNER_DAILY_DIGEST_DISABLED"
          : null;

  if (disabledReason) {
    return {
      allowedChannels: [],
      primaryChannel: "NONE",
      payload: {
        ...payload,
        channelPlan: {
          ...channelPlan,
          opsEmailEnabled: false,
          courierEmailEnabled: false,
          internalAlertEnabled: false,
          whatsappEnabled: false,
          fallbackSenderAllowed: metadata.courierDailyDigestFallbackSenderAllowed,
          skippedChannelReasons: [
            { channel: "EMAIL", reason: disabledReason },
            { channel: "WHATSAPP", reason: disabledReason }
          ]
        }
      },
      skippedChannelReasons: [
        { channel: "EMAIL", reason: disabledReason },
        { channel: "WHATSAPP", reason: disabledReason }
      ]
    };
  }

  const emailAllowedByPreference = metadata.courierDailyDigestEmailEnabled &&
    input.preference.emailEnabled &&
    preferredChannels.includes("EMAIL");
  const internalAlertAllowed = metadata.courierDailyDigestInternalAlertEnabled &&
    channelPlan.internalAlertEnabled !== false &&
    scope === "OPS" &&
    preferredChannels.includes("EMAIL");

  if (!emailAllowedByPreference && !internalAlertAllowed) {
    skippedChannelReasons.push({ channel: "EMAIL", reason: "COURIER_DAILY_DIGEST_EMAIL_DISABLED", recipientMasked: maskEmail(emailRecipient) });
  } else if (!emailSender) {
    skippedChannelReasons.push({ channel: "EMAIL", reason: "COURIER_DAILY_DIGEST_EMAIL_SENDER_NOT_READY", recipientMasked: maskEmail(emailRecipient) });
  } else if (!emailRecipient && !internalAlertAllowed) {
    skippedChannelReasons.push({ channel: "EMAIL", reason: "COURIER_DAILY_DIGEST_RECIPIENT_MISSING" });
  } else {
    allowedChannels.push("EMAIL");
  }

  if (!metadata.courierDailyDigestWhatsappEnabled || !input.preference.whatsappEnabled || !preferredChannels.includes("WHATSAPP")) {
    skippedChannelReasons.push({ channel: "WHATSAPP", reason: "COURIER_DAILY_DIGEST_WHATSAPP_DISABLED" });
  } else {
    skippedChannelReasons.push({ channel: "WHATSAPP", reason: "WHATSAPP_COURIER_DAILY_DIGEST_TEMPLATE_NOT_READY" });
  }

  const subject = buildCourierDailyDigestSubject({
    scope,
    courierPartnerName: cleanOptionalString(payload.courierPartnerName) || cleanOptionalString(asRecord(payload.courierPartner).name),
    digestDate: cleanOptionalString(payload.digestDate) || isoDateInTimeZone(),
    timezone: cleanOptionalString(payload.timezone)
  });
  const nextPayload = {
    ...payload,
    templateKey,
    email: {
      ...asRecord(payload.email),
      from: emailSender,
      to: emailRecipient,
      courierTo: courierRecipient,
      replyTo: emailSender,
      subject
    },
    channelPlan: {
      ...channelPlan,
      opsEmailEnabled: scope === "OPS" && allowedChannels.includes("EMAIL"),
      courierEmailEnabled: scope === "COURIER_PARTNER" && allowedChannels.includes("EMAIL"),
      internalAlertEnabled: internalAlertAllowed,
      whatsappEnabled: false,
      preferredChannels,
      allowedChannels,
      emailProvider: emailCredential?.provider || (allowedChannels.includes("EMAIL") ? "shipmastr-fallback" : undefined),
      emailSender,
      emailSenderDomain: safeDomainFromEmail(emailSender),
      replyTo: emailSender,
      fallbackSenderAllowed: metadata.courierDailyDigestFallbackSenderAllowed,
      courierEmailRecipientMasked: maskEmail(courierRecipient),
      opsEmailRecipientMasked: maskEmail(opsRecipient),
      whatsappTemplateKey: templateKey,
      skippedChannelReasons
    }
  } as JsonMap;

  return {
    allowedChannels,
    primaryChannel: allowedChannels.length > 1 ? "MULTI" : allowedChannels[0] || "NONE",
    payload: nextPayload,
    skippedChannelReasons
  };
}

async function logCourierDailyDigestSkips(input: {
  event: { id: string; merchantId: string; eventKey: string; payload: Prisma.JsonValue | null };
  workflowKey: string;
  skippedChannelReasons: AbandonedChannelSkip[];
}) {
  const payload = asRecord(input.event.payload);
  const digestId = cleanOptionalString(payload.digestId) || input.event.id;
  await Promise.all(input.skippedChannelReasons.map((skip) =>
    logCommunication({
      merchantId: input.event.merchantId,
      eventId: input.event.id,
      idempotencyKey: `courier-daily-digest-skip:${input.event.id}:${skip.channel}:${skip.reason}`,
      channel: skip.channel,
      recipient: `courier-digest:${digestId}`,
      templateKey: courierDailyDigestTemplateKey(input.event.eventKey, cleanOptionalString(payload.scope)),
      status: "SKIPPED",
      provider: "shipmastr",
      providerMessageId: `skip_${input.event.id}_${skip.channel}_${skip.reason}`,
      metadata: {
        eventKey: input.event.eventKey,
        workflowKey: input.workflowKey,
        digestId,
        digestDate: cleanOptionalString(payload.digestDate),
        scope: cleanOptionalString(payload.scope),
        courierPartnerId: cleanOptionalString(payload.courierPartnerId) || cleanOptionalString(asRecord(payload.courierPartner).id),
        skipReason: skip.reason,
        recipientMasked: skip.recipientMasked
      }
    }).catch(() => undefined)
  ));
}

async function planTransactionalWhatsappDispatch(input: {
  event: { id: string; merchantId: string; eventKey: string; payload: Prisma.JsonValue | null };
  workflowKey: string;
}) {
  const templateKey = whatsappWorkflowTemplateKey(input.workflowKey);
  if (!templateKey) return null;

  const payload = asRecord(input.event.payload);
  const buyerContact = asRecord(payload.buyerContact);
  const recipient = cleanOptionalString(buyerContact.phone);
  const recipientMasked = cleanOptionalString(buyerContact.phoneMasked) || maskPhone(recipient);
  const credential = await prisma.merchantChannelCredential.findFirst({
    where: {
      merchantId: input.event.merchantId,
      channel: "WHATSAPP",
      status: { in: ["ACTIVE", "VERIFIED"] }
    },
    orderBy: { updatedAt: "desc" }
  });
  const providerPlan = resolveWhatsappProviderPlan({
    credential,
    templateKey
  });
  const skippedChannelReasons: AbandonedChannelSkip[] = [];

  if (!recipient) {
    skippedChannelReasons.push({ channel: "WHATSAPP", reason: "WHATSAPP_RECIPIENT_MISSING", recipientMasked });
  } else if (!providerPlan.allowed) {
    skippedChannelReasons.push({
      channel: "WHATSAPP",
      reason: providerPlan.reason,
      recipientMasked
    });
  }

  const nextPayload = {
    ...payload,
    channelPlan: {
      ...asRecord(payload.channelPlan),
      whatsappEnabled: Boolean(recipient && providerPlan.allowed),
      allowedChannels: recipient && providerPlan.allowed ? ["WHATSAPP"] : [],
      preferredChannels: ["WHATSAPP"],
      whatsappProvider: credential?.provider,
      whatsappProviderMode: providerPlan.allowed ? providerPlan.mode : undefined,
      whatsappBusinessNumber: providerPlan.businessNumberMasked,
      whatsappPhoneNumberIdMasked: providerPlan.allowed ? providerPlan.phoneNumberIdMasked : undefined,
      whatsappTemplateKey: templateKey,
      whatsappTemplateName: providerPlan.allowed ? providerPlan.providerTemplateName : templateKey,
      whatsappTemplateLanguage: providerPlan.allowed ? providerPlan.language : undefined,
      whatsappTemplateNamespace: providerPlan.allowed ? providerPlan.templateNamespace : undefined,
      skippedChannelReasons
    }
  } as JsonMap;

  return {
    allowed: Boolean(recipient && providerPlan.allowed),
    payload: nextPayload,
    templateKey,
    recipient: recipient || `event:${input.event.id}`,
    skippedChannelReasons
  };
}

async function logTransactionalWhatsappSkips(input: {
  event: { id: string; merchantId: string; eventKey: string };
  workflowKey: string;
  templateKey: string;
  recipient: string;
  skippedChannelReasons: AbandonedChannelSkip[];
}) {
  await Promise.all(input.skippedChannelReasons.map((skip) =>
    logCommunication({
      merchantId: input.event.merchantId,
      eventId: input.event.id,
      idempotencyKey: `whatsapp-skip:${input.event.id}:${input.templateKey}:${skip.reason}`,
      channel: "WHATSAPP",
      recipient: input.recipient,
      templateKey: input.templateKey,
      status: "SKIPPED",
      provider: "shipmastr",
      providerMessageId: `skip_${input.event.id}_WHATSAPP_${skip.reason}`,
      metadata: {
        eventKey: input.event.eventKey,
        workflowKey: input.workflowKey,
        skipReason: skip.reason,
        recipientMasked: skip.recipientMasked
      }
    }).catch(() => undefined)
  ));
}

export async function renderTemplate(input: RenderTemplateInput) {
  requireMerchantId(input.merchantId);

  const template = await prisma.automationTemplate.findFirst({
    where: {
      key: input.templateKey,
      channel: input.channel,
      active: true,
      OR: [{ merchantId: input.merchantId }, { merchantId: null }]
    },
    orderBy: [{ merchantId: "desc" }]
  });

  if (!template) {
    return {
      subject: null,
      body: "",
      template: null
    };
  }

  const variables = input.variables || {};
  const replaceTokens = (value: string | null) =>
    (value || "").replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key: string) =>
      stringifyTemplateValue(variables[key])
    );

  return {
    subject: replaceTokens(template.subject),
    body: replaceTokens(template.body),
    template
  };
}

export async function logCommunication(input: LogCommunicationInput) {
  requireMerchantId(input.merchantId);
  const idempotencyKey = makeCommunicationIdempotencyKey(input);
  const existingLog = await prisma.communicationLog.findFirst({
    where: {
      merchantId: input.merchantId,
      idempotencyKey
    }
  });

  if (existingLog) {
    return existingLog;
  }

  const data: Prisma.CommunicationLogUncheckedCreateInput = {
    merchantId: input.merchantId,
    idempotencyKey,
    channel: input.channel,
    recipient: input.recipient,
    status: input.status || "QUEUED",
    metadata: toJson(input.metadata)
  };

  if (input.eventId) data.eventId = input.eventId;
  if (input.campaignId) data.campaignId = input.campaignId;
  if (input.templateKey) data.templateKey = input.templateKey;
  if (input.renderedMessage) data.renderedMessage = input.renderedMessage;
  if (input.provider) data.provider = input.provider;
  if (input.providerMessageId) data.providerMessageId = input.providerMessageId;

  const log = await prisma.communicationLog.create({
    data
  });

  const today = new Date();
  const windowKey = `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`;
  await prisma.automationFrequencyLedger.upsert({
    where: {
      merchantId_subject_channel_windowKey: {
        merchantId: input.merchantId,
        subject: input.recipient,
        channel: input.channel,
        windowKey
      }
    },
    create: {
      merchantId: input.merchantId,
      subject: input.recipient,
      channel: input.channel,
      windowKey,
      count: 1,
      resetAt: addMinutes(new Date(), 24 * 60)
    },
    update: {
      count: { increment: 1 }
    }
  });

  await recordAutomationUsage({
    merchantId: input.merchantId,
    usageType: input.status === "FAILED"
      ? "MESSAGE_FAILED"
      : MESSAGE_SENT_STATUSES.has(input.status || "")
        ? "MESSAGE_SENT"
        : "MESSAGE_ATTEMPT",
    channel: input.channel,
    eventKey: input.metadata?.eventKey as string | undefined,
    workflowKey: input.metadata?.workflowKey as string | undefined,
    metadata: {
      eventId: input.eventId,
      campaignId: input.campaignId,
      status: input.status || "QUEUED"
    }
  });

  return log;
}

export async function markAutomationEventProcessed(id: string, dispatchResult: JsonMap = {}) {
  return prisma.automationEvent.update({
    where: { id },
    data: {
      status: "PROCESSED",
      dispatchResult: toJson(dispatchResult),
      processedAt: new Date(),
      error: null
    }
  });
}

export async function markAutomationEventFailed(id: string, error: string, retryInMinutes = 15, maxAttempts = 3) {
  const event = await prisma.automationEvent.findUnique({ where: { id } });

  return prisma.automationEvent.update({
    where: { id },
    data: {
      status: "FAILED",
      error,
      failedAt: new Date(),
      nextAttemptAt: event && event.attempts < maxAttempts ? addMinutes(new Date(), retryInMinutes) : null
    }
  });
}

export async function handleAutomationCallback(input: AutomationCallbackInput) {
  const sourceEvent = await prisma.automationEvent.findUnique({
    where: { id: input.eventId }
  });

  if (!sourceEvent) {
    throw new AutomationCallbackError(404, "AUTOMATION_EVENT_NOT_FOUND");
  }

  const workflowKey = WORKFLOW_BY_EVENT[sourceEvent.eventKey] || "SM_01_EVENT_ROUTER";
  const workflowScope = getWorkflowScope(workflowKey);
  let communication = null;
  const communications: Array<Awaited<ReturnType<typeof logCommunication>>> = [];

  if (input.merchantId && input.merchantId !== sourceEvent.merchantId) {
    throw new AutomationCallbackError(403, "AUTOMATION_CALLBACK_MERCHANT_MISMATCH");
  }

  const logCallbackCommunication = async (communicationInput: LogCommunicationInput) => {
    if (communicationInput.merchantId !== sourceEvent.merchantId) {
      throw new AutomationCallbackError(403, "AUTOMATION_CALLBACK_MERCHANT_MISMATCH");
    }

    if (communicationInput.campaignId) {
      const campaign = await prisma.marketingCampaign.findFirst({
        where: {
          id: communicationInput.campaignId,
          merchantId: sourceEvent.merchantId
        },
        select: { id: true }
      });

      if (!campaign) {
        throw new AutomationCallbackError(403, "AUTOMATION_CALLBACK_CAMPAIGN_MISMATCH");
      }
    }

    const log = await logCommunication({
      ...communicationInput,
      merchantId: sourceEvent.merchantId,
      eventId: input.eventId,
      templateKey: normalizeCallbackTemplateKey(sourceEvent.eventKey, communicationInput.templateKey),
      metadata: {
        ...(communicationInput.metadata || {}),
        eventKey: sourceEvent.eventKey,
        workflowKey,
        actorType: workflowScope.actorType,
        permissionScope: workflowScope.permissionScope
      }
    });
    communications.push(log);
    return log;
  };

  if (input.communication) {
    communication = await logCallbackCommunication(input.communication);
  }

  for (const item of input.communications || []) {
    const logged = await logCallbackCommunication(item);
    if (!communication) communication = logged;
  }

  if (input.channelResults?.length) {
    const payload = asRecord(sourceEvent.payload);
    const cartId = cleanOptionalString(payload.cartId);
    const checkoutId = cleanOptionalString(payload.checkoutId);
    const recoveryUrl = cleanOptionalString(payload.recoveryUrl);
    const buyerId = cleanOptionalString(payload.buyerId);
    const lastOrderId = cleanOptionalString(payload.lastOrderId);
    const storeUrl = cleanOptionalString(payload.storeUrl) || recoveryUrl;
    const remittanceId = cleanOptionalString(payload.remittanceId);
    const financeSummaryUrl = cleanOptionalString(payload.financeSummaryUrl);
    const dueDate = cleanOptionalString(payload.dueDate);
    const settlementDate = cleanOptionalString(payload.settlementDate);
    const settlementId = cleanOptionalString(payload.settlementId);
    const settlementStatus = cleanOptionalString(payload.settlementStatus);
    const expectedPayoutDate = cleanOptionalString(payload.expectedPayoutDate);
    const paidAt = cleanOptionalString(payload.paidAt);
    const statementUrl = cleanOptionalString(payload.statementUrl);
    const ageingBucket = cleanOptionalString(payload.ageingBucket);
    const invoiceId = cleanOptionalString(payload.invoiceId);
    const mismatchId = cleanOptionalString(payload.mismatchId);
    const mismatchType = cleanOptionalString(payload.mismatchType);
    const severity = cleanOptionalString(payload.severity);
    const disputeUrl = cleanOptionalString(payload.disputeUrl);
    const pickupId = cleanOptionalString(payload.pickupId);
    const pickupDate = cleanOptionalString(payload.pickupDate);
    const courierPartnerId = cleanOptionalString(payload.courierPartnerId) || cleanOptionalString(asRecord(payload.courierPartner).id);
    const courierPartnerName = cleanOptionalString(payload.courierPartnerName) || cleanOptionalString(asRecord(payload.courierPartner).name);
    const breachId = cleanOptionalString(payload.breachId);
    const breachType = cleanOptionalString(payload.breachType);
    const breachMinutes = cleanOptionalNumber(payload.breachMinutes);
    const anomalyId = cleanOptionalString(payload.anomalyId);
    const anomalyType = cleanOptionalString(payload.anomalyType);
    const scanStatus = cleanOptionalString(payload.scanStatus);
    const anomalyReasonCode = cleanOptionalString(payload.anomalyReasonCode);
    const delayMinutes = cleanOptionalNumber(payload.delayMinutes);
    const digestId = cleanOptionalString(payload.digestId);
    const digestDate = cleanOptionalString(payload.digestDate);
    const digestScope = cleanOptionalString(payload.scope);
    const callbackTemplateKey = cleanOptionalString(input.result?.templateKey);
    const channelTemplateKey = sourceEvent.eventKey === "buyer.repeat_purchase_due"
      ? REPEAT_BUYER_TEMPLATE_KEY
      : sourceEvent.eventKey === "cart.abandoned"
        ? ABANDONED_CHECKOUT_TEMPLATE_KEY
        : COD_REMITTANCE_EVENT_KEYS.has(sourceEvent.eventKey)
          ? codRemittanceTemplateKey(sourceEvent.eventKey)
          : SELLER_SETTLEMENT_EVENT_KEYS.has(sourceEvent.eventKey)
            ? sellerSettlementTemplateKey(sourceEvent.eventKey)
          : INVOICE_MISMATCH_EVENT_KEYS.has(sourceEvent.eventKey)
            ? invoiceMismatchTemplateKey(sourceEvent.eventKey)
          : COURIER_PICKUP_DELAY_EVENT_KEYS.has(sourceEvent.eventKey)
            ? courierPickupTemplateKey(sourceEvent.eventKey)
          : COURIER_SLA_BREACH_EVENT_KEYS.has(sourceEvent.eventKey)
            ? courierSlaTemplateKey(sourceEvent.eventKey)
          : FAKE_SCAN_REVIEW_EVENT_KEYS.has(sourceEvent.eventKey)
            ? fakeScanTemplateKey(sourceEvent.eventKey)
          : COURIER_DAILY_DIGEST_EVENT_KEYS.has(sourceEvent.eventKey)
            ? courierDailyDigestTemplateKey(sourceEvent.eventKey, digestScope)
        : normalizeCallbackTemplateKey(sourceEvent.eventKey, callbackTemplateKey || undefined);
    const idempotencyPrefix = sourceEvent.eventKey === "buyer.repeat_purchase_due"
      ? "repeat-buyer"
      : COD_REMITTANCE_EVENT_KEYS.has(sourceEvent.eventKey)
        ? "cod-remittance"
        : SELLER_SETTLEMENT_EVENT_KEYS.has(sourceEvent.eventKey)
          ? "seller-settlement"
        : INVOICE_MISMATCH_EVENT_KEYS.has(sourceEvent.eventKey)
          ? "invoice-mismatch"
        : COURIER_PICKUP_DELAY_EVENT_KEYS.has(sourceEvent.eventKey)
          ? "courier-pickup-delay"
        : COURIER_SLA_BREACH_EVENT_KEYS.has(sourceEvent.eventKey)
          ? "courier-sla-breach"
        : FAKE_SCAN_REVIEW_EVENT_KEYS.has(sourceEvent.eventKey)
          ? "fake-scan-review"
        : COURIER_DAILY_DIGEST_EVENT_KEYS.has(sourceEvent.eventKey)
          ? "courier-daily-digest"
        : "abandoned-checkout";
    const fallbackRecipient = buyerId
      ? `buyer:${buyerId}`
      : cartId
        ? `cart:${cartId}`
        : remittanceId
          ? `remittance:${remittanceId}`
          : settlementId
            ? `settlement:${settlementId}`
          : invoiceId
            ? `invoice:${invoiceId}`
          : pickupId
            ? `pickup:${pickupId}`
          : breachId
            ? `sla-breach:${breachId}`
          : anomalyId
            ? `scan-anomaly:${anomalyId}`
          : digestId
            ? `courier-digest:${digestId}`
        : sourceEvent.id;

    for (const channelResult of input.channelResults) {
      const status = channelResult.status.toUpperCase();
      const recipient = cleanOptionalString(channelResult.recipient) ||
        cleanOptionalString(channelResult.sender) ||
        fallbackRecipient;
      const skippedReason = cleanOptionalString(channelResult.skipReason);
      const skippedIdempotencyKey = status === "SKIPPED" && skippedReason
        ? `${idempotencyPrefix}-skip:${input.eventId}:${channelResult.channel}:${skippedReason}`
        : undefined;
      const logged = await logCallbackCommunication({
        merchantId: sourceEvent.merchantId,
        eventId: input.eventId,
        idempotencyKey: skippedIdempotencyKey || (channelResult.provider && channelResult.providerMessageId
          ? `provider:${channelResult.provider}:${channelResult.providerMessageId}`
          : `${idempotencyPrefix}-channel:${input.eventId}:${channelResult.channel}:${status}:${skippedReason || "none"}`),
        channel: channelResult.channel,
        recipient,
        templateKey: normalizeCallbackTemplateKey(
          sourceEvent.eventKey,
          cleanOptionalString(asRecord(channelResult.metadata).templateKey) || channelTemplateKey
        ),
        status,
        provider: channelResult.provider,
        providerMessageId: channelResult.providerMessageId,
        metadata: {
          ...(channelResult.metadata || {}),
          sender: channelResult.sender,
          replyTo: channelResult.replyTo || channelResult.sender,
          skipReason: skippedReason,
          error: channelResult.error,
          cartId,
          checkoutId,
          recoveryUrl,
          buyerId,
          lastOrderId,
          storeUrl,
          remittanceId,
          financeSummaryUrl,
          dueDate,
          settlementDate,
          settlementId,
          settlementStatus,
          expectedPayoutDate,
          paidAt,
          statementUrl,
          ageingBucket,
          invoiceId,
          mismatchId,
          mismatchType,
          severity,
          disputeUrl,
          pickupId,
          pickupDate,
          courierPartnerId,
          courierPartnerName,
          breachId,
          breachType,
          breachMinutes,
          anomalyId,
          anomalyType,
          scanStatus,
          anomalyReasonCode,
          delayMinutes,
          digestId,
          digestDate,
          scope: digestScope
        }
      });
      if (!communication) communication = logged;
    }
  }

  const event = input.status === "PROCESSED"
    ? sourceEvent.status === "PROCESSED"
      ? sourceEvent
      : await markAutomationEventProcessed(input.eventId, {
        ...(input.result || {}),
        workflowKey,
        actorType: workflowScope.actorType,
        permissionScope: workflowScope.permissionScope
      })
    : await markAutomationEventFailed(input.eventId, input.error || "Workflow callback failed");

  await prisma.auditLog.create({
    data: {
      merchantId: sourceEvent.merchantId,
      action: input.status === "PROCESSED" ? "automation.callback_processed" : "automation.callback_failed",
      entityType: "AutomationEvent",
      entityId: input.eventId,
      metadata: {
        eventKey: sourceEvent.eventKey,
        workflowKey,
        actorType: workflowScope.actorType,
        permissionScope: workflowScope.permissionScope,
        status: input.status
      }
    }
  }).catch(() => undefined);

  return { event, communication, communications };
}

function normalizeWhatsappProviderStatus(input?: string | undefined) {
  const normalized = cleanOptionalString(input)?.toUpperCase().replace(/[\s-]+/g, "_");
  if (!normalized) return "SENT";
  if (["SENT", "DELIVERED", "READ", "FAILED"].includes(normalized)) return normalized;
  if (["MESSAGE_SENT", "ACCEPTED", "SUBMITTED", "QUEUED"].includes(normalized)) return "SENT";
  if (normalized === "MESSAGE_DELIVERED") return "DELIVERED";
  if (normalized === "MESSAGE_READ") return "READ";
  if (["ERROR", "UNDELIVERED", "REJECTED"].includes(normalized)) return "FAILED";
  return "SENT";
}

function isWhatsappOptOutMessage(message?: string | undefined) {
  const normalized = cleanOptionalString(message)?.trim().toUpperCase().replace(/\s+/g, " ");
  return Boolean(normalized && WHATSAPP_OPT_OUT_WORDS.has(normalized));
}

function sanitizeProviderCallbackMetadata(metadata?: JsonMap | undefined) {
  const source = asRecord(metadata);
  const safeKeys = ["errorCode", "errorType", "conversationId", "pricingCategory", "timestamp"];
  return Object.fromEntries(
    safeKeys
      .map((key) => [key, source[key]])
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
  ) as JsonMap;
}

export async function handleWhatsappProviderCallback(input: WhatsappProviderCallbackInput) {
  const providerMessageId = cleanOptionalString(input.providerMessageId);
  if (!providerMessageId) {
    throw new AutomationCallbackError(400, "WHATSAPP_PROVIDER_MESSAGE_ID_REQUIRED");
  }

  const communication = await prisma.communicationLog.findFirst({
    where: {
      channel: "WHATSAPP",
      providerMessageId
    }
  });

  if (!communication) {
    throw new AutomationCallbackError(404, "WHATSAPP_COMMUNICATION_NOT_FOUND");
  }

  if (input.merchantId && input.merchantId !== communication.merchantId) {
    throw new AutomationCallbackError(403, "WHATSAPP_CALLBACK_MERCHANT_MISMATCH");
  }

  const status = normalizeWhatsappProviderStatus(input.status || input.eventType);
  const now = new Date();
  const callbackMetadata = sanitizeProviderCallbackMetadata(input.metadata);
  const metadata = {
    ...asRecord(communication.metadata),
    providerStatus: cleanOptionalString(input.status || input.eventType) || status,
    provider: cleanOptionalString(input.provider) || communication.provider,
    templateKey: cleanOptionalString(input.templateKey) || communication.templateKey,
    senderMasked: maskPhone(input.sender),
    recipientMasked: maskPhone(input.recipient) || asRecord(communication.metadata).recipientMasked,
    failureReason: status === "FAILED"
      ? cleanOptionalString(input.failureReason) || "WHATSAPP_PROVIDER_FAILED"
      : undefined,
    providerCallbackAt: now.toISOString(),
    providerCallbackMetadata: callbackMetadata
  };

  const data: Prisma.CommunicationLogUpdateInput = {
    status,
    metadata: toJson(metadata)
  };
  if (input.provider && !communication.provider) data.provider = input.provider;
  if (status === "SENT" && !communication.sentAt) data.sentAt = now;
  if (status === "DELIVERED") data.deliveredAt = now;
  if (status === "READ") data.readAt = now;
  if (status === "FAILED") data.failedAt = now;

  const updated = await prisma.communicationLog.update({
    where: { id: communication.id },
    data
  });

  let optOut = null;
  if (isWhatsappOptOutMessage(input.buyerMessage)) {
    const subject = cleanOptionalString(input.recipient) || communication.recipient;
    optOut = await prisma.automationOptOut.upsert({
      where: {
        merchantId_channel_subject: {
          merchantId: communication.merchantId,
          channel: "WHATSAPP",
          subject
        }
      },
      create: {
        merchantId: communication.merchantId,
        channel: "WHATSAPP",
        subject,
        reason: "BUYER_OPT_OUT",
        metadata: toJson({
          providerMessageId,
          source: "whatsapp_provider_callback"
        })
      },
      update: {
        reason: "BUYER_OPT_OUT",
        optedOutAt: now,
        expiresAt: null,
        metadata: toJson({
          providerMessageId,
          source: "whatsapp_provider_callback"
        })
      }
    });
  }

  await prisma.auditLog.create({
    data: {
      merchantId: communication.merchantId,
      action: optOut ? "automation.whatsapp_opt_out_recorded" : "automation.whatsapp_provider_callback",
      entityType: "CommunicationLog",
      entityId: communication.id,
      metadata: {
        status,
        provider: input.provider,
        templateKey: input.templateKey || communication.templateKey,
        optOut: Boolean(optOut)
      }
    }
  }).catch(() => undefined);

  return {
    communication: updated,
    optOut
  };
}

export async function dispatchAutomationEvent(id: string) {
  const storedEvent = await prisma.automationEvent.findUnique({ where: { id } });

  if (!storedEvent) {
    throw new Error("AUTOMATION_EVENT_NOT_FOUND");
  }

  let event = storedEvent;
  requireMerchantId(event.merchantId);

  if (["DISPATCHED", "PROCESSED", "CANCELLED"].includes(event.status)) {
    return event;
  }

  if (event.status === "PROCESSING") {
    return event;
  }

  if (event.nextAttemptAt && event.nextAttemptAt > new Date()) {
    return event;
  }

  const workflowKey = WORKFLOW_BY_EVENT[event.eventKey] || "SM_01_EVENT_ROUTER";
  const defaultChannelOrder = defaultChannelOrderForWorkflow(workflowKey);
  const [preference, workflowSetting] = await Promise.all([
    prisma.automationPreference.upsert({
      where: { merchantId: event.merchantId },
      create: { merchantId: event.merchantId },
      update: {}
    }),
    prisma.automationWorkflowSetting.upsert({
      where: {
        merchantId_key: {
          merchantId: event.merchantId,
          key: workflowKey
        }
      },
      create: {
        merchantId: event.merchantId,
        key: workflowKey,
        channelOrder: defaultChannelOrder
      },
      update: {}
    })
  ]);

  let channel = isMerchantDailyDigestAutomation(workflowKey)
    ? "EMAIL"
    : workflowSetting.channelOrder[0] || defaultChannelOrder[0] || "WHATSAPP";
  const marketingAutomation = isMarketingAutomation(event.eventKey, workflowKey);
  const abandonedCheckoutAutomation = isAbandonedCheckoutAutomation(workflowKey);
  const repeatBuyerAutomation = isRepeatBuyerAutomation(workflowKey);
  const codRemittanceAutomation = isCodRemittanceAutomation(workflowKey);
  const sellerSettlementAutomation = isSellerSettlementAutomation(workflowKey);
  const invoiceMismatchAutomation = isInvoiceMismatchAutomation(workflowKey);
  const courierPickupDelayAutomation = isCourierPickupDelayAutomation(workflowKey);
  const courierSlaBreachAutomation = isCourierSlaBreachAutomation(workflowKey);
  const fakeScanReviewAutomation = isFakeScanReviewAutomation(workflowKey);
  const courierDailyDigestAutomation = isCourierDailyDigestAutomation(workflowKey);
  const workflowScope = getWorkflowScope(workflowKey);
  let dispatchUrl: string | undefined;

  const cancelEvent = async (reason: string, extra: JsonMap = {}) => {
    const cancelledEvent = await prisma.automationEvent.update({
      where: { id },
      data: {
        status: "CANCELLED",
        dispatchResult: toJson({
          workflowKey,
          actorType: workflowScope.actorType,
          permissionScope: workflowScope.permissionScope,
          reason,
          ...extra
        })
      }
    });

    await prisma.auditLog.create({
      data: {
        merchantId: event.merchantId,
        action: "automation.dispatch_cancelled",
        entityType: "AutomationEvent",
        entityId: id,
        metadata: {
          eventKey: event.eventKey,
          workflowKey,
          actorType: workflowScope.actorType,
          permissionScope: workflowScope.permissionScope,
          reason
        }
      }
    }).catch(() => undefined);

    return cancelledEvent;
  };

  if (!preference.autopilotEnabled || workflowSetting.status === "PAUSED") {
    return cancelEvent(!preference.autopilotEnabled ? "AUTOPILOT_PAUSED" : "WORKFLOW_PAUSED");
  }

  if (isCodShieldAutomation(workflowKey) && !preference.codShieldEnabled) {
    return cancelEvent("COD_SHIELD_DISABLED", { automationType: "transactional" });
  }

  if (isNdrRescueAutomation(workflowKey) && !preference.ndrRescueEnabled) {
    return cancelEvent("NDR_RESCUE_DISABLED", { automationType: "transactional" });
  }

  if ((codRemittanceAutomation || sellerSettlementAutomation || invoiceMismatchAutomation) && !preference.financeControlEnabled) {
    return cancelEvent("FINANCE_CONTROL_DISABLED", { automationType: "transactional" });
  }

  if ((courierPickupDelayAutomation || courierSlaBreachAutomation || fakeScanReviewAutomation) && !preference.courierControlEnabled) {
    return cancelEvent("COURIER_CONTROL_DISABLED", { automationType: "transactional" });
  }

  if (isMerchantDailyDigestAutomation(workflowKey)) {
    const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? event.payload as Record<string, unknown>
      : {};
    const email = payload.email && typeof payload.email === "object" && !Array.isArray(payload.email)
      ? payload.email as Record<string, unknown>
      : {};
    const recipient = cleanOptionalString(email.to) || cleanOptionalString(payload.merchantEmail);

    if (!preference.notificationsEnabled) {
      return cancelEvent("DIGEST_NOTIFICATIONS_DISABLED", { automationType: "transactional", channel });
    }

    if (!preference.emailEnabled) {
      return cancelEvent("DIGEST_EMAIL_DISABLED", { automationType: "transactional", channel });
    }

    if (recipient) {
      const consent = await checkConsent(event.merchantId, channel, recipient);
      if (!consent.allowed) {
        return cancelEvent(consent.reason, { automationType: "transactional", channel });
      }

      if (workflowSetting.quietHoursMode === "respect") {
        const quietHours = await checkQuietHours(event.merchantId);
        if (!quietHours.allowed) {
          return prisma.automationEvent.update({
            where: { id },
            data: {
              status: "QUEUED",
              nextAttemptAt: addMinutes(new Date(), 60),
              dispatchResult: toJson({
                workflowKey,
                reason: quietHours.reason,
                automationType: "transactional",
                channel,
                quietHoursStart: quietHours.quietHoursStart,
                quietHoursEnd: quietHours.quietHoursEnd
              })
            }
          });
        }
      }

      const frequency = await checkFrequencyCap(event.merchantId, channel, recipient);
      if (!frequency.allowed) {
        return cancelEvent(frequency.reason, {
          automationType: "transactional",
          channel,
          count: frequency.count,
          cap: frequency.cap
        });
      }
    }
  }

  if (event.attempts >= workflowSetting.retryLimit) {
    return markAutomationEventFailed(id, "AUTOMATION_RETRY_LIMIT_REACHED", 0, workflowSetting.retryLimit);
  }

  if (abandonedCheckoutAutomation) {
    const channelCredentials = await prisma.merchantChannelCredential.findMany({
      where: { merchantId: event.merchantId, status: { in: ["ACTIVE", "VERIFIED"] } },
      orderBy: { channel: "asc" }
    });
    const plan = await planAbandonedCheckoutDispatch({
      event,
      preference,
      workflowSetting,
      channelCredentials
    });

    event = await prisma.automationEvent.update({
      where: { id },
      data: {
        payload: toJson(plan.payload),
        dispatchResult: toJson({
          workflowKey,
          actorType: workflowScope.actorType,
          permissionScope: workflowScope.permissionScope,
          automationType: "marketing",
          channelPlan: plan.payload.channelPlan
        })
      }
    });

    await logAbandonedCheckoutSkips({
      event,
      workflowKey,
      skippedChannelReasons: plan.skippedChannelReasons
    });

    if (!plan.allowedChannels.length) {
      const reasons = plan.skippedChannelReasons.map((skip) => skip.reason);
      const reason = reasons.every((item) => item === "MARKETING_DISABLED")
        ? "MARKETING_DISABLED"
        : reasons.every((item) => item === "ABANDONED_CHECKOUT_DISABLED")
          ? "ABANDONED_CHECKOUT_DISABLED"
          : "NO_ABANDONED_CHECKOUT_CHANNELS_ALLOWED";
      return cancelEvent(reason, {
        automationType: "marketing",
        channelPlan: plan.payload.channelPlan,
        skippedChannelReasons: plan.skippedChannelReasons
      });
    }

    if (workflowSetting.quietHoursMode === "respect") {
      const quietHours = await checkQuietHours(event.merchantId);
      if (!quietHours.allowed) {
        return prisma.automationEvent.update({
          where: { id },
          data: {
            status: "QUEUED",
            nextAttemptAt: addMinutes(new Date(), 60),
            dispatchResult: toJson({
              workflowKey,
              reason: quietHours.reason,
              automationType: "marketing",
              channel: plan.primaryChannel,
              channelPlan: plan.payload.channelPlan,
              quietHoursStart: quietHours.quietHoursStart,
              quietHoursEnd: quietHours.quietHoursEnd
            })
          }
        });
      }
    }

    channel = plan.primaryChannel;
  }

  if (repeatBuyerAutomation) {
    const channelCredentials = await prisma.merchantChannelCredential.findMany({
      where: { merchantId: event.merchantId, status: { in: ["ACTIVE", "VERIFIED"] } },
      orderBy: { channel: "asc" }
    });
    const plan = await planRepeatBuyerDispatch({
      event,
      preference,
      workflowSetting,
      channelCredentials
    });

    event = await prisma.automationEvent.update({
      where: { id },
      data: {
        payload: toJson(plan.payload),
        dispatchResult: toJson({
          workflowKey,
          actorType: workflowScope.actorType,
          permissionScope: workflowScope.permissionScope,
          automationType: "marketing",
          channelPlan: plan.payload.channelPlan
        })
      }
    });

    await logRepeatBuyerSkips({
      event,
      workflowKey,
      skippedChannelReasons: plan.skippedChannelReasons
    });

    if (!plan.allowedChannels.length) {
      const reasons = plan.skippedChannelReasons.map((skip) => skip.reason);
      const reason = reasons.every((item) => item === "MARKETING_DISABLED")
        ? "MARKETING_DISABLED"
        : reasons.every((item) => item === "REPEAT_BUYER_DISABLED")
          ? "REPEAT_BUYER_DISABLED"
          : reasons.every((item) => item === "REPEAT_BUYER_WINDOW_NOT_REACHED")
            ? "REPEAT_BUYER_WINDOW_NOT_REACHED"
            : "NO_REPEAT_BUYER_CHANNELS_ALLOWED";
      return cancelEvent(reason, {
        automationType: "marketing",
        channelPlan: plan.payload.channelPlan,
        skippedChannelReasons: plan.skippedChannelReasons
      });
    }

    if (workflowSetting.quietHoursMode === "respect") {
      const quietHours = await checkQuietHours(event.merchantId);
      if (!quietHours.allowed) {
        return prisma.automationEvent.update({
          where: { id },
          data: {
            status: "QUEUED",
            nextAttemptAt: addMinutes(new Date(), 60),
            dispatchResult: toJson({
              workflowKey,
              reason: quietHours.reason,
              automationType: "marketing",
              channel: plan.primaryChannel,
              channelPlan: plan.payload.channelPlan,
              quietHoursStart: quietHours.quietHoursStart,
              quietHoursEnd: quietHours.quietHoursEnd
            })
          }
        });
      }
    }

    const buyerId = cleanOptionalString(asRecord(plan.payload).buyerId);
    if (buyerId) {
      await Promise.all(plan.allowedChannels.map((allowedChannel) =>
        reserveRepeatBuyerMonthlyFrequency({
          merchantId: event.merchantId,
          channel: allowedChannel,
          buyerId
        }).catch(() => undefined)
      ));
    }

    channel = plan.primaryChannel;
  }

  if (codRemittanceAutomation) {
    const channelCredentials = await prisma.merchantChannelCredential.findMany({
      where: { merchantId: event.merchantId, status: { in: ["ACTIVE", "VERIFIED"] } },
      orderBy: { channel: "asc" }
    });
    const plan = await planCodRemittanceDispatch({
      event,
      preference,
      workflowSetting,
      channelCredentials
    });

    event = await prisma.automationEvent.update({
      where: { id },
      data: {
        payload: toJson(plan.payload),
        dispatchResult: toJson({
          workflowKey,
          actorType: workflowScope.actorType,
          permissionScope: workflowScope.permissionScope,
          automationType: "transactional",
          channelPlan: plan.payload.channelPlan
        })
      }
    });

    await logCodRemittanceSkips({
      event,
      workflowKey,
      skippedChannelReasons: plan.skippedChannelReasons
    });

    if (!plan.allowedChannels.length) {
      const reasons = plan.skippedChannelReasons.map((skip) => skip.reason);
      const reason = reasons.every((item) => item === "FINANCE_ALERTS_DISABLED")
        ? "FINANCE_ALERTS_DISABLED"
        : reasons.every((item) => item === "FINANCE_CONTROL_DISABLED")
          ? "FINANCE_CONTROL_DISABLED"
          : "NO_COD_REMITTANCE_CHANNELS_ALLOWED";
      return cancelEvent(reason, {
        automationType: "transactional",
        channelPlan: plan.payload.channelPlan,
        skippedChannelReasons: plan.skippedChannelReasons
      });
    }

    if (workflowSetting.quietHoursMode === "respect") {
      const quietHours = await checkQuietHours(event.merchantId);
      if (!quietHours.allowed) {
        return prisma.automationEvent.update({
          where: { id },
          data: {
            status: "QUEUED",
            nextAttemptAt: addMinutes(new Date(), 60),
            dispatchResult: toJson({
              workflowKey,
              reason: quietHours.reason,
              automationType: "transactional",
              channel: plan.primaryChannel,
              channelPlan: plan.payload.channelPlan,
              quietHoursStart: quietHours.quietHoursStart,
              quietHoursEnd: quietHours.quietHoursEnd
            })
          }
        });
      }
    }

    channel = plan.primaryChannel;
  }

  if (sellerSettlementAutomation) {
    const channelCredentials = await prisma.merchantChannelCredential.findMany({
      where: { merchantId: event.merchantId, status: { in: ["ACTIVE", "VERIFIED"] } },
      orderBy: { channel: "asc" }
    });
    const plan = await planSellerSettlementDispatch({
      event,
      preference,
      workflowSetting,
      channelCredentials
    });

    event = await prisma.automationEvent.update({
      where: { id },
      data: {
        payload: toJson(plan.payload),
        dispatchResult: toJson({
          workflowKey,
          actorType: workflowScope.actorType,
          permissionScope: workflowScope.permissionScope,
          automationType: "transactional",
          channelPlan: plan.payload.channelPlan
        })
      }
    });

    await logSellerSettlementSkips({
      event,
      workflowKey,
      skippedChannelReasons: plan.skippedChannelReasons
    });

    if (!plan.allowedChannels.length) {
      const reasons = plan.skippedChannelReasons.map((skip) => skip.reason);
      const reason = reasons.every((item) => item === "SETTLEMENT_ALERTS_DISABLED")
        ? "SETTLEMENT_ALERTS_DISABLED"
        : reasons.every((item) => item === "FINANCE_CONTROL_DISABLED")
          ? "FINANCE_CONTROL_DISABLED"
          : "NO_SELLER_SETTLEMENT_CHANNELS_ALLOWED";
      return cancelEvent(reason, {
        automationType: "transactional",
        channelPlan: plan.payload.channelPlan,
        skippedChannelReasons: plan.skippedChannelReasons
      });
    }

    if (workflowSetting.quietHoursMode === "respect") {
      const quietHours = await checkQuietHours(event.merchantId);
      if (!quietHours.allowed) {
        return prisma.automationEvent.update({
          where: { id },
          data: {
            status: "QUEUED",
            nextAttemptAt: addMinutes(new Date(), 60),
            dispatchResult: toJson({
              workflowKey,
              reason: quietHours.reason,
              automationType: "transactional",
              channel: plan.primaryChannel,
              channelPlan: plan.payload.channelPlan,
              quietHoursStart: quietHours.quietHoursStart,
              quietHoursEnd: quietHours.quietHoursEnd
            })
          }
        });
      }
    }

    channel = plan.primaryChannel;
  }

  if (invoiceMismatchAutomation) {
    const channelCredentials = await prisma.merchantChannelCredential.findMany({
      where: { merchantId: event.merchantId, status: { in: ["ACTIVE", "VERIFIED"] } },
      orderBy: { channel: "asc" }
    });
    const plan = await planInvoiceMismatchDispatch({
      event,
      preference,
      workflowSetting,
      channelCredentials
    });

    event = await prisma.automationEvent.update({
      where: { id },
      data: {
        payload: toJson(plan.payload),
        dispatchResult: toJson({
          workflowKey,
          actorType: workflowScope.actorType,
          permissionScope: workflowScope.permissionScope,
          automationType: "transactional",
          channelPlan: plan.payload.channelPlan
        })
      }
    });

    await logInvoiceMismatchSkips({
      event,
      workflowKey,
      skippedChannelReasons: plan.skippedChannelReasons
    });

    if (!plan.allowedChannels.length) {
      const reasons = plan.skippedChannelReasons.map((skip) => skip.reason);
      const reason = reasons.every((item) => item === "INVOICE_MISMATCH_ALERTS_DISABLED")
        ? "INVOICE_MISMATCH_ALERTS_DISABLED"
        : reasons.every((item) => item === "FINANCE_CONTROL_DISABLED")
          ? "FINANCE_CONTROL_DISABLED"
          : "NO_INVOICE_MISMATCH_CHANNELS_ALLOWED";
      return cancelEvent(reason, {
        automationType: "transactional",
        channelPlan: plan.payload.channelPlan,
        skippedChannelReasons: plan.skippedChannelReasons
      });
    }

    if (workflowSetting.quietHoursMode === "respect") {
      const quietHours = await checkQuietHours(event.merchantId);
      if (!quietHours.allowed) {
        return prisma.automationEvent.update({
          where: { id },
          data: {
            status: "QUEUED",
            nextAttemptAt: addMinutes(new Date(), 60),
            dispatchResult: toJson({
              workflowKey,
              reason: quietHours.reason,
              automationType: "transactional",
              channel: plan.primaryChannel,
              channelPlan: plan.payload.channelPlan,
              quietHoursStart: quietHours.quietHoursStart,
              quietHoursEnd: quietHours.quietHoursEnd
            })
          }
        });
      }
    }

    channel = plan.primaryChannel;
  }

  if (courierPickupDelayAutomation) {
    const channelCredentials = await prisma.merchantChannelCredential.findMany({
      where: { merchantId: event.merchantId, status: { in: ["ACTIVE", "VERIFIED"] } },
      orderBy: { channel: "asc" }
    });
    const plan = await planCourierPickupDelayDispatch({
      event,
      preference,
      workflowSetting,
      channelCredentials
    });

    event = await prisma.automationEvent.update({
      where: { id },
      data: {
        payload: toJson(plan.payload),
        dispatchResult: toJson({
          workflowKey,
          actorType: workflowScope.actorType,
          permissionScope: workflowScope.permissionScope,
          automationType: "transactional",
          channelPlan: plan.payload.channelPlan
        })
      }
    });

    await logCourierPickupDelaySkips({
      event,
      workflowKey,
      skippedChannelReasons: plan.skippedChannelReasons
    });

    if (!plan.allowedChannels.length) {
      const reasons = plan.skippedChannelReasons.map((skip) => skip.reason);
      const reason = reasons.every((item) => item === "COURIER_PICKUP_ALERTS_DISABLED")
        ? "COURIER_PICKUP_ALERTS_DISABLED"
        : reasons.every((item) => item === "COURIER_CONTROL_DISABLED")
          ? "COURIER_CONTROL_DISABLED"
          : "NO_COURIER_PICKUP_CHANNELS_ALLOWED";
      return cancelEvent(reason, {
        automationType: "transactional",
        channelPlan: plan.payload.channelPlan,
        skippedChannelReasons: plan.skippedChannelReasons
      });
    }

    if (workflowSetting.quietHoursMode === "respect") {
      const severity = cleanOptionalString(asRecord(plan.payload).severity);
      const criticalOpsAlert = ["HIGH", "CRITICAL"].includes(severity || "") &&
        asRecord(asRecord(plan.payload).channelPlan).opsEscalationEnabled === true;
      const quietHours = await checkQuietHours(event.merchantId);
      if (!quietHours.allowed && !criticalOpsAlert) {
        return prisma.automationEvent.update({
          where: { id },
          data: {
            status: "QUEUED",
            nextAttemptAt: addMinutes(new Date(), 60),
            dispatchResult: toJson({
              workflowKey,
              reason: quietHours.reason,
              automationType: "transactional",
              channel: plan.primaryChannel,
              channelPlan: plan.payload.channelPlan,
              quietHoursStart: quietHours.quietHoursStart,
              quietHoursEnd: quietHours.quietHoursEnd
            })
          }
        });
      }
    }

    channel = plan.primaryChannel;
  }

  if (courierSlaBreachAutomation) {
    const channelCredentials = await prisma.merchantChannelCredential.findMany({
      where: { merchantId: event.merchantId, status: { in: ["ACTIVE", "VERIFIED"] } },
      orderBy: { channel: "asc" }
    });
    const plan = await planCourierSlaBreachDispatch({
      event,
      preference,
      workflowSetting,
      channelCredentials
    });

    event = await prisma.automationEvent.update({
      where: { id },
      data: {
        payload: toJson(plan.payload),
        dispatchResult: toJson({
          workflowKey,
          actorType: workflowScope.actorType,
          permissionScope: workflowScope.permissionScope,
          automationType: "transactional",
          channelPlan: plan.payload.channelPlan
        })
      }
    });

    await logCourierSlaBreachSkips({
      event,
      workflowKey,
      skippedChannelReasons: plan.skippedChannelReasons
    });

    if (!plan.allowedChannels.length) {
      const reasons = plan.skippedChannelReasons.map((skip) => skip.reason);
      const reason = reasons.every((item) => item === "COURIER_SLA_ALERTS_DISABLED")
        ? "COURIER_SLA_ALERTS_DISABLED"
        : reasons.every((item) => item === "COURIER_CONTROL_DISABLED")
          ? "COURIER_CONTROL_DISABLED"
          : "NO_COURIER_SLA_CHANNELS_ALLOWED";
      return cancelEvent(reason, {
        automationType: "transactional",
        channelPlan: plan.payload.channelPlan,
        skippedChannelReasons: plan.skippedChannelReasons
      });
    }

    if (workflowSetting.quietHoursMode === "respect") {
      const severity = cleanOptionalString(asRecord(plan.payload).severity);
      const plannedChannelPlan = asRecord(asRecord(plan.payload).channelPlan);
      const criticalInternalAlert = ["HIGH", "CRITICAL"].includes(severity || "") &&
        (plannedChannelPlan.opsEscalationEnabled === true || plannedChannelPlan.financeEscalationEnabled === true);
      const quietHours = await checkQuietHours(event.merchantId);
      if (!quietHours.allowed && !criticalInternalAlert) {
        return prisma.automationEvent.update({
          where: { id },
          data: {
            status: "QUEUED",
            nextAttemptAt: addMinutes(new Date(), 60),
            dispatchResult: toJson({
              workflowKey,
              reason: quietHours.reason,
              automationType: "transactional",
              channel: plan.primaryChannel,
              channelPlan: plan.payload.channelPlan,
              quietHoursStart: quietHours.quietHoursStart,
              quietHoursEnd: quietHours.quietHoursEnd
            })
          }
        });
      }
    }

    channel = plan.primaryChannel;
  }

  if (fakeScanReviewAutomation) {
    const channelCredentials = await prisma.merchantChannelCredential.findMany({
      where: { merchantId: event.merchantId, status: { in: ["ACTIVE", "VERIFIED"] } },
      orderBy: { channel: "asc" }
    });
    const plan = await planFakeScanReviewDispatch({
      event,
      preference,
      workflowSetting,
      channelCredentials
    });

    event = await prisma.automationEvent.update({
      where: { id },
      data: {
        payload: toJson(plan.payload),
        dispatchResult: toJson({
          workflowKey,
          actorType: workflowScope.actorType,
          permissionScope: workflowScope.permissionScope,
          automationType: "transactional",
          channelPlan: plan.payload.channelPlan
        })
      }
    });

    await logFakeScanReviewSkips({
      event,
      workflowKey,
      skippedChannelReasons: plan.skippedChannelReasons
    });

    if (!plan.allowedChannels.length) {
      const reasons = plan.skippedChannelReasons.map((skip) => skip.reason);
      const reason = reasons.every((item) => item === "FAKE_SCAN_REVIEW_DISABLED")
        ? "FAKE_SCAN_REVIEW_DISABLED"
        : reasons.every((item) => item === "COURIER_CONTROL_DISABLED")
          ? "COURIER_CONTROL_DISABLED"
          : "NO_FAKE_SCAN_CHANNELS_ALLOWED";
      return cancelEvent(reason, {
        automationType: "transactional",
        channelPlan: plan.payload.channelPlan,
        skippedChannelReasons: plan.skippedChannelReasons
      });
    }

    if (workflowSetting.quietHoursMode === "respect") {
      const severity = cleanOptionalString(asRecord(plan.payload).severity);
      const plannedChannelPlan = asRecord(asRecord(plan.payload).channelPlan);
      const criticalInternalAlert = ["HIGH", "CRITICAL"].includes(severity || "") &&
        plannedChannelPlan.opsEscalationEnabled === true;
      const quietHours = await checkQuietHours(event.merchantId);
      if (!quietHours.allowed && !criticalInternalAlert) {
        return prisma.automationEvent.update({
          where: { id },
          data: {
            status: "QUEUED",
            nextAttemptAt: addMinutes(new Date(), 60),
            dispatchResult: toJson({
              workflowKey,
              reason: quietHours.reason,
              automationType: "transactional",
              channel: plan.primaryChannel,
              channelPlan: plan.payload.channelPlan,
              quietHoursStart: quietHours.quietHoursStart,
              quietHoursEnd: quietHours.quietHoursEnd
            })
          }
        });
      }
    }

    channel = plan.primaryChannel;
  }

  if (courierDailyDigestAutomation) {
    const channelCredentials = await prisma.merchantChannelCredential.findMany({
      where: { merchantId: event.merchantId, status: { in: ["ACTIVE", "VERIFIED"] } },
      orderBy: { channel: "asc" }
    });
    const plan = await planCourierDailyDigestDispatch({
      event,
      preference,
      workflowSetting,
      channelCredentials
    });

    event = await prisma.automationEvent.update({
      where: { id },
      data: {
        payload: toJson(plan.payload),
        dispatchResult: toJson({
          workflowKey,
          actorType: workflowScope.actorType,
          permissionScope: workflowScope.permissionScope,
          automationType: "transactional",
          channelPlan: plan.payload.channelPlan
        })
      }
    });

    await logCourierDailyDigestSkips({
      event,
      workflowKey,
      skippedChannelReasons: plan.skippedChannelReasons
    });

    if (!plan.allowedChannels.length) {
      const reasons = plan.skippedChannelReasons.map((skip) => skip.reason);
      const reason = reasons.every((item) => item === "COURIER_DAILY_DIGEST_DISABLED")
        ? "COURIER_DAILY_DIGEST_DISABLED"
        : reasons.every((item) => item === "COURIER_CONTROL_DISABLED")
          ? "COURIER_CONTROL_DISABLED"
          : reasons.every((item) => item === "COURIER_PARTNER_DAILY_DIGEST_DISABLED")
            ? "COURIER_PARTNER_DAILY_DIGEST_DISABLED"
            : "NO_COURIER_DAILY_DIGEST_CHANNELS_ALLOWED";
      return cancelEvent(reason, {
        automationType: "transactional",
        channelPlan: plan.payload.channelPlan,
        skippedChannelReasons: plan.skippedChannelReasons
      });
    }

    if (workflowSetting.quietHoursMode === "respect") {
      const plannedChannelPlan = asRecord(asRecord(plan.payload).channelPlan);
      const scope = cleanOptionalString(asRecord(plan.payload).scope);
      const internalOpsDigest = scope === "OPS" && plannedChannelPlan.internalAlertEnabled === true;
      const quietHours = await checkQuietHours(event.merchantId);
      if (!quietHours.allowed && !internalOpsDigest) {
        return prisma.automationEvent.update({
          where: { id },
          data: {
            status: "QUEUED",
            nextAttemptAt: addMinutes(new Date(), 60),
            dispatchResult: toJson({
              workflowKey,
              reason: quietHours.reason,
              automationType: "transactional",
              channel: plan.primaryChannel,
              channelPlan: plan.payload.channelPlan,
              quietHoursStart: quietHours.quietHoursStart,
              quietHoursEnd: quietHours.quietHoursEnd
            })
          }
        });
      }
    }

    channel = plan.primaryChannel;
  }

  if (!abandonedCheckoutAutomation && !repeatBuyerAutomation && !codRemittanceAutomation && !sellerSettlementAutomation && !invoiceMismatchAutomation && !courierPickupDelayAutomation && !courierSlaBreachAutomation && !fakeScanReviewAutomation && !courierDailyDigestAutomation && whatsappWorkflowTemplateKey(workflowKey)) {
    const plan = await planTransactionalWhatsappDispatch({
      event,
      workflowKey
    });

    if (plan) {
      event = await prisma.automationEvent.update({
        where: { id },
        data: {
          payload: toJson(plan.payload),
          dispatchResult: toJson({
            workflowKey,
            actorType: workflowScope.actorType,
            permissionScope: workflowScope.permissionScope,
            automationType: "transactional",
            channelPlan: plan.payload.channelPlan
          })
        }
      });

      await logTransactionalWhatsappSkips({
        event,
        workflowKey,
        templateKey: plan.templateKey,
        recipient: plan.recipient,
        skippedChannelReasons: plan.skippedChannelReasons
      });

      if (!plan.allowed) {
        return cancelEvent("NO_WHATSAPP_CHANNEL_ALLOWED", {
          automationType: "transactional",
          channelPlan: plan.payload.channelPlan,
          skippedChannelReasons: plan.skippedChannelReasons
        });
      }

      channel = "WHATSAPP";
    }
  }

  if (marketingAutomation && !isControlledGrowthAutomation(workflowKey)) {
    if (!preference.marketingEnabled) {
      return cancelEvent("MARKETING_DISABLED", { automationType: "marketing" });
    }

    const subject = getMarketingSubject(event);
    if (subject) {
      const consent = await checkConsent(event.merchantId, channel, subject);
      if (!consent.allowed) {
        return cancelEvent(consent.reason, { automationType: "marketing", channel });
      }

      if (workflowSetting.quietHoursMode === "respect") {
        const quietHours = await checkQuietHours(event.merchantId);
        if (!quietHours.allowed) {
          return prisma.automationEvent.update({
            where: { id },
            data: {
              status: "QUEUED",
              nextAttemptAt: addMinutes(new Date(), 60),
              dispatchResult: toJson({
                workflowKey,
                reason: quietHours.reason,
                automationType: "marketing",
                channel,
                quietHoursStart: quietHours.quietHoursStart,
                quietHoursEnd: quietHours.quietHoursEnd
              })
            }
          });
        }
      }

      const frequency = await checkFrequencyCap(event.merchantId, channel, subject);
      if (!frequency.allowed) {
        return cancelEvent(frequency.reason, {
          automationType: "marketing",
          channel,
          count: frequency.count,
          cap: frequency.cap
        });
      }
    }
  }

  try {
    dispatchUrl = workflowDispatchUrl(workflowKey);
  } catch (error) {
    const dispatchResult = {
      workflowKey,
      actorType: workflowScope.actorType,
      permissionScope: workflowScope.permissionScope,
      mode: "n8n_workflow_url_config_invalid",
      error: error instanceof Error ? error.message : "N8N_AUTOPILOT_WORKFLOW_URLS_INVALID"
    };

    await prisma.auditLog.create({
      data: {
        merchantId: event.merchantId,
        action: "automation.dispatch_config_failed",
        entityType: "AutomationEvent",
        entityId: id,
        metadata: dispatchResult
      }
    }).catch(() => undefined);

    return prisma.automationEvent.update({
      where: { id },
      data: {
        status: "FAILED",
        error: dispatchResult.error,
        nextAttemptAt: addMinutes(new Date(), 15),
        dispatchResult: toJson(dispatchResult)
      }
    });
  }

  if (!dispatchUrl) {
    const dispatchResult = {
      workflowKey,
      actorType: workflowScope.actorType,
      permissionScope: workflowScope.permissionScope,
      mode: env.N8N_AUTOPILOT_ENABLED ? "n8n_missing_url" : "n8n_disabled",
      note: env.N8N_AUTOPILOT_ENABLED
        ? "N8N_AUTOPILOT_DISPATCH_URL must be configured before automation dispatch."
        : "N8N Autopilot dispatch is disabled; event remains queued for durable retry."
    };

    await prisma.auditLog.create({
      data: {
        merchantId: event.merchantId,
        action: env.N8N_AUTOPILOT_ENABLED ? "automation.dispatch_config_failed" : "automation.dispatch_skipped",
        entityType: "AutomationEvent",
        entityId: id,
        metadata: dispatchResult
      }
    }).catch(() => undefined);

    return prisma.automationEvent.update({
      where: { id },
      data: {
        status: env.N8N_AUTOPILOT_ENABLED ? "FAILED" : "QUEUED",
        error: env.N8N_AUTOPILOT_ENABLED ? "N8N_AUTOPILOT_DISPATCH_URL_NOT_CONFIGURED" : null,
        nextAttemptAt: env.N8N_AUTOPILOT_ENABLED ? addMinutes(new Date(), 15) : null,
        dispatchResult: toJson(dispatchResult)
      }
    });
  }

  const context = await getMerchantAutomationContext(event.merchantId);
  const dispatchContext = sanitizeAutomationDispatchContext(context);
  const updatedEvent = await prisma.automationEvent.update({
    where: { id },
    data: {
      status: "PROCESSING",
      attempts: { increment: 1 },
      contextSnapshot: toJson(context)
    }
  });

  try {
    const eventForDispatch = {
      ...updatedEvent,
      contextSnapshot: dispatchContext
    };
    const body = JSON.stringify({
      event: eventForDispatch,
      merchantId: eventForDispatch.merchantId,
      eventKey: eventForDispatch.eventKey,
      idempotencyKey: eventForDispatch.idempotencyKey,
      workflowKey,
      actorType: workflowScope.actorType,
      permissionScope: workflowScope.permissionScope,
      workflowCategory: workflowScope.category,
      merchantContext: dispatchContext,
      automationType: marketingAutomation ? "marketing" : "transactional"
    });
    const timestamp = new Date().toISOString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.N8N_AUTOPILOT_TIMEOUT_MS);

    await recordAutomationUsage({
      merchantId: event.merchantId,
      usageType: "N8N_EXECUTION",
      eventKey: event.eventKey,
      workflowKey,
      channel,
      metadata: {
        automationType: marketingAutomation ? "marketing" : "transactional"
      }
    });

    await prisma.auditLog.create({
      data: {
        merchantId: event.merchantId,
        action: "automation.dispatch_started",
        entityType: "AutomationEvent",
        entityId: id,
        metadata: {
          eventKey: event.eventKey,
          workflowKey,
          actorType: workflowScope.actorType,
          permissionScope: workflowScope.permissionScope
        }
      }
    }).catch(() => undefined);

    const response = await fetch(dispatchUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shipmastr-Internal-Event": "automation.dispatch",
        "X-Shipmastr-Task-Secret": env.SHIPMASTR_INTERNAL_SECRET || env.WEBHOOK_SECRET,
        "X-Shipmastr-Signature": createAutomationSignature(body, timestamp),
        "X-Shipmastr-Timestamp": timestamp
      },
      body,
      signal: controller.signal
    }).finally(() => {
      clearTimeout(timeout);
    });

    const result = (await response.json().catch(() => ({}))) as JsonMap;

    if (!response.ok) {
      throw new Error(`N8N_DISPATCH_FAILED_${response.status}`);
    }

    const latestEvent = await prisma.automationEvent.findUnique({
      where: { id },
      select: { status: true }
    });
    const shouldMarkDispatched = latestEvent?.status === "PROCESSING";

    const dispatchedEvent = await prisma.automationEvent.update({
      where: { id },
      data: {
        ...(shouldMarkDispatched ? { status: "DISPATCHED" } : {}),
        dispatchResult: toJson({
          workflowKey,
          actorType: workflowScope.actorType,
          permissionScope: workflowScope.permissionScope,
          result
        })
      }
    });

    await prisma.auditLog.create({
      data: {
        merchantId: event.merchantId,
        action: "automation.dispatched",
        entityType: "AutomationEvent",
        entityId: id,
        metadata: {
          eventKey: event.eventKey,
          workflowKey,
          actorType: workflowScope.actorType,
          permissionScope: workflowScope.permissionScope
        }
      }
    }).catch(() => undefined);

    return dispatchedEvent;
  } catch (error) {
    await prisma.auditLog.create({
      data: {
        merchantId: event.merchantId,
        action: "automation.dispatch_failed",
        entityType: "AutomationEvent",
        entityId: id,
        metadata: {
          workflowKey,
          eventKey: event.eventKey,
          actorType: workflowScope.actorType,
          permissionScope: workflowScope.permissionScope,
          error: error instanceof Error ? error.message : "Unknown automation dispatch failure"
        }
      }
    }).catch(() => undefined);

    await prisma.auditLog.create({
      data: {
        merchantId: event.merchantId,
        action: "automation.failure_alert",
        entityType: "AutomationEvent",
        entityId: id,
        metadata: {
          eventKey: event.eventKey,
          workflowKey,
          actorType: workflowScope.actorType,
          permissionScope: workflowScope.permissionScope,
          retryable: true
        }
      }
    }).catch(() => undefined);

    return markAutomationEventFailed(
      id,
      error instanceof Error ? error.message : "Unknown automation dispatch failure",
      15,
      workflowSetting.retryLimit
    );
  }
}

export async function retryAutomationEvent(id: string) {
  const event = await prisma.automationEvent.update({
    where: { id },
    data: {
      status: "QUEUED",
      error: null,
      failedAt: null,
      nextAttemptAt: null
    }
  });

  return dispatchAutomationEvent(event.id);
}

export async function calculateAutopilotMetrics(merchantId: string) {
  requireMerchantId(merchantId);

  const [
    recoveredCampaigns,
    codConfirmed,
    ndrRescued,
    abandonedRecovered,
    failedAutomations,
    codDue,
    codDelayed,
    courierAlerts
  ] = await Promise.all([
    prisma.marketingCampaign.aggregate({
      where: { merchantId },
      _sum: { recoveredRevenuePaise: true, convertedCount: true }
    }),
    prisma.automationEvent.count({
      where: { merchantId, eventKey: "order.confirmed", status: { in: ["DISPATCHED", "PROCESSED"] } }
    }),
    prisma.automationEvent.count({
      where: {
        merchantId,
        eventKey: { in: ["shipment.reattempt_requested", "shipment.delivered"] },
        status: { in: ["DISPATCHED", "PROCESSED"] }
      }
    }),
    prisma.marketingCampaign.aggregate({
      where: { merchantId, campaignType: "abandoned_checkout" },
      _sum: { convertedCount: true, recoveredRevenuePaise: true }
    }),
    prisma.automationEvent.count({ where: { merchantId, status: "FAILED" } }),
    prisma.financeAutomationAlert.aggregate({
      where: { merchantId, alertKey: "cod.remittance_due", status: { in: ["OPEN", "ACKNOWLEDGED"] } },
      _sum: { amountPaise: true }
    }),
    prisma.financeAutomationAlert.aggregate({
      where: { merchantId, alertKey: "cod.remittance_delayed", status: { in: ["OPEN", "ACKNOWLEDGED"] } },
      _sum: { amountPaise: true }
    }),
    prisma.courierOpsAlert.count({
      where: { merchantId, status: "OPEN" }
    })
  ]);

  const revenueRecoveredPaise =
    (recoveredCampaigns._sum.recoveredRevenuePaise || 0) +
    (abandonedRecovered._sum.recoveredRevenuePaise || 0);

  return {
    revenueRecoveredPaise,
    rtoCostSavedPaise: ndrRescued * 14000,
    codOrdersConfirmed: codConfirmed,
    ndrShipmentsRescued: ndrRescued,
    abandonedCartsRecovered: abandonedRecovered._sum.convertedCount || 0,
    campaignConversions: recoveredCampaigns._sum.convertedCount || 0,
    codRemittanceDuePaise: (codDue._sum.amountPaise || 0) + (codDelayed._sum.amountPaise || 0),
    failedAutomations,
    openCourierAlerts: courierAlerts
  };
}

export async function ensureDefaultAutopilotRecords(merchantId: string) {
  requireMerchantId(merchantId);

  const preference = await prisma.automationPreference.upsert({
    where: { merchantId },
    create: { merchantId },
    update: {}
  });

  await Promise.all(
    DEFAULT_WORKFLOWS.map((key) =>
      prisma.automationWorkflowSetting.upsert({
        where: {
          merchantId_key: {
            merchantId,
            key
        }
      },
        create: { merchantId, key, channelOrder: defaultChannelOrderForWorkflow(key) },
        update: {}
      })
    )
  );

  return preference;
}
