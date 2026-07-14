import assert from "node:assert/strict";
import crypto from "node:crypto";
import prismaPackage from "@prisma/client";

const { PrismaClient } = prismaPackage;
const SecurityFixtureKind = { H2A_STAGING_CROSS_TENANT: "H2A_STAGING_CROSS_TENANT" };
const SecurityFixtureStatus = { CREATING: "CREATING" };

if (process.env.RUN_SCRATCH_DB_TESTS !== "1") {
  console.log("H2A synthetic tenant scratch test skipped (set RUN_SCRATCH_DB_TESTS=1)");
  process.exit(0);
}

const prisma = new PrismaClient();
const suffix = crypto.randomUUID().replaceAll("-", "");
const merchantEmail = `scratch-h2a-${suffix}@shipmastr.invalid`;
const lifecycleEmail = `h2a-tenant-b-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}@shipmastr.invalid`;
let merchantId;
let ownerId;
let lifecycleMerchantId;
let lifecycleOwnerId;
const fixtureIds = [];

try {
  process.env.APP_ENV = "staging";
  process.env.H2A_SYNTHETIC_TENANT_LIFECYCLE_ENABLED = "true";
  const { createH2AStagingTenant, cleanupH2AStagingTenant, fixtureAuthenticationAllowed } = await import("../../dist/modules/securityFixtures/h2a-staging-tenant.service.js");
  const { H2A_CREATE_CONFIRMATION, H2A_FIXTURE_KIND, H2A_MERCHANT_MARKER, H2A_STORE_URL } = await import("../../dist/modules/securityFixtures/h2a-staging-tenant.validation.js");
  const creatorMerchant = await prisma.merchant.create({ data: { name: "H2A scratch creator", email: `h2a-creator-${suffix}@shipmastr.invalid` } });
  const creator = await prisma.user.create({
    data: {
      merchantId: creatorMerchant.id,
      email: `h2a-creator-${suffix}@shipmastr.invalid`,
      passwordHash: "scratch-only-hash",
      userType: "INTERNAL_SHIPMASTR",
      role: "MASTER_ADMIN"
    }
  });
  const lifecycle = await createH2AStagingTenant({
    fixtureType: H2A_FIXTURE_KIND,
    confirmation: H2A_CREATE_CONFIRMATION,
    merchantName: H2A_MERCHANT_MARKER,
    ownerName: "H2A Synthetic Tenant B Owner",
    email: lifecycleEmail,
    storeUrl: H2A_STORE_URL,
    password: "scratch-only-password-that-is-at-least-24",
    expiresInMinutes: 15
  }, creator.id);
  const lifecycleRow = await prisma.securityFixtureTenant.findUnique({ where: { id: lifecycle.fixtureId }, select: { merchantId: true, ownerUserId: true, status: true } });
  assert.equal(lifecycle.status, "ACTIVE");
  assert.equal(lifecycleRow?.status, "ACTIVE");
  lifecycleMerchantId = lifecycleRow?.merchantId;
  lifecycleOwnerId = lifecycleRow?.ownerUserId;
  assert.ok(lifecycleMerchantId);
  assert.ok(lifecycleOwnerId);
  assert.equal(await fixtureAuthenticationAllowed(lifecycleOwnerId), true);
  await cleanupH2AStagingTenant(lifecycle.fixtureId);
  const cleaned = await prisma.securityFixtureTenant.findUnique({ where: { id: lifecycle.fixtureId }, select: { status: true } });
  assert.equal(cleaned?.status, "CLEANED");
  assert.equal(await fixtureAuthenticationAllowed(lifecycleOwnerId), false);
  assert.equal((await prisma.merchant.findUnique({ where: { id: lifecycleMerchantId }, select: { adminStatus: true } }))?.adminStatus, "BLOCKED");
  await prisma.securityFixtureTenant.delete({ where: { id: lifecycle.fixtureId } });
  await prisma.user.delete({ where: { id: lifecycleOwnerId } });
  await prisma.merchant.delete({ where: { id: lifecycleMerchantId } });
  await prisma.user.delete({ where: { id: creator.id } });
  await prisma.merchant.delete({ where: { id: creatorMerchant.id } });

  const merchant = await prisma.merchant.create({ data: { name: "H2A scratch synthetic tenant", email: merchantEmail } });
  merchantId = merchant.id;
  const owner = await prisma.user.create({
    data: {
      merchantId,
      email: merchantEmail,
      passwordHash: "scratch-only-hash",
      userType: "MERCHANT_ACCOUNT",
      role: "MERCHANT_OWNER"
    }
  });
  ownerId = owner.id;

  const createFixture = (slot) => prisma.securityFixtureTenant.create({
    data: {
      fixtureKind: SecurityFixtureKind.H2A_STAGING_CROSS_TENANT,
      status: SecurityFixtureStatus.CREATING,
      activeSlot: slot,
      creatorInternalUserId: ownerId,
      merchantId,
      ownerUserId: ownerId,
      expiresAt: new Date(Date.now() + 60_000)
    }
  });
  const results = await Promise.allSettled([createFixture(`H2A_SCRATCH_SLOT_${suffix}`), createFixture(`H2A_SCRATCH_SLOT_${suffix}`)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  for (const result of results) if (result.status === "fulfilled") fixtureIds.push(result.value.id);

  const rollbackEmail = `scratch-h2a-rollback-${suffix}@shipmastr.invalid`;
  await assert.rejects(() => prisma.$transaction(async (tx) => {
    const rollbackMerchant = await tx.merchant.create({ data: { name: "H2A rollback scratch", email: rollbackEmail } });
    await tx.securityFixtureTenant.create({
      data: {
        fixtureKind: SecurityFixtureKind.H2A_STAGING_CROSS_TENANT,
        status: SecurityFixtureStatus.CREATING,
        creatorInternalUserId: ownerId,
        merchantId: rollbackMerchant.id,
        expiresAt: new Date(Date.now() + 60_000)
      }
    });
    throw new Error("SCRATCH_ROLLBACK_ASSERTION");
  }), /SCRATCH_ROLLBACK_ASSERTION/);
  assert.equal(await prisma.merchant.findUnique({ where: { email: rollbackEmail } }), null);
  console.log("H2A synthetic tenant scratch migration/concurrency/rollback checks passed");
} finally {
  if (fixtureIds.length) await prisma.securityFixtureTenant.deleteMany({ where: { id: { in: fixtureIds } } });
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } });
  if (merchantId) await prisma.merchant.delete({ where: { id: merchantId } });
  await prisma.$disconnect();
}
