const { PrismaClient, Prisma } = require('@prisma/client');

const prisma = new PrismaClient();

const PROTECTED_USER_EMAILS = [
  'indraveer.chauhan@gmail.com',
  'skymax.veer@gmail.com',
  'blissbooking9@gmail.com',
];

const APPLY = process.argv.includes('--apply');

function delegateName(modelName) {
  return modelName.charAt(0).toLowerCase() + modelName.slice(1);
}

function getModel(modelName) {
  return Prisma.dmmf.datamodel.models.find((m) => m.name === modelName);
}

function hasModel(modelName) {
  return Boolean(getModel(modelName)) && Boolean(prisma[delegateName(modelName)]);
}

function hasField(modelName, fieldName) {
  const model = getModel(modelName);
  return Boolean(model && model.fields.some((f) => f.name === fieldName));
}

async function txDel(tx, modelName, where = {}) {
  const d = delegateName(modelName);

  if (!hasModel(modelName) || !tx[d]) {
    console.log(`SKIP missing model: ${modelName}`);
    return;
  }

  const total = await tx[d].count({ where });

  if (!APPLY) {
    console.log(`[DRY RUN] ${modelName}: would delete ${total}`);
    return;
  }

  const result = await tx[d].deleteMany({ where });
  console.log(`[DELETED] ${modelName}: ${result.count}`);
}

function bigshipKeepWhere() {
  const ors = [];

  if (hasField('CourierPartner', 'name')) {
    ors.push({ name: { contains: 'bigship', mode: 'insensitive' } });
  }

  if (hasField('CourierPartner', 'code')) {
    ors.push({ code: { contains: 'bigship', mode: 'insensitive' } });
  }

  if (hasField('CourierPartner', 'slug')) {
    ors.push({ slug: { contains: 'bigship', mode: 'insensitive' } });
  }

  if (hasField('CourierPartner', 'providerCode')) {
    ors.push({ providerCode: { contains: 'bigship', mode: 'insensitive' } });
  }

  if (hasField('CourierPartner', 'displayName')) {
    ors.push({ displayName: { contains: 'bigship', mode: 'insensitive' } });
  }

  return ors.length ? { OR: ors } : null;
}

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY DELETE' : 'DRY RUN ONLY'}`);
  console.log('Protected users:', PROTECTED_USER_EMAILS.join(', '));
  console.log('Keeping Bigship courier partner records.');
  console.log('');

  if (hasModel('User')) {
    const protectedUsers = await prisma.user.findMany({
      where: { email: { in: PROTECTED_USER_EMAILS } },
      select: { id: true, email: true },
    });

    console.log('Protected users found:');
    console.table(protectedUsers);

    if (!protectedUsers.some((u) => u.email === 'indraveer.chauhan@gmail.com')) {
      throw new Error('STOP: master admin indraveer.chauhan@gmail.com not found. Nothing deleted.');
    }
  }

  if (hasModel('CourierPartner')) {
    const bigshipWhere = bigshipKeepWhere();

    if (bigshipWhere) {
      const bigshipRows = await prisma.courierPartner.findMany({
        where: bigshipWhere,
        select: {
          id: true,
          ...(hasField('CourierPartner', 'name') ? { name: true } : {}),
          ...(hasField('CourierPartner', 'code') ? { code: true } : {}),
          ...(hasField('CourierPartner', 'slug') ? { slug: true } : {}),
          ...(hasField('CourierPartner', 'isSystemManaged') ? { isSystemManaged: true } : {}),
        },
      });

      console.log('Bigship courier partner records found:');
      console.table(bigshipRows);
    } else {
      console.log('Could not build Bigship lookup because CourierPartner has no known name/code/slug fields.');
    }
  }

  await prisma.$transaction(async (tx) => {
    const deleteModelsInOrder = [
      'PlatformTrackingSyncAttempt',
      'PlatformTrackingSync',
      'PilotWebhookRegistration',
      'PilotEmailDelivery',
      'PilotCapabilityApproval',
      'ShipmastrWorkerRun',

      'MerchantNotification',
      'MerchantNotificationPreference',

      'PlatformImportCursor',
      'PlatformImportConversion',
      'PlatformImportItem',
      'PlatformImportJob',
      'PlatformOrderImport',

      'PlatformConnectionHealthCheck',
      'PlatformCredentialSecret',
      'PlatformCredential',
      'PlatformConnection',

      'WebhookEventOutbox',
      'WebhookSubscription',
      'SellerApiKey',

      'BulkShippingItem',
      'BulkShippingBatch',
      'SlaEvent',
      'SLAEvent',
      'AutopilotDecisionAudit',
      'AutopilotPreference',

      'WeightDiscrepancyCase',
      'CodLedgerEntry',
      'CODLedgerEntry',
      'RtoCase',
      'RTOCase',
      'NdrActionAttempt',
      'NDRActionAttempt',
      'NdrCase',
      'NDRCase',

      'ShipmentTrackingEvent',
      'ShipmentRate',
      'ShipmentProviderRef',
      'Shipment',

      'PickupLocationProviderMapping',
      'PickupLocation',

      'SellerCourierPartner',

      'Order',
      'Seller',
      'Merchant',
    ];

    for (const modelName of deleteModelsInOrder) {
      await txDel(tx, modelName);
    }

    if (hasModel('CourierPartner')) {
      const d = delegateName('CourierPartner');
      const andRules = [];

      if (hasField('CourierPartner', 'isSystemManaged')) {
        andRules.push({
          OR: [
            { isSystemManaged: false },
            { isSystemManaged: null },
          ],
        });
      }

      const keepBigship = bigshipKeepWhere();
      if (keepBigship) {
        andRules.push({ NOT: keepBigship });
      }

      const where = andRules.length ? { AND: andRules } : {};

      const total = await tx[d].count({ where });

      if (!APPLY) {
        console.log(`[DRY RUN] CourierPartner: would delete ${total} fake/non-system courier partners, keeping Bigship/system records`);
      } else {
        const result = await tx[d].deleteMany({ where });
        console.log(`[DELETED] CourierPartner fake/non-system excluding Bigship/system: ${result.count}`);
      }
    }

    if (hasModel('User')) {
      const total = await tx.user.count({
        where: { email: { notIn: PROTECTED_USER_EMAILS } },
      });

      if (!APPLY) {
        console.log(`[DRY RUN] User: would delete ${total} non-protected users`);
      } else {
        const result = await tx.user.deleteMany({
          where: { email: { notIn: PROTECTED_USER_EMAILS } },
        });
        console.log(`[DELETED] User non-protected: ${result.count}`);
      }
    }
  }, { timeout: 120000 });

  console.log('');
  console.log(APPLY ? 'Cleanup applied.' : 'Dry run complete. Nothing was deleted.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
