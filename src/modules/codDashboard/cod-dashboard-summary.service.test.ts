import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCodDashboardApiResponse,
  buildCodDashboardSummary,
  buildCodDashboardSummaryFromOrders
} from "./cod-dashboard-summary.service.js";

describe("COD dashboard summary API demo fallback", () => {
  it("returns dashboard-compatible API demo fallback data", () => {
    const response = buildCodDashboardApiResponse("2026-05-29T12:00:00.000Z");

    assert.equal(response.success, true);
    assert.equal(response.meta.mode, "demo-preview");
    assert.equal(response.data.dataMode, "DEMO_FALLBACK");
    assert.equal(response.data.sourceLabel, "API demo fallback data");
    assert.equal(response.data.api.summaryEndpoint, "GET /cod/dashboard/summary");
    assert.ok(response.data.rows.length > 0);
  });

  it("covers COD tiers, required actions, automation statuses, and retry state", () => {
    const summary = buildCodDashboardSummary("2026-05-29T12:00:00.000Z");
    const tiers = new Set(summary.tierSummary.map((item) => item.tier));
    const actions = new Set(summary.rows.flatMap((row) => row.requiredActions.map((action) => action.type)));
    const workflows = new Set(summary.rows.flatMap((row) => row.workflowSuggestions));
    const statuses = new Set(summary.rows.map((row) => row.automationEventStatus));

    assert.deepEqual([...tiers].sort(), ["BRONZE", "GOLD", "IRON", "SILVER"]);
    assert.equal(actions.has("OTP_BEFORE_SHIPMENT"), true);
    assert.equal(actions.has("ADDRESS_CONFIRMATION"), true);
    assert.equal(workflows.has("SM_11_COD_RISK_HIGH"), true);
    assert.equal(workflows.has("SM_12_ADDRESS_CONFIRMATION"), true);
    assert.equal(workflows.has("SM_14_NDR_RECOVERY"), true);
    assert.equal(statuses.has("SENT"), true);
    assert.equal(statuses.has("SKIPPED"), true);
    assert.equal(statuses.has("RETRY_PENDING"), true);
    assert.equal(statuses.has("EXHAUSTED"), true);
    assert.equal(summary.rows.some((row) => row.retryAvailable), true);
  });

  it("surfaces AWB-generated shipped orders in the dashboard summary", () => {
    const summary = buildCodDashboardSummary("2026-05-29T12:00:00.000Z");
    const shippedDemoRow = summary.rows.find((row) => row.orderId === "COD-DEMO-1007");

    assert.equal(summary.shippedOrderSummary.totalRows, summary.rows.length);
    assert.ok(summary.shippedOrderSummary.shippedRows >= 1);
    assert.ok(summary.shippedOrderSummary.shippedWithAwb >= 1);
    assert.ok(summary.shippedOrderSummary.shippedWithWeightMetadata >= 1);
    assert.equal(shippedDemoRow?.orderStatus, "SHIPPED");
    assert.equal(shippedDemoRow?.awbNumber, "AWB-DEMO-1007");
    assert.equal(shippedDemoRow?.carrier, "Demo Courier");
    assert.equal(shippedDemoRow?.shipmentWeight?.chargeableWeightKg, 1.2);
    assert.equal(shippedDemoRow?.requiredActions.length, 0);
    assert.match(shippedDemoRow?.notes ?? "", /AWB persistence is visible/i);
  });

  it("maps persisted shipped COD orders with AWB and declared weight metadata", () => {
    const summary = buildCodDashboardSummaryFromOrders([
      {
        id: "ord_real_1007",
        externalOrderId: "COD-REAL-1007",
        city: "Bengaluru",
        state: "Karnataka",
        orderValue: 1999,
        codAmount: 1999,
        paymentMode: "COD",
        status: "SHIPPED",
        shipmentDetails: {
          awb: "AWB-REAL-1007",
          courierId: "courier_demo",
          carrierName: "Demo Courier",
          weightGrams: 800,
          volumetricWeight: "1.2",
          shipmentStatus: "SHIPPED"
        },
        orderIntelligence: {
          consigneeTier: "SILVER",
          codDecision: "ALLOW_COD",
          shipmentDecision: "SHIP",
          courierId: "courier_demo"
        }
      }
    ], "2026-05-29T12:00:00.000Z");
    const shippedRow = summary.rows.find((row) => row.orderId === "COD-REAL-1007");
    const json = JSON.stringify(summary);
    const keys = collectKeys(summary);

    assert.equal(summary.dataMode, "API_IN_MEMORY");
    assert.equal(summary.shippedOrderSummary.totalRows, summary.rows.length);
    assert.ok(summary.shippedOrderSummary.shippedRows >= 1);
    assert.ok(summary.shippedOrderSummary.shippedWithAwb >= 1);
    assert.ok(summary.shippedOrderSummary.shippedWithWeightMetadata >= 1);
    assert.equal(shippedRow?.orderStatus, "SHIPPED");
    assert.equal(shippedRow?.awbNumber, "AWB-REAL-1007");
    assert.equal(shippedRow?.carrier, "Demo Courier");
    assert.equal(shippedRow?.shipmentWeight?.deadWeightKg, 0.8);
    assert.equal(shippedRow?.shipmentWeight?.volumetricWeightKg, 1.2);
    assert.equal(shippedRow?.shipmentWeight?.chargeableWeightKg, 1.2);
    assert.equal(keys.some((key) => /otpCode|secret|token|phone|email|addressLine|pincode/i.test(key)), false);
    assert.equal(json.includes("9999999999"), false);
    assert.equal(json.includes("buyer@example.com"), false);
  });

  it("does not expose OTP codes, secret fields, or raw buyer contact PII", () => {
    const summary = buildCodDashboardSummary("2026-05-29T12:00:00.000Z");
    const keys = collectKeys(summary);
    const json = JSON.stringify(summary);

    assert.equal(keys.some((key) => /otpCode|secret|token|phone|email/i.test(key)), false);
    assert.equal(/\b\d{10,}\b/.test(json), false);
    assert.equal(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(json), false);
  });
});

function collectKeys(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(collectKeys);

  return Object.entries(value).flatMap(([key, fieldValue]) => [key, ...collectKeys(fieldValue)]);
}
