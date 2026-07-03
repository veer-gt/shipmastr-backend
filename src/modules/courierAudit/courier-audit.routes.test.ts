import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ZodError } from "zod";

import { courierAuditLeadRateLimit, courierAuditLeadSchema } from "./courier-audit.routes.js";

const payload = {
  brand: "Skymax",
  name: "Veer",
  email: "founder@example.com",
  whatsapp: "+919999999999",
  monthly_shipments: 1500,
  current_aggregator: "Shiprocket",
  estimated_leak: 90000,
  bump_rate: 10,
  average_overcharge: 60,
  utm_source: "courier-audit",
  landing_path: "/courier-audit/",
  referrer: "https://shipmastr.com/",
  website: ""
};

describe("courier audit route validation", () => {
  it("accepts the public courier audit lead payload", () => {
    const parsed = courierAuditLeadSchema.parse(payload);

    assert.equal(parsed.brand, "Skymax");
    assert.equal(parsed.email, "founder@example.com");
    assert.equal(parsed.monthly_shipments, 1500);
    assert.equal(parsed.estimated_leak, 90000);
  });

  it("rejects missing required brand", () => {
    assert.throws(() => {
      courierAuditLeadSchema.parse({ ...payload, brand: "" });
    }, ZodError);
  });

  it("rejects invalid monthly shipments", () => {
    assert.throws(() => {
      courierAuditLeadSchema.parse({ ...payload, monthly_shipments: "not-a-number" });
    }, ZodError);
  });

  it("keeps a route-specific public submission rate limit", () => {
    assert.equal(courierAuditLeadRateLimit.windowMs, 60 * 60 * 1000);
    assert.equal(courierAuditLeadRateLimit.limit, 12);
  });
});
