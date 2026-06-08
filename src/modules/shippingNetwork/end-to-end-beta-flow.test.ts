import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PlatformCredentialProvider, PlatformCredentialStatus, PlatformCredentialType } from "@prisma/client";
import { serializeConnectionCredentialReadiness } from "../credentialVault/credential-vault.serializer.js";
import { effectiveMaxBatch, workerEnabled } from "../workers/worker-config.js";
import { workerRunSummary } from "../workers/worker-health.service.js";
import type { ShipmastrWorkerConfig } from "../workers/worker.types.js";

function routeSources() {
  return [
    "src/modules/shippingNetwork/shipping-network.routes.ts",
    "src/modules/platformIntegrations/platform-integrations.routes.ts",
    "src/modules/merchantNotifications/merchant-notification.routes.ts",
    "src/modules/merchantOnboarding/merchant-onboarding.routes.ts",
    "src/modules/workers/workers.routes.ts"
  ].map((file) => readFileSync(file, "utf8")).join("\n");
}

describe("Phase 30 end-to-end merchant shipping beta audit", () => {
  it("keeps the controlled beta route contract wired from store activation through explicit shipping actions", () => {
    const routes = routeSources();
    for (const expected of [
      "/merchant-onboarding/state",
      "/merchant-onboarding/actions/test-connection",
      "/merchant-onboarding/actions/start-first-fetch",
      "/platform-import-jobs",
      "/platform-import-jobs/:jobId/run",
      "/platform-import-reconciliation/summary",
      "/platform-import-reconciliation/items",
      "/platform-import-reconciliation/items/:itemId/convert",
      "/platform-import-reconciliation/items/bulk-convert",
      "/merchant-notifications",
      "/workers/import-jobs/run-once",
      "/orders/:orderId/create-shipment",
      "/shipments/:shipmentId/rates",
      "/shipments/:shipmentId/ship-now",
      "/shipments/:shipmentId/tracking"
    ]) {
      assert.match(routes, new RegExp(expected.replace(/[/:]/g, (match) => (match === "/" ? "\\/" : "[:/]"))));
    }
  });

  it("keeps beta workers disabled, dry-run, and bounded by default configuration", () => {
    const config: ShipmastrWorkerConfig = {
      workersEnabled: false,
      importWorkerEnabled: false,
      webhookWorkerEnabled: false,
      notificationWorkerEnabled: false,
      retryWorkerEnabled: false,
      maxBatch: 25,
      lockSeconds: 300,
      dryRun: true
    };
    const summary = workerRunSummary("Beta audit summary", { dry_run: true, disabled: true });

    assert.equal(workerEnabled(config, "import-jobs"), false);
    assert.equal(workerEnabled(config, "webhook-staging"), false);
    assert.equal(effectiveMaxBatch(config, 500), 25);
    assert.equal(summary.external_calls_made, false);
    assert.equal(summary.platform_writes, false);
    assert.equal(summary.courier_calls, false);
    assert.equal(summary.rates_fetched, false);
    assert.equal(summary.awb_created, false);
    assert.equal(summary.labels_created, false);
    assert.equal(summary.scheduler_started, false);
  });

  it("keeps credential readiness responses free of secret material and hashes", () => {
    const readiness = serializeConnectionCredentialReadiness({
      connection_id: "connection_1",
      platform: "SHOPIFY",
      status: "READY",
      ready: true,
      message: "Credential is ready for read-only import.",
      credential: {
        credential_id: "credential_1",
        platform: PlatformCredentialProvider.SHOPIFY,
        credential_type: PlatformCredentialType.SHOPIFY_CUSTOM_APP_TOKEN,
        status: PlatformCredentialStatus.ACTIVE,
        safe_metadata: {
          shop_domain: "demo.myshopify.com",
          tokenPrefix: "shpat_secret",
          accessToken: "shpat_full_secret",
          secretFingerprint: "fingerprint-value",
          encryptedValue: "encrypted-secret"
        },
        last_used_at: null,
        expires_at: null,
        rotated_at: null,
        revoked_at: null
      },
      vault: {
        provider: "LOCAL_MOCK",
        kms_key_configured: false,
        encryption_key_configured: true,
        rotation_enabled: false,
        production_kms_ready: false,
        local_mock: true
      },
      actions: {
        can_create: false,
        can_rotate: true,
        can_revoke: true,
        can_test_readiness: true
      }
    });
    const json = JSON.stringify(readiness);

    assert.match(json, /demo.myshopify.com/);
    assert.doesNotMatch(json, /shpat_secret|shpat_full_secret|fingerprint|encryptedValue|secretRef|accessToken|Authorization|Bearer|Bigship|courier/i);
  });

  it("documents that import and conversion prepare orders before explicit shipping actions only", () => {
    const routes = routeSources();
    const platformConversionSource = readFileSync("src/modules/platformIntegrations/conversion/platform-import-conversion.service.ts", "utf8");

    assert.match(platformConversionSource, /Imported platform order prepared by Shipmastr/);
    assert.doesNotMatch(platformConversionSource, /manifestOrder|getLabel|getRates|shipNowShipment|webhook registration|setInterval|cron/i);
    assert.match(routes, /shipNowShipment/);
    assert.match(routes, /fetchShipmentRates/);
  });
});
