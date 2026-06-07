import { trackingPublicUrlForShipment } from "./shipping-public-serializers.js";

function timestamp(value: Date | string | null | undefined) {
  return value ?? null;
}

function jsonOrNull(value: unknown) {
  return value ?? null;
}

export function serializeOperationalShipment(shipment: {
  id: string;
  orderId?: string | null;
  externalOrderId?: string | null;
  awbNumber?: string | null;
  trackingToken?: string | null;
  trackingPublicUrl?: string | null;
  trackingUrl?: string | null;
}) {
  return {
    shipment_id: shipment.id,
    order_id: shipment.orderId ?? null,
    order_reference: shipment.externalOrderId ?? null,
    awb: shipment.awbNumber ?? null,
    tracking_public_url: trackingPublicUrlForShipment(shipment)
  };
}

export function serializeNdrCase(caseRow: {
  id: string;
  shipmentId: string;
  orderId?: string | null;
  status: string;
  reasonCode?: string | null;
  reasonLabel?: string | null;
  buyerIssueType?: string | null;
  latestAttemptAt?: Date | string | null;
  nextActionBy?: Date | string | null;
  sellerAction?: string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}, shipment?: Parameters<typeof serializeOperationalShipment>[0] | null) {
  return {
    case_id: caseRow.id,
    shipment_id: caseRow.shipmentId,
    order_id: caseRow.orderId ?? shipment?.orderId ?? null,
    order_reference: shipment?.externalOrderId ?? null,
    status: caseRow.status,
    reason_code: caseRow.reasonCode ?? null,
    reason_label: caseRow.reasonLabel ?? null,
    buyer_issue_type: caseRow.buyerIssueType ?? null,
    latest_attempt_at: timestamp(caseRow.latestAttemptAt),
    next_action_by: timestamp(caseRow.nextActionBy),
    seller_action: caseRow.sellerAction ?? null,
    shipment: shipment ? serializeOperationalShipment(shipment) : null,
    created_at: timestamp(caseRow.createdAt),
    updated_at: timestamp(caseRow.updatedAt)
  };
}

export function serializeNdrActionAttempt(action: {
  id: string;
  ndrCaseId: string;
  shipmentId: string;
  action: string;
  status: string;
  createdAt?: Date | string | null;
}) {
  return {
    action_id: action.id,
    case_id: action.ndrCaseId,
    shipment_id: action.shipmentId,
    action: action.action,
    status: action.status,
    created_at: timestamp(action.createdAt)
  };
}

export function serializeRtoCase(caseRow: {
  id: string;
  shipmentId: string;
  orderId?: string | null;
  status: string;
  rtoReasonCode?: string | null;
  rtoReasonLabel?: string | null;
  initiatedAt?: Date | string | null;
  receivedAt?: Date | string | null;
  closedAt?: Date | string | null;
  forwardFreightPaise?: number | null;
  rtoFreightPaise?: number | null;
  codLostPaise?: number | null;
  estimatedLossPaise?: number | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}, shipment?: Parameters<typeof serializeOperationalShipment>[0] | null) {
  return {
    case_id: caseRow.id,
    shipment_id: caseRow.shipmentId,
    order_id: caseRow.orderId ?? shipment?.orderId ?? null,
    order_reference: shipment?.externalOrderId ?? null,
    status: caseRow.status,
    reason_code: caseRow.rtoReasonCode ?? null,
    reason_label: caseRow.rtoReasonLabel ?? null,
    initiated_at: timestamp(caseRow.initiatedAt),
    received_at: timestamp(caseRow.receivedAt),
    closed_at: timestamp(caseRow.closedAt),
    loss: {
      forward_freight_paise: caseRow.forwardFreightPaise ?? null,
      rto_freight_paise: caseRow.rtoFreightPaise ?? null,
      cod_lost_paise: caseRow.codLostPaise ?? null,
      estimated_loss_paise: caseRow.estimatedLossPaise ?? null
    },
    shipment: shipment ? serializeOperationalShipment(shipment) : null,
    created_at: timestamp(caseRow.createdAt),
    updated_at: timestamp(caseRow.updatedAt)
  };
}

export function serializeCodLedgerEntry(entry: {
  id: string;
  shipmentId?: string | null;
  orderId?: string | null;
  entryType: string;
  status: string;
  amountPaise: number;
  currency: string;
  expectedCollectionAt?: Date | string | null;
  collectedAt?: Date | string | null;
  remittanceDueAt?: Date | string | null;
  remittedAt?: Date | string | null;
  reference?: string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}, shipment?: Parameters<typeof serializeOperationalShipment>[0] | null) {
  return {
    entry_id: entry.id,
    shipment_id: entry.shipmentId ?? null,
    order_id: entry.orderId ?? shipment?.orderId ?? null,
    order_reference: shipment?.externalOrderId ?? null,
    entry_type: entry.entryType,
    status: entry.status,
    amount_paise: entry.amountPaise,
    currency: entry.currency,
    expected_collection_at: timestamp(entry.expectedCollectionAt),
    collected_at: timestamp(entry.collectedAt),
    remittance_due_at: timestamp(entry.remittanceDueAt),
    remitted_at: timestamp(entry.remittedAt),
    reference: entry.reference ?? null,
    shipment: shipment ? serializeOperationalShipment(shipment) : null,
    created_at: timestamp(entry.createdAt),
    updated_at: timestamp(entry.updatedAt)
  };
}

export function serializeWeightDiscrepancyCase(caseRow: {
  id: string;
  shipmentId: string;
  orderId?: string | null;
  status: string;
  declaredWeightGrams?: number | null;
  volumetricWeightGrams?: number | null;
  billedWeightGrams?: number | null;
  differenceGrams?: number | null;
  expectedChargePaise?: number | null;
  billedChargePaise?: number | null;
  differencePaise?: number | null;
  reasonCode?: string | null;
  reasonLabel?: string | null;
  evidenceJson?: unknown;
  detectedAt?: Date | string | null;
  submittedAt?: Date | string | null;
  closedAt?: Date | string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}, shipment?: Parameters<typeof serializeOperationalShipment>[0] | null) {
  return {
    case_id: caseRow.id,
    shipment_id: caseRow.shipmentId,
    order_id: caseRow.orderId ?? shipment?.orderId ?? null,
    order_reference: shipment?.externalOrderId ?? null,
    status: caseRow.status,
    declared_weight_grams: caseRow.declaredWeightGrams ?? null,
    volumetric_weight_grams: caseRow.volumetricWeightGrams ?? null,
    billed_weight_grams: caseRow.billedWeightGrams ?? null,
    difference_grams: caseRow.differenceGrams ?? null,
    expected_charge_paise: caseRow.expectedChargePaise ?? null,
    billed_charge_paise: caseRow.billedChargePaise ?? null,
    difference_paise: caseRow.differencePaise ?? null,
    reason_code: caseRow.reasonCode ?? null,
    reason_label: caseRow.reasonLabel ?? null,
    evidence: jsonOrNull(caseRow.evidenceJson),
    shipment: shipment ? serializeOperationalShipment(shipment) : null,
    detected_at: timestamp(caseRow.detectedAt),
    submitted_at: timestamp(caseRow.submittedAt),
    closed_at: timestamp(caseRow.closedAt),
    created_at: timestamp(caseRow.createdAt),
    updated_at: timestamp(caseRow.updatedAt)
  };
}
