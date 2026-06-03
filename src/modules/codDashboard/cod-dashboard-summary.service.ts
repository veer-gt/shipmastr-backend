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
