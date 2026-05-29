import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Response } from "express";
import { getCodDashboardSummaryHandler } from "./cod-dashboard.routes.js";

describe("COD dashboard summary routes", () => {
  it("returns 200-compatible JSON for the dashboard summary handler", () => {
    const res = makeResponse();

    getCodDashboardSummaryHandler({} as never, res as unknown as Response);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.dataMode, "DEMO_FALLBACK");
    assert.equal(res.body.data.api.summaryEndpoint, "GET /cod/dashboard/summary");
  });

  it("keeps the read-only handler response safe", () => {
    const res = makeResponse();

    getCodDashboardSummaryHandler({} as never, res as unknown as Response);

    const json = JSON.stringify(res.body);
    const keys = collectKeys(res.body);

    assert.equal(res.statusCode, 200);
    assert.equal(json.includes("otpCode"), false);
    assert.equal(json.includes("WEBHOOK_SECRET"), false);
    assert.equal(json.includes("SHIPMASTR_AUTOMATION_WEBHOOK_SECRET"), false);
    assert.equal(keys.some((key) => /otpCode|secret|token|phone|email/i.test(key)), false);
    assert.equal(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(json), false);
  });
});

function makeResponse() {
  return {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    }
  };
}

function collectKeys(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(collectKeys);

  return Object.entries(value).flatMap(([key, fieldValue]) => [key, ...collectKeys(fieldValue)]);
}
