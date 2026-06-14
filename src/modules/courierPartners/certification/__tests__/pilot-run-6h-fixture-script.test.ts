import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const fixture = require("../../../../../scripts/seed-pilot-run-6h-fixture.cjs");

const scriptSource = () => readFileSync("scripts/seed-pilot-run-6h-fixture.cjs", "utf8");

describe("Pilot Run 6H local fixture seed script", () => {
  it("refuses production and production-looking database targets", () => {
    assert.throws(
      () => fixture.assertLocalFixtureSeedSafety({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://localhost/shipmastr_dev",
        SHIPMASTR_ALLOW_LOCAL_FIXTURE_SEED: "1"
      }),
      /NODE_ENV=production/
    );
    assert.throws(
      () => fixture.assertLocalFixtureSeedSafety({
        NODE_ENV: "development",
        DATABASE_URL: "postgres://shipmastr-core-prod",
        SHIPMASTR_ALLOW_LOCAL_FIXTURE_SEED: "1"
      }),
      /production-looking DATABASE_URL/
    );
    assert.throws(
      () => fixture.assertLocalFixtureSeedSafety({
        NODE_ENV: "development",
        DATABASE_URL: "postgres://localhost/shipmastr_dev",
        K_SERVICE: "shipmastr-api",
        SHIPMASTR_ALLOW_LOCAL_FIXTURE_SEED: "1"
      }),
      /Cloud Run/
    );
  });

  it("requires the local fixture allow flag for seed mode", () => {
    assert.throws(
      () => fixture.assertLocalFixtureSeedSafety({
        NODE_ENV: "development",
        DATABASE_URL: "postgres://localhost/shipmastr_dev"
      }),
      /SHIPMASTR_ALLOW_LOCAL_FIXTURE_SEED=1/
    );
    assert.doesNotThrow(() => fixture.assertLocalFixtureSeedSafety({
      NODE_ENV: "development",
      DATABASE_URL: "postgres://localhost/shipmastr_dev",
      SHIPMASTR_ALLOW_LOCAL_FIXTURE_SEED: "1"
    }));
    assert.doesNotThrow(() => fixture.assertLocalFixtureSeedSafety({
      NODE_ENV: "development",
      DATABASE_URL: "postgres://localhost/shipmastr_dev"
    }, { requireAllowFlag: false }));
  });

  it("builds safe live-like rate evidence without raw provider payloads", () => {
    const rates = fixture.fixtureRates();
    assert.equal(rates.length, 3);
    assert.deepEqual(rates.map((rate: { serviceName: string }) => rate.serviceName), [
      "Shipmastr Smart",
      "Shipmastr Economy",
      "Shipmastr Express"
    ]);

    const breakups = rates.map(fixture.buildRateBreakup);
    for (const breakup of breakups) {
      assert.equal(breakup.rawProviderResponseStored, false);
      assert.equal(breakup.phase6.pickupAvailable, false);
      assert.equal(breakup.phase6.deliveryAvailable, true);
      assert.equal(Boolean(breakup.phase6.providerCourierId), true);
      const json = JSON.stringify(breakup);
      assert.doesNotMatch(json, /rawProviderResponseJson|rawPayload|rawHeaders|rawResponse|Authorization|Bearer|consumer_secret|access_token|passwordHash/i);
    }
  });

  it("seeds a pre-ship fixture without AWB, label, tracking live read, or Ship Now behavior", () => {
    const metadata = fixture.shipmentMetadata();
    assert.equal(metadata.pilotRun, "6H");
    assert.equal(metadata.safeFixtureOnly, true);
    assert.equal(metadata.rawProviderPayloadStored, false);
    assert.equal(metadata.phase6.latestRateRefresh.status, "NO_ELIGIBLE_SHIPPING_RATES");
    assert.equal(metadata.phase6.latestRateRefresh.eligible_rate_count, 0);

    const source = scriptSource();
    assert.match(source, /awb_number, tracking_url/);
    assert.match(source, /NULL, NULL, \$\{toJson\(shipmentMetadata\(\)\)\}/);
    assert.doesNotMatch(source, /fetch\(|axios\.|https\.request|shipNowShipment|\/ship-now|manifestOrder|createLabel|getLabel|liveTrackingRead/i);
  });

  it("is idempotent and does not delete or overwrite live shipment artifacts", () => {
    const source = scriptSource();
    assert.match(source, /ON CONFLICT \(id\) DO UPDATE SET/);
    assert.match(source, /ON CONFLICT \(seller_id, courier_partner_id\) DO UPDATE SET/);
    assert.match(source, /CASE\s+WHEN shipments\.awb_number IS NULL AND shipments\.tracking_url IS NULL THEN EXCLUDED\.status/i);
    assert.doesNotMatch(source, /DELETE FROM|TRUNCATE|DROP TABLE/i);
    assert.doesNotMatch(source, /awb_number = EXCLUDED\.awb_number|tracking_url = EXCLUDED\.tracking_url/i);
  });

  it("exports the expected fixed Pilot Run 6H identifiers", () => {
    assert.equal(fixture.PILOT_MERCHANT_ID, "cmq6xp0qb0000m1j2x42x0gnr");
    assert.equal(fixture.PRIMARY_PICKUP_ID, "cmqamkmh60006m1qhjozb80nr");
    assert.equal(fixture.ALTERNATE_PICKUP_ID, "cmq9380sf0002m1akjbwmbkm8");
    assert.equal(fixture.SHIPMENT_ID, "cmqamlku6000am1qh7amfz3m5");
  });
});
