const { PrismaClient, Prisma } = require('@prisma/client');
const crypto = require('crypto');

const prisma = new PrismaClient();

const PROTECTED_USERS = [
  { email: 'indraveer.chauhan@gmail.com', name: 'Indraveer Chauhan' },
  { email: 'skymax.veer@gmail.com', name: 'Skymax Veer' },
  { email: 'blissbooking9@gmail.com', name: 'Bliss Booking' },
];

const MASTER_MERCHANT_NAME = 'Shipmastr Master Admin';
const MASTER_MERCHANT_SLUG = 'shipmastr-master-admin';

function model(name) {
  return Prisma.dmmf.datamodel.models.find((m) => m.name === name);
}

function hasModel(name) {
  return Boolean(model(name)) && Boolean(prisma[name.charAt(0).toLowerCase() + name.slice(1)]);
}

function delegate(name) {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

function fieldNames(modelName) {
  return new Set(model(modelName)?.fields.map((f) => f.name) || []);
}

function hasField(modelName, fieldName) {
  return fieldNames(modelName).has(fieldName);
}

function enumValues(enumName) {
  return Prisma.dmmf.datamodel.enums.find((e) => e.name === enumName)?.values.map((v) => v.name) || [];
}

function pickEnum(typeName, preferred = []) {
  const values = enumValues(typeName);
  for (const p of preferred) {
    if (values.includes(p)) return p;
  }
  return values[0] || undefined;
}

function valueForRequiredField(modelName, field) {
  const lower = field.name.toLowerCase();

  if (field.kind === 'enum') {
    return pickEnum(field.type, [
      'MASTER_ADMIN',
      'SUPER_ADMIN',
      'ADMIN',
      'MERCHANT_ADMIN',
      'OWNER',
      'ACTIVE',
      'APPROVED',
      'VERIFIED',
      'PENDING',
      'IN',
      'INDIA',
      'LOCAL',
      'MOCK',
      'DEFAULT',
    ]);
  }

  if (field.type === 'String') {
    if (lower === 'email') return 'indraveer.chauhan@gmail.com';
    if (lower.includes('name')) return modelName === 'Merchant' ? MASTER_MERCHANT_NAME : 'Protected User';
    if (lower.includes('slug')) return MASTER_MERCHANT_SLUG;
    if (lower.includes('phone') || lower.includes('mobile')) return '9999999999';
    if (lower.includes('country')) return 'IN';
    if (lower.includes('state')) return 'Delhi';
    if (lower.includes('city')) return 'Delhi';
    if (lower.includes('pin') || lower.includes('postal') || lower.includes('zip')) return '110001';
    if (lower.includes('address')) return 'Shipmastr Admin Address';
    if (lower.includes('password')) return `dev-placeholder-${crypto.randomBytes(16).toString('hex')}`;
    if (lower.includes('gst')) return 'UNREGISTERED';
    if (lower.includes('pan')) return 'ABCDE1234F';
    if (lower.includes('code')) return 'MASTER';
    if (lower.includes('type')) return 'MASTER_ADMIN';
    return `${modelName}-${field.name}-dev`;
  }

  if (field.type === 'Boolean') {
    if (lower.includes('active') || lower.includes('enabled') || lower.includes('verified')) return true;
    return false;
  }

  if (['Int', 'Float', 'Decimal', 'BigInt'].includes(field.type)) return 0;
  if (field.type === 'DateTime') return new Date();
  if (field.type === 'Json') return {};

  return undefined;
}

function buildCreateData(modelName, overrides = {}) {
  const m = model(modelName);
  const data = { ...overrides };

  for (const f of m.fields) {
    if (data[f.name] !== undefined) continue;
    if (f.kind === 'object') continue;
    if (f.isList) continue;
    if (f.isId) continue;
    if (f.hasDefaultValue) continue;
    if (f.isUpdatedAt) continue;
    if (!f.isRequired) continue;

    const value = valueForRequiredField(modelName, f);
    if (value !== undefined) data[f.name] = value;
  }

  return data;
}

async function ensureMasterMerchant() {
  if (!hasModel('Merchant')) {
    throw new Error('Merchant model not found. Cannot create protected users because User requires merchant.');
  }

  const merchantFields = fieldNames('Merchant');

  let existing = null;

  if (merchantFields.has('name')) {
    existing = await prisma.merchant.findFirst({
      where: { name: MASTER_MERCHANT_NAME },
      select: { id: true },
    });
  }

  if (!existing && merchantFields.has('slug')) {
    existing = await prisma.merchant.findFirst({
      where: { slug: MASTER_MERCHANT_SLUG },
      select: { id: true },
    }).catch(() => null);
  }

  if (existing) {
    console.log(`KEEP existing master merchant: ${existing.id}`);
    return existing;
  }

  const merchantData = buildCreateData('Merchant', {
    ...(merchantFields.has('name') ? { name: MASTER_MERCHANT_NAME } : {}),
    ...(merchantFields.has('slug') ? { slug: MASTER_MERCHANT_SLUG } : {}),
    ...(merchantFields.has('email') ? { email: 'indraveer.chauhan@gmail.com' } : {}),
    ...(merchantFields.has('phone') ? { phone: '9999999999' } : {}),
  });

  const created = await prisma.merchant.create({
    data: merchantData,
    select: { id: true },
  });

  console.log(`CREATED master merchant: ${created.id}`);
  return created;
}

async function ensureProtectedUsers(masterMerchantId) {
  if (!hasModel('User')) {
    throw new Error('User model not found.');
  }

  const userFields = fieldNames('User');

  const roleValue = userFields.has('role')
    ? pickEnum('UserRole', ['MASTER_ADMIN', 'SUPER_ADMIN', 'ADMIN', 'MERCHANT_ADMIN', 'OWNER']) || pickEnum('Role', ['MASTER_ADMIN', 'SUPER_ADMIN', 'ADMIN', 'MERCHANT_ADMIN', 'OWNER'])
    : undefined;

  const userTypeValue = userFields.has('userType')
    ? pickEnum('UserType', ['MASTER_ADMIN', 'ADMIN', 'MERCHANT_ADMIN', 'OWNER'])
    : undefined;

  for (const u of PROTECTED_USERS) {
    const existing = await prisma.user.findUnique({
      where: { email: u.email },
      select: { id: true, email: true },
    }).catch(() => null);

    if (existing) {
      console.log(`KEEP existing protected user: ${u.email}`);
      continue;
    }

    const base = {
      email: u.email,
      ...(userFields.has('name') ? { name: u.name } : {}),
      ...(userFields.has('passwordHash') ? { passwordHash: `dev-placeholder-${crypto.randomBytes(16).toString('hex')}` } : {}),
      ...(userFields.has('role') && roleValue ? { role: roleValue } : {}),
      ...(userFields.has('userType') && userTypeValue ? { userType: userTypeValue } : {}),
      ...(userFields.has('merchantId') ? { merchantId: masterMerchantId } : {}),
      ...(!userFields.has('merchantId') && userFields.has('merchant') ? { merchant: { connect: { id: masterMerchantId } } } : {}),
    };

    const data = buildCreateData('User', base);

    const created = await prisma.user.create({
      data,
      select: {
        id: true,
        email: true,
        ...(userFields.has('name') ? { name: true } : {}),
        ...(userFields.has('role') ? { role: true } : {}),
        ...(userFields.has('userType') ? { userType: true } : {}),
        ...(userFields.has('merchantId') ? { merchantId: true } : {}),
      },
    });

    console.log('CREATED protected user:');
    console.table([created]);
  }
}

async function deleteModel(modelName, where = {}) {
  if (!hasModel(modelName)) {
    console.log(`SKIP missing model: ${modelName}`);
    return;
  }

  const d = delegate(modelName);
  const count = await prisma[d].count({ where });
  const result = await prisma[d].deleteMany({ where });
  console.log(`[DELETED] ${modelName}: ${result.count} of ${count}`);
}

async function cleanupFakeData(masterMerchantId) {
  const deleteOrder = [
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
  ];

  for (const m of deleteOrder) {
    await deleteModel(m);
  }

  if (hasModel('Merchant')) {
    await deleteModel('Merchant', { id: { not: masterMerchantId } });
  }

  if (hasModel('User')) {
    await deleteModel('User', {
      email: { notIn: PROTECTED_USERS.map((u) => u.email) },
    });
  }

  if (hasModel('CourierPartner')) {
    const keepRules = [];

    if (hasField('CourierPartner', 'isSystemManaged')) keepRules.push({ isSystemManaged: true });
    if (hasField('CourierPartner', 'name')) keepRules.push({ name: { contains: 'bigship', mode: 'insensitive' } });
    if (hasField('CourierPartner', 'name')) keepRules.push({ name: { in: ['Metro Swift', 'Bharat Express'] } });
    if (hasField('CourierPartner', 'code')) keepRules.push({ code: { contains: 'bigship', mode: 'insensitive' } });
    if (hasField('CourierPartner', 'code')) keepRules.push({ code: { in: ['METROSWIFT', 'BHARATEXP'] } });
    if (hasField('CourierPartner', 'slug')) keepRules.push({ slug: { contains: 'bigship', mode: 'insensitive' } });
    if (hasField('CourierPartner', 'providerCode')) keepRules.push({ providerCode: { contains: 'bigship', mode: 'insensitive' } });
    if (hasField('CourierPartner', 'displayName')) keepRules.push({ displayName: { contains: 'bigship', mode: 'insensitive' } });

    const where = keepRules.length ? { NOT: { OR: keepRules } } : {};
    await deleteModel('CourierPartner', where);
  }
}

async function verify() {
  console.log('\n=== Protected users after cleanup ===');
  console.table(await prisma.user.findMany({
    where: { email: { in: PROTECTED_USERS.map((u) => u.email) } },
    select: {
      id: true,
      email: true,
      ...(hasField('User', 'name') ? { name: true } : {}),
      ...(hasField('User', 'role') ? { role: true } : {}),
      ...(hasField('User', 'userType') ? { userType: true } : {}),
      ...(hasField('User', 'merchantId') ? { merchantId: true } : {}),
    },
    orderBy: { email: 'asc' },
  }));

  if (hasModel('Merchant')) {
    console.log('\n=== Merchants after cleanup ===');
    console.table(await prisma.merchant.findMany({
      select: {
        id: true,
        ...(hasField('Merchant', 'name') ? { name: true } : {}),
        ...(hasField('Merchant', 'slug') ? { slug: true } : {}),
        ...(hasField('Merchant', 'email') ? { email: true } : {}),
      },
    }));
  }

  if (hasModel('CourierPartner')) {
    console.log('\n=== Courier partners after cleanup ===');
    console.table(await prisma.courierPartner.findMany({
      select: {
        id: true,
        ...(hasField('CourierPartner', 'name') ? { name: true } : {}),
        ...(hasField('CourierPartner', 'code') ? { code: true } : {}),
        ...(hasField('CourierPartner', 'isSystemManaged') ? { isSystemManaged: true } : {}),
        ...(hasField('CourierPartner', 'defaultForNewSellers') ? { defaultForNewSellers: true } : {}),
      },
    }));
  }
}

async function main() {
  console.log('Ensuring master merchant + protected users...');
  const masterMerchant = await ensureMasterMerchant();
  await ensureProtectedUsers(masterMerchant.id);

  console.log('\nCleaning fake/demo data while keeping protected users + Bigship...');
  await cleanupFakeData(masterMerchant.id);

  await verify();
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
