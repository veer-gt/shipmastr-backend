import {
  CheckoutIntelligenceAnalyticsService,
  sanitizeCheckoutIntelligencePayload,
  type CheckoutIntelligenceAnalyticsFilters
} from "./checkout-intelligence-analytics.service.js";

export type CheckoutIntelligenceExportReportKey =
  | "overview"
  | "funnel"
  | "revenueLeakage"
  | "paymentFailures"
  | "codRisk"
  | "merchantBreakdown"
  | "abandonedCheckouts"
  | "eventLog";

type CsvRow = unknown[];

type ReportDefinition = {
  key: CheckoutIntelligenceExportReportKey;
  reportName: string;
  pathSegment: string;
  fileSegment: string;
};

export const CHECKOUT_INTELLIGENCE_EXPORT_REPORTS: Record<CheckoutIntelligenceExportReportKey, ReportDefinition> = {
  overview: {
    key: "overview",
    reportName: "Overview",
    pathSegment: "overview",
    fileSegment: "overview"
  },
  funnel: {
    key: "funnel",
    reportName: "Funnel",
    pathSegment: "funnel",
    fileSegment: "funnel"
  },
  revenueLeakage: {
    key: "revenueLeakage",
    reportName: "Revenue Leakage",
    pathSegment: "revenue-leakage",
    fileSegment: "revenue-leakage"
  },
  paymentFailures: {
    key: "paymentFailures",
    reportName: "Payment Failures",
    pathSegment: "payment-failures",
    fileSegment: "payment-failures"
  },
  codRisk: {
    key: "codRisk",
    reportName: "COD Risk",
    pathSegment: "cod-risk",
    fileSegment: "cod-risk"
  },
  merchantBreakdown: {
    key: "merchantBreakdown",
    reportName: "Merchant Breakdown",
    pathSegment: "merchant-breakdown",
    fileSegment: "merchant-breakdown"
  },
  abandonedCheckouts: {
    key: "abandonedCheckouts",
    reportName: "Abandoned Checkouts",
    pathSegment: "abandoned-checkouts",
    fileSegment: "abandoned-checkouts"
  },
  eventLog: {
    key: "eventLog",
    reportName: "Event Log",
    pathSegment: "events",
    fileSegment: "events"
  }
};

const REPORT_SEQUENCE: CheckoutIntelligenceExportReportKey[] = [
  "overview",
  "funnel",
  "revenueLeakage",
  "paymentFailures",
  "codRisk",
  "merchantBreakdown",
  "abandonedCheckouts",
  "eventLog"
];

export const CHECKOUT_INTELLIGENCE_EXPORT_REPORT_SEQUENCE = REPORT_SEQUENCE.map((key) => CHECKOUT_INTELLIGENCE_EXPORT_REPORTS[key]);

const EXPORT_PAGE_SIZE = 100;
const EXPORT_MAX_ROWS = 1_000;

const semanticNotes: Array<[string, string]> = [
  ["conversionRateMeaningful", "false"],
  ["frontendFunnel", "frontend funnel not fully instrumented"],
  ["codOtpMetrics", "COD OTP metrics are not instrumented yet"],
  ["abandonment", "C13 abandonment means stale unpaid checkout/order session"],
  ["sellerId", "sellerId is future-facing and only matches populated telemetry rows"],
  ["refundDue", "refund_due is payment leakage, not payment success"]
];

const emailLike = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;
const ipLike =
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b|(?:\b[0-9a-f]{1,4}:){2,}[0-9a-f]{0,4}\b/iu;
const addressLike =
  /\b(?:road|rd|street|lane|avenue|block|sector|floor|flat|apartment|building|landmark|pincode|postal|zipcode|zip)\b/iu;

function containsPhoneLike(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15;
}

export function redactCheckoutIntelligenceCsvText(value: string) {
  if (emailLike.test(value) || ipLike.test(value) || containsPhoneLike(value) || addressLike.test(value)) return "[redacted]";
  return value;
}

function jsonString(value: unknown) {
  return JSON.stringify(sanitizeCheckoutIntelligencePayload(value), (_key, child) =>
    typeof child === "bigint" ? child.toString() : child
  );
}

export function checkoutIntelligenceCsvCell(value: unknown) {
  let text: string;
  if (value === null || value === undefined) {
    text = "";
  } else if (value instanceof Date) {
    text = value.toISOString();
  } else if (typeof value === "bigint") {
    text = value.toString();
  } else if (typeof value === "object") {
    text = jsonString(value) ?? "";
  } else {
    text = String(value);
  }

  const sanitized = redactCheckoutIntelligenceCsvText(text);
  const escaped = sanitized.replace(/"/g, "\"\"");
  return /[",\n\r]/u.test(escaped) ? `"${escaped}"` : escaped;
}

function rowsToCsv(rows: CsvRow[]) {
  return `${rows.map((row) => row.map(checkoutIntelligenceCsvCell).join(",")).join("\n")}\n`;
}

function formatFileTimestamp(value: Date) {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  const hours = String(value.getUTCHours()).padStart(2, "0");
  const minutes = String(value.getUTCMinutes()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}`;
}

function filterRows(filters: CheckoutIntelligenceAnalyticsFilters): CsvRow[] {
  const activeFilters = Object.entries(filters)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]): CsvRow => [key, value instanceof Date ? value.toISOString() : value]);

  if (!activeFilters.length) return [["appliedFilters", "none"]];

  return [
    ["appliedFilters", "active"],
    ...activeFilters.map(([key, value]) => [`filter.${key}`, value])
  ];
}

function flattenRecordRows(value: unknown, prefix: string): CsvRow[] {
  if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
    const rows = Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => flattenRecordRows(child, `${prefix}.${key}`));
    return rows.length ? rows : [[prefix, ""]];
  }
  return [[prefix, value]];
}

function metadataRows(definition: ReportDefinition, generatedAt: Date, filters: CheckoutIntelligenceAnalyticsFilters, data: any): CsvRow[] {
  return [
    ["generatedAt", generatedAt.toISOString()],
    ["reportName", definition.reportName],
    ["reportKey", definition.key],
    ["format", "csv"],
    ...filterRows(filters),
    ...semanticNotes.map(([key, value]): CsvRow => [`note.${key}`, value]),
    ...flattenRecordRows(data?.dataAvailability ?? {}, "dataAvailability"),
    ...flattenRecordRows(data?.exportPagination ?? {}, "pagination")
  ];
}

function keyValueSection(name: string, record: Record<string, unknown> | null | undefined): CsvRow[] {
  return [
    [],
    ["section", name],
    ["key", "value"],
    ...Object.entries(record ?? {}).map(([key, value]): CsvRow => [key, value])
  ];
}

function objectSection(name: string, rows: any[] | null | undefined, headers: string[]): CsvRow[] {
  return [
    [],
    ["section", name],
    headers,
    ...(rows ?? []).map((row) => headers.map((header) => row?.[header]))
  ];
}

function groupedSection(name: string, rows: any[] | null | undefined): CsvRow[] {
  return objectSection(name, rows, ["key", "merchantId", "merchantName", "count", "amountAtRiskMinor", "currencies"]);
}

function overviewRows(data: any): CsvRow[] {
  return [
    ...keyValueSection("dateRange", data.dateRange),
    ...keyValueSection("metrics", data.metrics)
  ];
}

function funnelRows(data: any): CsvRow[] {
  return [
    ...keyValueSection("dateRange", data.dateRange),
    ...objectSection("stages", data.stages, [
      "key",
      "count",
      "instrumented",
      "conversionRateFromPrevious",
      "dropoffRateFromPrevious",
      "revenueAtRiskMinor",
      "dataAvailability"
    ])
  ];
}

function revenueLeakageRows(data: any): CsvRow[] {
  return [
    ...keyValueSection("dateRange", data.dateRange),
    ...keyValueSection("summary", {
      totalFailures: data.totalFailures,
      totalAmountAtRiskMinor: data.totalAmountAtRiskMinor
    }),
    ...groupedSection("byFailureStage", data.byFailureStage),
    ...groupedSection("byMerchant", data.byMerchant),
    ...groupedSection("byPaymentMethod", data.byPaymentMethod),
    ...groupedSection("byGateway", data.byGateway),
    ...groupedSection("byErrorCode", data.byErrorCode)
  ];
}

function paymentFailuresRows(data: any): CsvRow[] {
  return [
    ...keyValueSection("dateRange", data.dateRange),
    ...keyValueSection("summary", {
      totalAttempts: data.totalAttempts,
      failedAttempts: data.failedAttempts,
      failureRate: data.failureRate,
      totalAmountAtRiskMinor: data.totalAmountAtRiskMinor,
      refundDueFailureCode: data.refundDueFailureCode
    }),
    ...groupedSection("byPaymentMethod", data.byPaymentMethod),
    ...groupedSection("byGateway", data.byGateway),
    ...groupedSection("byErrorCode", data.byErrorCode)
  ];
}

function codRiskRows(data: any): CsvRow[] {
  return [
    ...keyValueSection("dateRange", data.dateRange),
    ...keyValueSection("metrics", data.metrics)
  ];
}

function merchantBreakdownRows(data: any): CsvRow[] {
  return [
    ...keyValueSection("dateRange", data.dateRange),
    ...objectSection("merchants", data.merchants, [
      "merchantId",
      "merchantName",
      "checkoutStartedSessions",
      "orderPlaced",
      "paymentSucceeded",
      "paymentFailed",
      "checkoutAbandoned",
      "amountAtRiskMinor",
      "checkoutConversionRate",
      "conversionRateMeaningful"
    ])
  ];
}

function abandonedCheckoutsRows(data: any): CsvRow[] {
  return [
    ...keyValueSection("dateRange", data.dateRange),
    ...keyValueSection("summary", {
      exportedRows: data.abandonedCheckouts?.length ?? 0,
      limit: data.limit,
      hasMore: data.hasMore,
      nextCursor: data.nextCursor
    }),
    ...objectSection("abandonedCheckouts", data.abandonedCheckouts, [
      "telemetrySessionId",
      "merchantId",
      "merchantName",
      "sellerId",
      "checkoutOrderId",
      "sessionId",
      "deviceType",
      "cartValueMinor",
      "currency",
      "startedAt",
      "abandonedAt",
      "failureStage",
      "failureReason",
      "failureCode",
      "amountAtRiskMinor"
    ])
  ];
}

function eventLogRows(data: any): CsvRow[] {
  return [
    ...keyValueSection("dateRange", data.dateRange),
    ...keyValueSection("summary", {
      exportedRows: data.events?.length ?? 0,
      limit: data.limit,
      hasMore: data.hasMore,
      nextCursor: data.nextCursor
    }),
    ...objectSection("events", data.events, [
      "id",
      "eventName",
      "telemetrySessionId",
      "merchantId",
      "merchantName",
      "sellerId",
      "checkoutOrderId",
      "checkoutPaymentId",
      "source",
      "occurredAt",
      "payload"
    ])
  ];
}

async function collectAbandonedCheckouts(
  analyticsService: CheckoutIntelligenceAnalyticsService,
  filters: CheckoutIntelligenceAnalyticsFilters
) {
  const rows: any[] = [];
  const maxRows = Math.min(filters.limit ?? EXPORT_MAX_ROWS, EXPORT_MAX_ROWS);
  let cursor = filters.cursor;
  let firstPage: any = null;
  let lastPage: any = null;

  while (rows.length < maxRows) {
    const page = await analyticsService.getAbandonedCheckouts({
      ...filters,
      limit: Math.min(EXPORT_PAGE_SIZE, maxRows - rows.length),
      cursor
    });
    firstPage ??= page;
    lastPage = page;
    rows.push(...(page.abandonedCheckouts ?? []));
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }

  const truncated = Boolean(lastPage?.hasMore && rows.length >= maxRows);
  return {
    ...(firstPage ?? {}),
    abandonedCheckouts: rows,
    limit: maxRows,
    hasMore: truncated,
    nextCursor: truncated ? lastPage?.nextCursor ?? null : null,
    exportPagination: {
      mode: "export_all_with_cap",
      pageSize: EXPORT_PAGE_SIZE,
      maxRows,
      exportedRows: rows.length,
      truncated,
      startingCursor: filters.cursor ?? null
    }
  };
}

async function collectEventLog(
  analyticsService: CheckoutIntelligenceAnalyticsService,
  filters: CheckoutIntelligenceAnalyticsFilters
) {
  const rows: any[] = [];
  const maxRows = Math.min(filters.limit ?? EXPORT_MAX_ROWS, EXPORT_MAX_ROWS);
  let cursor = filters.cursor;
  let firstPage: any = null;
  let lastPage: any = null;

  while (rows.length < maxRows) {
    const page = await analyticsService.getEventLog({
      ...filters,
      limit: Math.min(EXPORT_PAGE_SIZE, maxRows - rows.length),
      cursor
    });
    firstPage ??= page;
    lastPage = page;
    rows.push(...(page.events ?? []));
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }

  const truncated = Boolean(lastPage?.hasMore && rows.length >= maxRows);
  return {
    ...(firstPage ?? {}),
    events: rows,
    limit: maxRows,
    hasMore: truncated,
    nextCursor: truncated ? lastPage?.nextCursor ?? null : null,
    exportPagination: {
      mode: "export_all_with_cap",
      pageSize: EXPORT_PAGE_SIZE,
      maxRows,
      exportedRows: rows.length,
      truncated,
      startingCursor: filters.cursor ?? null
    }
  };
}

async function loadReportData(
  report: CheckoutIntelligenceExportReportKey,
  analyticsService: CheckoutIntelligenceAnalyticsService,
  filters: CheckoutIntelligenceAnalyticsFilters
) {
  if (report === "overview") return analyticsService.getOverview(filters);
  if (report === "funnel") return analyticsService.getFunnel(filters);
  if (report === "revenueLeakage") return analyticsService.getRevenueLeakage(filters);
  if (report === "paymentFailures") return analyticsService.getPaymentFailures(filters);
  if (report === "codRisk") return analyticsService.getCodRisk(filters);
  if (report === "merchantBreakdown") return analyticsService.getMerchantBreakdown(filters);
  if (report === "abandonedCheckouts") return collectAbandonedCheckouts(analyticsService, filters);
  if (report === "eventLog") return collectEventLog(analyticsService, filters);
  throw new Error("UNSUPPORTED_CHECKOUT_INTELLIGENCE_EXPORT_REPORT");
}

function dataRows(report: CheckoutIntelligenceExportReportKey, data: unknown): CsvRow[] {
  if (report === "overview") return overviewRows(data);
  if (report === "funnel") return funnelRows(data);
  if (report === "revenueLeakage") return revenueLeakageRows(data);
  if (report === "paymentFailures") return paymentFailuresRows(data);
  if (report === "codRisk") return codRiskRows(data);
  if (report === "merchantBreakdown") return merchantBreakdownRows(data);
  if (report === "abandonedCheckouts") return abandonedCheckoutsRows(data);
  if (report === "eventLog") return eventLogRows(data);
  return [];
}

export async function buildCheckoutIntelligenceCsvExport(input: {
  report: CheckoutIntelligenceExportReportKey;
  filters?: CheckoutIntelligenceAnalyticsFilters | undefined;
  analyticsService?: CheckoutIntelligenceAnalyticsService | undefined;
  generatedAt?: Date | undefined;
}) {
  const definition = CHECKOUT_INTELLIGENCE_EXPORT_REPORTS[input.report];
  if (!definition) throw new Error("UNSUPPORTED_CHECKOUT_INTELLIGENCE_EXPORT_REPORT");

  const filters = input.filters ?? {};
  const analyticsService = input.analyticsService ?? new CheckoutIntelligenceAnalyticsService();
  const generatedAt = input.generatedAt ?? new Date();
  const data = await loadReportData(input.report, analyticsService, filters);
  const rows = [
    ...metadataRows(definition, generatedAt, filters, data),
    ...dataRows(input.report, data)
  ];

  return {
    contentType: "text/csv",
    fileName: `checkout-intelligence-${definition.fileSegment}-${formatFileTimestamp(generatedAt)}.csv`,
    body: rowsToCsv(rows)
  };
}
