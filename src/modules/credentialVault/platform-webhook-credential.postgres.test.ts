import crypto from "node:crypto";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { PlatformCredentialPurpose, StorePlatform } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { createPlatformWebhookCredentialVault } from "./platform-webhook-credential.crypto.js";
import {
  configurePlatformWebhookCredential,
  resolvePlatformWebhookCredentialCandidates,
  revokePlatformWebhookCredential,
  rotatePlatformWebhookCredential
} from "./platform-webhook-credential.service.js";

const enabled = process.env.RUN_SCRATCH_DB_TESTS === "1";
const merchantA = `h2a_scratch_merchant_a_${crypto.randomBytes(4).toString("hex")}`;
const merchantB = `h2a_scratch_merchant_b_${crypto.randomBytes(4).toString("hex")}`;
let connectionId = "";
const key = crypto.randomBytes(32);
const vault = createPlatformWebhookCredentialVault({}, key);

before(async () => {
  if (!enabled) return;
  process.env.PLATFORM_CREDENTIAL_ENCRYPTION_KEY = key.toString("hex");
  const connection = await prisma.platformConnection.create({
    data: {
      merchantId: merchantA,
      platform: StorePlatform.SHOPIFY,
      storeName: "H2A scratch connection",
      storeUrl: "https://scratch.example.test",
      status: "ACTIVE"
    }
  });
  connectionId = connection.id;
});

after(async () => {
  if (!enabled || !connectionId) return;
  await prisma.platformWebhookCredential.deleteMany({ where: { connectionId: connectionId } });
  await prisma.platformConnection.delete({ where: { id: connectionId } });
  await prisma.$disconnect();
});

test("H2A scratch PostgreSQL credential isolation and rotation", { skip: !enabled }, async () => {
  const current = "scratch-current-webhook-secret";
  const replacement = "scratch-replacement-webhook-secret";
  await configurePlatformWebhookCredential(merchantA, connectionId, {
    platform: "SHOPIFY",
    secret: current
  }, prisma, vault);

  const stored = await prisma.platformWebhookCredential.findUnique({
    where: {
      connectionId_purpose: {
        connectionId,
        purpose: PlatformCredentialPurpose.PLATFORM_WEBHOOK_SIGNATURE
      }
    }
  });
  assert.ok(stored);
  assert.doesNotMatch(JSON.stringify(stored), /scratch-current-webhook-secret/);
  assert.equal((await resolvePlatformWebhookCredentialCandidates({
    merchantId: merchantA,
    connectionId,
    platform: "SHOPIFY",
    purpose: "PLATFORM_WEBHOOK_SIGNATURE"
  })).current, current);
  assert.deepEqual(await resolvePlatformWebhookCredentialCandidates({
    merchantId: merchantB,
    connectionId,
    platform: "SHOPIFY",
    purpose: "PLATFORM_WEBHOOK_SIGNATURE"
  }), { current: null, previous: null });

  await rotatePlatformWebhookCredential(merchantA, connectionId, {
    replacementSecret: replacement,
    gracePeriodSeconds: 3600
  }, prisma, vault);
  const duringGrace = await resolvePlatformWebhookCredentialCandidates({
    merchantId: merchantA,
    connectionId,
    platform: "SHOPIFY",
    purpose: "PLATFORM_WEBHOOK_SIGNATURE"
  });
  assert.deepEqual(duringGrace, { current: replacement, previous: current });

  const concurrent = await Promise.all([
    rotatePlatformWebhookCredential(merchantA, connectionId, { replacementSecret: "scratch-concurrent-a", gracePeriodSeconds: 30 }, prisma, vault),
    rotatePlatformWebhookCredential(merchantA, connectionId, { replacementSecret: "scratch-concurrent-b", gracePeriodSeconds: 30 }, prisma, vault)
  ]);
  assert.equal(concurrent.length, 2);
  const finalCandidates = await resolvePlatformWebhookCredentialCandidates({
    merchantId: merchantA,
    connectionId,
    platform: "SHOPIFY",
    purpose: "PLATFORM_WEBHOOK_SIGNATURE"
  });
  assert.ok(["scratch-concurrent-a", "scratch-concurrent-b"].includes(finalCandidates.current ?? ""));
  assert.ok(finalCandidates.previous);

  await revokePlatformWebhookCredential(merchantA, connectionId, prisma);
  const revoked = await prisma.platformWebhookCredential.findUnique({
    where: { connectionId_purpose: { connectionId, purpose: PlatformCredentialPurpose.PLATFORM_WEBHOOK_SIGNATURE } }
  });
  assert.equal(revoked?.encryptedCurrentValue, null);
  assert.equal(revoked?.encryptedPreviousValue, null);
  assert.deepEqual(await resolvePlatformWebhookCredentialCandidates({
    merchantId: merchantA,
    connectionId,
    platform: "SHOPIFY",
    purpose: "PLATFORM_WEBHOOK_SIGNATURE"
  }), { current: null, previous: null });
});
