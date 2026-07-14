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
let merchantId;
let ownerId;
const fixtureIds = [];

try {
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
