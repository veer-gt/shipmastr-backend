import assert from "node:assert/strict";
import crypto from "node:crypto";
import prismaPackage from "@prisma/client";

const { PrismaClient } = prismaPackage;

if (process.env.RUN_SCRATCH_DB_TESTS !== "1") {
  console.log("H2A synthetic tenant scratch test skipped (set RUN_SCRATCH_DB_TESTS=1)");
  process.exit(0);
}

process.env.APP_ENV = "staging";
process.env.H2A_SYNTHETIC_TENANT_LIFECYCLE_ENABLED = "true";
process.env.PORT = process.env.PORT || String(40_000 + crypto.randomInt(0, 5_000));

const prisma = new PrismaClient();
const suffix = crypto.randomUUID().replaceAll("-", "");
const creatorEmail = `h2a-creator-${suffix}@shipmastr.invalid`;
const fixtureIds = [];
let creatorMerchantId = "";
let creatorId = "";

async function request(method, path, body, token) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`http://127.0.0.1:${process.env.PORT}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error"
  });
  let parsed = null;
  try { parsed = await response.json(); } catch { parsed = null; }
  return { status: response.status, body: parsed };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await request("GET", "/api/health")).status === 200) return;
    } catch {
      // The server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("H2A_LOCAL_SERVER_NOT_READY");
}

function lifecycleEmail(offsetSeconds) {
  const timestamp = new Date(Date.now() + offsetSeconds * 1_000)
    .toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `h2a-tenant-b-${timestamp}@shipmastr.invalid`;
}

function responseHasEmail(response) {
  return Boolean(response && typeof response === "object" && "email" in response);
}

async function cleanupFixture(fixtureId) {
  if (!fixtureId) return;
  try {
    await cleanupH2AStagingTenant(fixtureId);
  } catch {
    // The caller's scratch-database teardown remains the final safety net.
  }
}

let createH2AStagingTenant;
let cleanupH2AStagingTenant;
let fixtureAuthenticationAllowed;
let hashPassword;
let verifyPassword;
let getAuthAbuseStatus;
let H2A_CREATE_CONFIRMATION;
let H2A_FIXTURE_KIND;
let H2A_MERCHANT_MARKER;
let H2A_STORE_URL;

async function runIteration(offsetSeconds) {
  const email = lifecycleEmail(offsetSeconds);
  const password = crypto.randomBytes(32).toString("base64url");
  let fixtureId = "";
  let ownerId = "";
  let merchantId = "";
  let token = "";
  try {
    const created = await createH2AStagingTenant({
      fixtureType: H2A_FIXTURE_KIND,
      confirmation: H2A_CREATE_CONFIRMATION,
      merchantName: H2A_MERCHANT_MARKER,
      ownerName: "H2A Synthetic Tenant B Owner",
      email,
      storeUrl: H2A_STORE_URL,
      password,
      expiresInMinutes: 15
    }, creatorId);
    fixtureId = created.fixtureId;
    fixtureIds.push(fixtureId);
    assert.equal(created.status, "ACTIVE");
    assert.equal(created.ownerReady, true);
    assert.equal(responseHasEmail(created), false);

    const rows = await prisma.securityFixtureTenant.findMany({
      where: { id: fixtureId },
      select: { status: true, expiresAt: true, merchantId: true, ownerUserId: true, activeSlot: true }
    });
    assert.equal(rows.length, 1);
    const fixture = rows[0];
    assert.equal(fixture.status, "ACTIVE");
    assert.ok(fixture.expiresAt > new Date());
    assert.equal(fixture.activeSlot, "H2A_STAGING_TENANT_B");
    assert.ok(fixture.merchantId && fixture.ownerUserId);
    merchantId = fixture.merchantId;
    ownerId = fixture.ownerUserId;

    const [merchant, owner, auditRows] = await Promise.all([
      prisma.merchant.findUnique({ where: { id: merchantId }, select: { email: true } }),
      prisma.user.findUnique({ where: { id: ownerId }, select: { email: true, passwordHash: true, role: true, userType: true } }),
      prisma.auditLog.findMany({ where: { entityId: fixtureId }, select: { metadata: true } })
    ]);
    const normalizedEmail = email.toLowerCase();
    assert.equal(merchant?.email, normalizedEmail);
    assert.equal(owner?.email, normalizedEmail);
    assert.equal(merchant?.email, owner?.email);
    assert.equal(owner?.role, "MERCHANT_OWNER");
    assert.equal(owner?.userType, "MERCHANT_ACCOUNT");
    assert.equal(auditRows.length, 1);
    assert.equal(auditRows.some((row) => JSON.stringify(row.metadata ?? {}).includes(normalizedEmail)), false);

    assert.equal(await fixtureAuthenticationAllowed(ownerId), true);
    assert.equal(await verifyPassword(password, owner?.passwordHash ?? ""), true);
    const abuse = await getAuthAbuseStatus({ accountKey: `email:${email}`, networkKey: "127.0.0.1" });
    assert.equal(abuse.blocked, false);
    assert.equal(abuse.accountAttempts, 0);
    assert.equal(abuse.networkBlocked, false);

    const wrongPassword = await request("POST", "/api/auth/login", { identifier: email, password: `${password}-wrong` });
    assert.equal(wrongPassword.status, 400);
    assert.equal(wrongPassword.body?.error, "INVALID_LOGIN");

    const uppercaseLogin = await request("POST", "/api/auth/login", { identifier: email, password });
    assert.equal(uppercaseLogin.status, 200);
    assert.ok(typeof uppercaseLogin.body?.token === "string" && uppercaseLogin.body.token.length > 0);
    assert.equal(responseHasEmail(uppercaseLogin.body), false);

    const lowercaseLogin = await request("POST", "/api/auth/login", { identifier: normalizedEmail, password });
    assert.equal(lowercaseLogin.status, 200);
    assert.ok(typeof lowercaseLogin.body?.token === "string" && lowercaseLogin.body.token.length > 0);
    token = lowercaseLogin.body.token;

    const authMe = await request("GET", "/api/auth/me", undefined, token);
    assert.equal(authMe.status, 200);
    assert.equal(authMe.body?.merchantId, merchantId);
    assert.notEqual(authMe.body?.merchantId, creatorMerchantId);

    const cleaned = await cleanupH2AStagingTenant(fixtureId);
    assert.equal(cleaned.status, "CLEANED");
    assert.equal(responseHasEmail(cleaned), false);
    const [cleanedFixture, blockedMerchant] = await Promise.all([
      prisma.securityFixtureTenant.findUnique({ where: { id: fixtureId }, select: { status: true, activeSlot: true } }),
      prisma.merchant.findUnique({ where: { id: merchantId }, select: { adminStatus: true } })
    ]);
    assert.equal(cleanedFixture?.status, "CLEANED");
    assert.equal(cleanedFixture?.activeSlot, null);
    assert.equal(blockedMerchant?.adminStatus, "BLOCKED");
    assert.equal(await fixtureAuthenticationAllowed(ownerId), false);

    const postCleanupLogin = await request("POST", "/api/auth/login", { identifier: normalizedEmail, password });
    assert.equal(postCleanupLogin.status, 400);
    assert.equal(postCleanupLogin.body?.error, "INVALID_LOGIN");
    const postCleanupMe = await request("GET", "/api/auth/me", undefined, token);
    assert.equal(postCleanupMe.status, 401);
  } finally {
    await cleanupFixture(fixtureId);
  }
}

try {
  ({ createH2AStagingTenant, cleanupH2AStagingTenant, fixtureAuthenticationAllowed } = await import("../../dist/modules/securityFixtures/h2a-staging-tenant.service.js"));
  ({ hashPassword, verifyPassword } = await import("../../dist/modules/auth/password-hashing.js"));
  ({ getAuthAbuseStatus } = await import("../../dist/modules/auth/auth-abuse.service.js"));
  ({ H2A_CREATE_CONFIRMATION, H2A_FIXTURE_KIND, H2A_MERCHANT_MARKER, H2A_STORE_URL } = await import("../../dist/modules/securityFixtures/h2a-staging-tenant.validation.js"));
  await import("../../dist/server.js");
  await waitForServer();

  const creatorMerchant = await prisma.merchant.create({ data: { name: "H2A scratch creator", email: creatorEmail } });
  creatorMerchantId = creatorMerchant.id;
  const creator = await prisma.user.create({
    data: {
      merchantId: creatorMerchantId,
      email: creatorEmail,
      passwordHash: await hashPassword(crypto.randomBytes(32).toString("base64url")),
      userType: "INTERNAL_SHIPMASTR",
      role: "MASTER_ADMIN"
    }
  });
  creatorId = creator.id;

  await runIteration(0);
  await runIteration(1);
  await runIteration(2);

  const activeSlots = await prisma.securityFixtureTenant.count({ where: { activeSlot: { not: null } } });
  assert.equal(activeSlots, 0);

  const createFixture = (slot) => prisma.securityFixtureTenant.create({
    data: {
      fixtureKind: "H2A_STAGING_CROSS_TENANT",
      status: "CREATING",
      activeSlot: slot,
      creatorInternalUserId: creatorId,
      expiresAt: new Date(Date.now() + 60_000)
    }
  });
  const results = await Promise.allSettled([
    createFixture(`H2A_SCRATCH_SLOT_${suffix}`),
    createFixture(`H2A_SCRATCH_SLOT_${suffix}`)
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  for (const result of results) if (result.status === "fulfilled") fixtureIds.push(result.value.id);

  const rollbackEmail = `scratch-h2a-rollback-${suffix}@shipmastr.invalid`;
  await assert.rejects(() => prisma.$transaction(async (tx) => {
    const rollbackMerchant = await tx.merchant.create({ data: { name: "H2A rollback scratch", email: rollbackEmail } });
    await tx.securityFixtureTenant.create({
      data: {
        fixtureKind: "H2A_STAGING_CROSS_TENANT",
        status: "CREATING",
        creatorInternalUserId: creatorId,
        merchantId: rollbackMerchant.id,
        expiresAt: new Date(Date.now() + 60_000)
      }
    });
    throw new Error("SCRATCH_ROLLBACK_ASSERTION");
  }), /SCRATCH_ROLLBACK_ASSERTION/);
  assert.equal(await prisma.merchant.findUnique({ where: { email: rollbackEmail } }), null);
  console.log("H2A synthetic tenant scratch lifecycle/auth/cleanup/normalization checks passed");
} catch {
  console.error("H2A synthetic tenant scratch lifecycle/auth/cleanup/normalization checks failed");
  process.exitCode = 1;
} finally {
  if (fixtureIds.length) await prisma.securityFixtureTenant.deleteMany({ where: { id: { in: fixtureIds } } }).catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(process.exitCode || 0);
}
