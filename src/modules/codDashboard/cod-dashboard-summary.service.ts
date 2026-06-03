export type BuyerTier = "GOLD" | "SILVER" | "BRONZE" | "IRON";

export type CodDecision =
  | "ALLOW_COD"
  | "REQUIRE_OTP"
  | "HOLD_BEFORE_SHIP"
  | "PREPAID_ONLY"
  | "MANUAL_REVIEW"
  | "BLOCK_COD";

export type CodRequiredActionType = "OTP_BEFORE_SHIPMENT" | "ADDRESS_CONFIRMATION";

export type CodRequiredActionStatus = "PENDING" | "VERIFIED" | "FAILED" | "EXPIRED" | "CANCELLED";

export type CodAutomationWorkflowName =
  | "SM_11_COD_RISK_HIGH"
  | "SM_12_ADDRESS_CONFIRMATION"
  | "SM_14_NDR_RECOVERY";

export type CodAutomationEventStatus =
  | "QUEUED"
  | "SENT"
  | "FAILED"
  | "SKIPPED"
  | "RETRY_PENDING"
  | "EXHAUSTED";

export type CodDashboardDataMode = "API_IN_MEMORY" | "DEMO_FALLBACK";

export type CodOrderStatus =
  | "CREATED"
  | "RISK_SCORED"
  | "VERIFIED"
  | "HELD"
  | "READY_TO_SHIP"
  | "SHIPPED"
  | "DELIVERED"
  | "NDR"
  | "RTO"
  | "CANCELLED";

export type CodDashboardActionRow = {
  actionId?: string;
  type: CodRequiredActionType;
  status: CodRequiredActionStatus;
  expiresAt?: string;
  operatorSummary?: string;
};

export type CodDashboardSummary = {
  dataMode: CodDashboardDataMode;
  sourceLabel: string;
  generatedAt: string;
  rows: Array<{
    orderId: string;
    buyerLabel: string;
    cityRegion?: string;
    buyerTier: BuyerTier;
    codDecision: CodDecision;
    orderValueLabel: string;
    requiredActions: CodDashboardActionRow[];
    workflowSuggestions: CodAutomationWorkflowName[];
    automationEventStatus: CodAutomationEventStatus;
    retryAvailable: boolean;
    automationEventId?: string;
    orderStatus?: CodOrderStatus;
    awbNumber?: string;
    carrier?: string;
    shipmentWeight?: {
      deadWeightKg?: number;
      volumetricWeightKg?: number;
      chargeableWeightKg?: number;
    };
    notes: string;
    dataSource: CodDashboardDataMode;
  }>;
  shippedOrderSummary: {
    totalRows: number;
    shippedRows: number;
    shippedWithAwb: number;
    shippedWithWeightMetadata: number;
  };
  tierSummary: Array<{
    tier: BuyerTier;
    label: string;
    summary: string;
    count: number;
  }>;
  actionStatusCounts: Record<CodRequiredActionStatus, number>;
  automationEventStatusCounts: Record<CodAutomationEventStatus, number>;
  automationEvents: Array<{
    eventId?: string;
    workflowName?: CodAutomationWorkflowName;
    status: CodAutomationEventStatus;
    retryAvailable: boolean;
  }>;
  api: {
    summaryEndpoint: string;
    decisionEndpoint: string;
    actionStatusEndpoint: string;
    automationEventsEndpoint: string;
    retryEndpoint: string;
  };
  notes: string[];
};

export type CodDashboardApiResponse = {
  success: true;
  data: CodDashboardSummary;
  meta: {
    mode: "demo-preview";
    timestamp: string;
  };
};

export type PersistedCodDashboardOrder = {
  id: string;
  externalOrderId?: string | null;
  city?: string | null;
  state?: string | null;
  orderValue?: unknown;
  codAmount?: unknown;
  paymentMode?: string | null;
  status?: string | null;
  weightGrams?: unknown;
  shipmentDetails?: {
    awb?: string | null;
    courierId?: string | null;
    carrier?: string | null;
    carrierName?: string | null;
    weightGrams?: unknown;
    deadWeightKg?: unknown;
    volumetricWeight?: unknown;
    volumetricWeightKg?: unknown;
    chargeableWeightKg?: unknown;
    shipmentStatus?: string | null;
  } | null;
  orderIntelligence?: {
    consigneeTier?: string | null;
    codDecision?: string | null;
    shipmentDecision?: string | null;
    courierId?: string | null;
  } | null;
};

const ACTION_STATUSES: CodRequiredActionStatus[] = ["PENDING", "VERIFIED", "FAILED", "EXPIRED", "CANCELLED"];
const EVENT_STATUSES: CodAutomationEventStatus[] = [
  "QUEUED",
  "SENT",
  "SKIPPED",
  "RETRY_PENDING",
  "EXHAUSTED",
  "FAILED"
];

const TIER_COPY: Record<BuyerTier, { label: string; summary: string }> = {
  GOLD: {
    label: "Low COD friction",
    summary: "COD can normally proceed unless order-level risk changes."
  },
  SILVER: {
    label: "Conditional COD",
    summary: "COD remains available, with OTP required for elevated risk or value."
  },
  BRONZE: {
    label: "Confirm before ship",
    summary: "OTP and address confirmation are expected before COD shipment."
  },
  IRON: {
    label: "Restrict COD",
    summary: "COD should be blocked, prepaid-only, or manually reviewed."
  }
};

export function buildCodDashboardSummary(generatedAt = new Date().toISOString()): CodDashboardSummary {
  const rows: CodDashboardSummary["rows"] = [
    {
      orderId: "COD-DEMO-1001",
      buyerLabel: "Buyer 1001",
      cityRegion: "Jaipur, Rajasthan",
      buyerTier: "GOLD",
      codDecision: "ALLOW_COD",
      orderValueLabel: "Rs 1,249",
      requiredActions: [],
      workflowSuggestions: [],
      automationEventStatus: "SKIPPED",
      retryAvailable: false,
      notes: "No COD hold required in the sample state.",
      dataSource: "DEMO_FALLBACK"
    },
    {
      orderId: "COD-DEMO-1002",
      buyerLabel: "Buyer 1002",
      cityRegion: "Lucknow, Uttar Pradesh",
      buyerTier: "SILVER",
      codDecision: "REQUIRE_OTP",
      orderValueLabel: "Rs 3,899",
      requiredActions: [{ type: "OTP_BEFORE_SHIPMENT", status: "PENDING" }],
      workflowSuggestions: ["SM_11_COD_RISK_HIGH"],
      automationEventStatus: "QUEUED",
      retryAvailable: false,
      notes: "OTP workflow is waiting before shipment release.",
      dataSource: "DEMO_FALLBACK"
    },
    {
      orderId: "COD-DEMO-1003",
      buyerLabel: "Buyer 1003",
      cityRegion: "Indore, Madhya Pradesh",
      buyerTier: "BRONZE",
      codDecision: "HOLD_BEFORE_SHIP",
      orderValueLabel: "Rs 2,199",
      requiredActions: [
        { type: "OTP_BEFORE_SHIPMENT", status: "VERIFIED" },
        { type: "ADDRESS_CONFIRMATION", status: "PENDING" }
      ],
      workflowSuggestions: ["SM_12_ADDRESS_CONFIRMATION"],
      automationEventStatus: "RETRY_PENDING",
      retryAvailable: true,
      notes: "Address confirmation automation can be retried once durable event data is wired.",
      dataSource: "DEMO_FALLBACK"
    },
    {
      orderId: "COD-DEMO-1004",
      buyerLabel: "Buyer 1004",
      cityRegion: "Surat, Gujarat",
      buyerTier: "BRONZE",
      codDecision: "HOLD_BEFORE_SHIP",
      orderValueLabel: "Rs 799",
      requiredActions: [
        { type: "OTP_BEFORE_SHIPMENT", status: "FAILED" },
        { type: "ADDRESS_CONFIRMATION", status: "EXPIRED" }
      ],
      workflowSuggestions: ["SM_11_COD_RISK_HIGH", "SM_12_ADDRESS_CONFIRMATION"],
      automationEventStatus: "FAILED",
      retryAvailable: true,
      notes: "Wrong OTP or stale address confirmation keeps the sample order held.",
      dataSource: "DEMO_FALLBACK"
    },
    {
      orderId: "COD-DEMO-1005",
      buyerLabel: "Buyer 1005",
      cityRegion: "Patna, Bihar",
      buyerTier: "IRON",
      codDecision: "PREPAID_ONLY",
      orderValueLabel: "Rs 1,599",
      requiredActions: [],
      workflowSuggestions: ["SM_14_NDR_RECOVERY"],
      automationEventStatus: "EXHAUSTED",
      retryAvailable: false,
      notes: "Repeated failure history routes this sample buyer away from COD.",
      dataSource: "DEMO_FALLBACK"
    },
    {
      orderId: "COD-DEMO-1006",
      buyerLabel: "Buyer 1006",
      cityRegion: "Kochi, Kerala",
      buyerTier: "SILVER",
      codDecision: "MANUAL_REVIEW",
      orderValueLabel: "Rs 5,499",
      requiredActions: [{ type: "OTP_BEFORE_SHIPMENT", status: "CANCELLED" }],
      workflowSuggestions: ["SM_11_COD_RISK_HIGH"],
      automationEventStatus: "SENT",
      retryAvailable: false,
      notes: "Operator review remains visible after automation is sent.",
      dataSource: "DEMO_FALLBACK"
    },
    {
      orderId: "COD-DEMO-1007",
      buyerLabel: "Buyer 1007",
      cityRegion: "Bengaluru, Karnataka",
      buyerTier: "GOLD",
      codDecision: "ALLOW_COD",
      orderValueLabel: "Rs 1,999",
      requiredActions: [],
      workflowSuggestions: [],
      automationEventStatus: "SKIPPED",
      retryAvailable: false,
      orderStatus: "SHIPPED",
      awbNumber: "AWB-DEMO-1007",
      carrier: "Demo Courier",
      shipmentWeight: {
        deadWeightKg: 0.8,
        volumetricWeightKg: 1.2,
        chargeableWeightKg: 1.2
      },
      notes: "AWB persistence is visible after shipment generation, including carrier and declared weight metadata.",
      dataSource: "DEMO_FALLBACK"
    }
  ];

  return {
    dataMode: "DEMO_FALLBACK",
    sourceLabel: "API demo fallback data",
    generatedAt,
    rows,
    shippedOrderSummary: buildShippedOrderSummary(rows),
    tierSummary: buildTierSummary(rows),
    actionStatusCounts: countActionStatuses(rows),
    automationEventStatusCounts: countEventStatuses(rows),
    automationEvents: rows.map((row) => {
      const workflowName = row.workflowSuggestions[0];

      return {
        ...(workflowName ? { workflowName } : {}),
        status: row.automationEventStatus,
        retryAvailable: row.retryAvailable
      };
    }),
    api: codDashboardApiTargets(),
    notes: [
      "Production backend reconciliation serves API demo fallback data until durable COD dashboard persistence is wired.",
      "No OTP codes, secret values, buyer phone numbers, buyer emails, or raw buyer addresses are included.",
      "Rows are synthetic and safe for dashboard visibility checks."
    ]
  };
}

export function buildCodDashboardSummaryFromOrders(
  orders: PersistedCodDashboardOrder[],
  generatedAt = new Date().toISOString()
): CodDashboardSummary {
  const rows = orders
    .filter((order) => !order.paymentMode || order.paymentMode === "COD")
    .map(mapPersistedOrderToDashboardRow);

  if (rows.length === 0) return buildCodDashboardSummary(generatedAt);

  return {
    dataMode: "API_IN_MEMORY",
    sourceLabel: "Persisted COD order data",
    generatedAt,
    rows,
    shippedOrderSummary: buildShippedOrderSummary(rows),
    tierSummary: buildTierSummary(rows),
    actionStatusCounts: countActionStatuses(rows),
    automationEventStatusCounts: countEventStatuses(rows),
    automationEvents: rows.map((row) => {
      const workflowName = row.workflowSuggestions[0];

      return {
        ...(workflowName ? { workflowName } : {}),
        status: row.automationEventStatus,
        retryAvailable: row.retryAvailable
      };
    }),
    api: codDashboardApiTargets(),
    notes: [
      "Persisted COD orders are shown only from authenticated merchant scope when durable data is available.",
      "Buyer phone numbers, buyer emails, full buyer addresses, OTP codes, secrets, and tokens are not included.",
      "Demo fallback data is returned when merchant scope or durable COD order rows are unavailable."
    ]
  };
}

export function buildCodDashboardApiResponse(generatedAt = new Date().toISOString()): CodDashboardApiResponse {
  return {
    success: true,
    data: buildCodDashboardSummary(generatedAt),
    meta: {
      mode: "demo-preview",
      timestamp: generatedAt
    }
  };
}

export function buildCodDashboardApiResponseFromOrders(
  orders: PersistedCodDashboardOrder[],
  generatedAt = new Date().toISOString()
): CodDashboardApiResponse {
  return {
    success: true,
    data: buildCodDashboardSummaryFromOrders(orders, generatedAt),
    meta: {
      mode: "demo-preview",
      timestamp: generatedAt
    }
  };
}

function mapPersistedOrderToDashboardRow(order: PersistedCodDashboardOrder): CodDashboardSummary["rows"][number] {
  const orderStatus = normalizeOrderStatus(order.status ?? order.shipmentDetails?.shipmentStatus);
  const buyerTier = normalizeBuyerTier(order.orderIntelligence?.consigneeTier);
  const codDecision = normalizeCodDecision(order.orderIntelligence?.codDecision, orderStatus);
  const requiredActions = requiredActionsFor(codDecision, orderStatus);
  const workflowSuggestions = workflowSuggestionsFor(codDecision, requiredActions);
  const automationEventStatus = automationStatusFor(codDecision, orderStatus, workflowSuggestions);
  const shipmentWeight = shipmentWeightFor(order);
  const awbNumber = cleanText(order.shipmentDetails?.awb);
  const cityRegion = cityRegionFor(order.city, order.state);
  const carrier = cleanText(order.shipmentDetails?.carrierName)
    ?? cleanText(order.shipmentDetails?.carrier)
    ?? cleanText(order.shipmentDetails?.courierId)
    ?? cleanText(order.orderIntelligence?.courierId);

  return {
    orderId: cleanText(order.externalOrderId) ?? order.id,
    buyerLabel: `Order ${cleanText(order.externalOrderId) ?? order.id}`,
    ...(cityRegion ? { cityRegion } : {}),
    buyerTier,
    codDecision,
    orderValueLabel: moneyLabel(order.codAmount ?? order.orderValue),
    requiredActions,
    workflowSuggestions,
    automationEventStatus,
    retryAvailable: automationEventStatus === "FAILED" || automationEventStatus === "RETRY_PENDING",
    ...(orderStatus ? { orderStatus } : {}),
    ...(awbNumber ? { awbNumber } : {}),
    ...(carrier ? { carrier } : {}),
    ...(shipmentWeight ? { shipmentWeight } : {}),
    notes: notesForPersistedOrder({ orderStatus, awbNumber, shipmentWeight, codDecision }),
    dataSource: "API_IN_MEMORY"
  };
}

function normalizeBuyerTier(value: string | null | undefined): BuyerTier {
  return value === "GOLD" || value === "SILVER" || value === "BRONZE" || value === "IRON" ? value : "SILVER";
}

function normalizeCodDecision(value: string | null | undefined, orderStatus?: CodOrderStatus): CodDecision {
  if (
    value === "ALLOW_COD" ||
    value === "REQUIRE_OTP" ||
    value === "HOLD_BEFORE_SHIP" ||
    value === "PREPAID_ONLY" ||
    value === "MANUAL_REVIEW" ||
    value === "BLOCK_COD"
  ) {
    return value;
  }

  if (orderStatus === "SHIPPED" || orderStatus === "DELIVERED") return "ALLOW_COD";

  return "MANUAL_REVIEW";
}

function normalizeOrderStatus(value: string | null | undefined): CodOrderStatus | undefined {
  if (
    value === "CREATED" ||
    value === "RISK_SCORED" ||
    value === "VERIFIED" ||
    value === "HELD" ||
    value === "READY_TO_SHIP" ||
    value === "SHIPPED" ||
    value === "DELIVERED" ||
    value === "NDR" ||
    value === "RTO" ||
    value === "CANCELLED"
  ) {
    return value;
  }

  return undefined;
}

function requiredActionsFor(codDecision: CodDecision, orderStatus?: CodOrderStatus): CodDashboardActionRow[] {
  if (orderStatus === "SHIPPED" || orderStatus === "DELIVERED" || orderStatus === "CANCELLED") return [];
  if (codDecision === "REQUIRE_OTP") return [{ type: "OTP_BEFORE_SHIPMENT", status: "PENDING" }];
  if (codDecision === "HOLD_BEFORE_SHIP") {
    return [
      { type: "OTP_BEFORE_SHIPMENT", status: "PENDING" },
      { type: "ADDRESS_CONFIRMATION", status: "PENDING" }
    ];
  }
  return [];
}

function workflowSuggestionsFor(
  codDecision: CodDecision,
  requiredActions: CodDashboardActionRow[]
): CodAutomationWorkflowName[] {
  const workflows = new Set<CodAutomationWorkflowName>();

  if (codDecision === "REQUIRE_OTP" || codDecision === "MANUAL_REVIEW" || codDecision === "BLOCK_COD") {
    workflows.add("SM_11_COD_RISK_HIGH");
  }

  if (requiredActions.some((action) => action.type === "ADDRESS_CONFIRMATION")) {
    workflows.add("SM_12_ADDRESS_CONFIRMATION");
  }

  if (codDecision === "PREPAID_ONLY") {
    workflows.add("SM_14_NDR_RECOVERY");
  }

  return [...workflows];
}

function automationStatusFor(
  codDecision: CodDecision,
  orderStatus: CodOrderStatus | undefined,
  workflowSuggestions: CodAutomationWorkflowName[]
): CodAutomationEventStatus {
  if (orderStatus === "SHIPPED" || orderStatus === "DELIVERED" || workflowSuggestions.length === 0) return "SKIPPED";
  if (codDecision === "MANUAL_REVIEW") return "SENT";
  return "QUEUED";
}

function shipmentWeightFor(order: PersistedCodDashboardOrder): CodDashboardSummary["rows"][number]["shipmentWeight"] {
  const shipment = order.shipmentDetails;
  const deadWeightKg = numberFrom(shipment?.deadWeightKg) ?? kgFromGrams(shipment?.weightGrams ?? order.weightGrams);
  const volumetricWeightKg = numberFrom(shipment?.volumetricWeightKg) ?? numberFrom(shipment?.volumetricWeight);
  const chargeableWeightKg = numberFrom(shipment?.chargeableWeightKg)
    ?? chargeableWeightFrom(deadWeightKg, volumetricWeightKg);

  if (deadWeightKg === undefined && volumetricWeightKg === undefined && chargeableWeightKg === undefined) return undefined;

  return {
    ...(deadWeightKg !== undefined ? { deadWeightKg } : {}),
    ...(volumetricWeightKg !== undefined ? { volumetricWeightKg } : {}),
    ...(chargeableWeightKg !== undefined ? { chargeableWeightKg } : {})
  };
}

function chargeableWeightFrom(deadWeightKg?: number, volumetricWeightKg?: number) {
  if (deadWeightKg === undefined && volumetricWeightKg === undefined) return undefined;
  return Math.max(deadWeightKg ?? 0, volumetricWeightKg ?? 0);
}

function notesForPersistedOrder(input: {
  orderStatus: CodOrderStatus | undefined;
  awbNumber: string | undefined;
  shipmentWeight: CodDashboardSummary["rows"][number]["shipmentWeight"] | undefined;
  codDecision: CodDecision;
}) {
  if (input.orderStatus === "SHIPPED" && input.awbNumber && input.shipmentWeight?.chargeableWeightKg !== undefined) {
    return "Persisted AWB and declared shipment weight metadata are visible from the order record.";
  }

  if (input.orderStatus === "SHIPPED" && input.awbNumber) {
    return "Persisted AWB is visible from the order record; declared weight metadata is not complete yet.";
  }

  if (input.codDecision === "REQUIRE_OTP") return "Persisted COD order requires OTP before shipment release.";
  if (input.codDecision === "MANUAL_REVIEW") return "Persisted COD order is waiting for operator review.";
  if (input.codDecision === "PREPAID_ONLY") return "Persisted COD order should be routed toward prepaid recovery.";

  return "Persisted COD order is visible in the dashboard summary.";
}

function cityRegionFor(city: string | null | undefined, state: string | null | undefined) {
  const parts = [cleanText(city), cleanText(state)].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function cleanText(value: string | null | undefined) {
  const clean = value?.trim();
  return clean ? clean : undefined;
}

function moneyLabel(value: unknown) {
  const amount = Math.round(numberFrom(value) ?? 0);
  return `Rs ${amount.toLocaleString("en-IN")}`;
}

function kgFromGrams(value: unknown) {
  const grams = numberFrom(value);
  return grams === undefined ? undefined : roundKg(grams / 1000);
}

function numberFrom(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return roundKg(value);
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? roundKg(parsed) : undefined;
  }
  if (value && typeof value === "object" && "toNumber" in value && typeof value.toNumber === "function") {
    const parsed = value.toNumber();
    return Number.isFinite(parsed) ? roundKg(parsed) : undefined;
  }

  return undefined;
}

function roundKg(value: number) {
  return Math.round(value * 100) / 100;
}

function buildTierSummary(rows: CodDashboardSummary["rows"]): CodDashboardSummary["tierSummary"] {
  return (Object.keys(TIER_COPY) as BuyerTier[]).map((tier) => ({
    tier,
    label: TIER_COPY[tier].label,
    summary: TIER_COPY[tier].summary,
    count: rows.filter((row) => row.buyerTier === tier).length
  }));
}

export function buildShippedOrderSummary(rows: CodDashboardSummary["rows"]): CodDashboardSummary["shippedOrderSummary"] {
  const shippedRows = rows.filter((row) => row.orderStatus === "SHIPPED");

  return {
    totalRows: rows.length,
    shippedRows: shippedRows.length,
    shippedWithAwb: shippedRows.filter((row) => Boolean(row.awbNumber)).length,
    shippedWithWeightMetadata: shippedRows.filter((row) => (
      row.shipmentWeight?.deadWeightKg !== undefined &&
      row.shipmentWeight.volumetricWeightKg !== undefined &&
      row.shipmentWeight.chargeableWeightKg !== undefined
    )).length
  };
}

function countActionStatuses(rows: CodDashboardSummary["rows"]) {
  const counts = Object.fromEntries(
    ACTION_STATUSES.map((status) => [status, 0])
  ) as Record<CodRequiredActionStatus, number>;

  for (const row of rows) {
    for (const action of row.requiredActions) {
      counts[action.status] += 1;
    }
  }

  return counts;
}

function countEventStatuses(rows: CodDashboardSummary["rows"]) {
  const counts = Object.fromEntries(
    EVENT_STATUSES.map((status) => [status, 0])
  ) as Record<CodAutomationEventStatus, number>;

  for (const row of rows) {
    counts[row.automationEventStatus] += 1;
  }

  return counts;
}

function codDashboardApiTargets(): CodDashboardSummary["api"] {
  return {
    summaryEndpoint: "GET /cod/dashboard/summary",
    decisionEndpoint: "POST /cod/decision",
    actionStatusEndpoint: "GET /cod/actions/:actionId",
    automationEventsEndpoint: "GET /cod/automation/events",
    retryEndpoint: "POST /cod/automation/events/:eventId/retry"
  };
}
