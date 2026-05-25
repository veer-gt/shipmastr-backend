import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

dotenv.config();

const prisma = new PrismaClient();

const DEMO_MERCHANT = {
  id: "merchant_storefront_demo",
  name: "Storefront Demo Merchant",
  email: "storefront-demo@shipmastr.local"
};

const DEMO_STOREFRONTS = [
  {
    storefrontId: "storefront_demo_celvya",
    domainId: "storefront_domain_demo_celvya",
    settingsId: "storefront_settings_demo_celvya",
    domain: "celvyawellness.in",
    status: "ACTIVE",
    isPrimary: true,
    storeName: "Celvya Wellness",
    themeJson: {
      primaryColor: "#2dd4bf",
      backgroundColor: "#080b10",
      textColor: "#f8fafc",
      fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      heroTitle: "Clean wellness essentials for everyday rituals",
      heroSubtitle: "Thoughtfully made care products, shipped with Shipmastr checkout and delivery confidence.",
      ctaLabel: "Explore the store"
    }
  },
  {
    storefrontId: "storefront_demo_pending",
    domainId: "storefront_domain_demo_pending",
    settingsId: "storefront_settings_demo_pending",
    domain: "pending.shipmastr.store",
    status: "SSL_PENDING",
    isPrimary: true,
    storeName: "Pending Storefront",
    themeJson: {
      primaryColor: "#38bdf8",
      backgroundColor: "#0a0f1a",
      textColor: "#eef6ff",
      fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      heroTitle: "Your storefront is almost ready",
      heroSubtitle: "DNS and SSL setup may still be in progress.",
      ctaLabel: "Setup in progress"
    }
  },
  {
    storefrontId: "storefront_demo_shipmastr_co_in",
    domainId: "storefront_domain_demo_shipmastr_co_in",
    settingsId: "storefront_settings_demo_shipmastr_co_in",
    domain: "www.shipmastr.co.in",
    status: "ACTIVE",
    isPrimary: true,
    storeName: "Shipmastr Demo Store",
    themeJson: {
      primaryColor: "#f97316",
      backgroundColor: "#100d08",
      textColor: "#fff8f0",
      fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      heroTitle: "Shipmastr controlled storefront",
      heroSubtitle: "A safe demo storefront for the first controlled custom-domain activation.",
      ctaLabel: "Storefront ready"
    }
  },
  {
    storefrontId: "storefront_demo_suspended",
    domainId: "storefront_domain_demo_suspended",
    settingsId: "storefront_settings_demo_suspended",
    domain: "suspended.shipmastr.store",
    status: "SUSPENDED",
    isPrimary: true,
    storeName: "Unavailable Storefront",
    themeJson: {
      primaryColor: "#f59e0b",
      backgroundColor: "#0d0d0c",
      textColor: "#fff7ed",
      fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      heroTitle: "Storefront unavailable",
      heroSubtitle: "This storefront is temporarily unavailable.",
      ctaLabel: "Unavailable"
    }
  }
];

function assertLocalOrDevTarget() {
  const env = String(process.env.NODE_ENV || "").toLowerCase();
  const appEnv = String(process.env.SHIPMASTR_ENV || process.env.APP_ENV || "").toLowerCase();
  const databaseUrl = String(process.env.DATABASE_URL || "").toLowerCase();

  if (env === "production" || appEnv === "production" || process.env.K_SERVICE || process.env.CLOUD_RUN_JOB) {
    throw new Error("Refusing to seed demo storefront rows in a production or Cloud Run runtime");
  }

  if (databaseUrl.includes("cloudsql") || databaseUrl.includes("shipmastr-core-prod") || databaseUrl.includes("production")) {
    throw new Error("Refusing to seed demo storefront rows against a production-looking database target");
  }
}

async function seedDemoStorefronts() {
  assertLocalOrDevTarget();

  await prisma.merchant.upsert({
    where: { id: DEMO_MERCHANT.id },
    update: {
      name: DEMO_MERCHANT.name,
      email: DEMO_MERCHANT.email
    },
    create: DEMO_MERCHANT
  });

  const seeded = [];

  for (const fixture of DEMO_STOREFRONTS) {
    const storefront = await prisma.storefront.upsert({
      where: { id: fixture.storefrontId },
      update: {
        merchantId: DEMO_MERCHANT.id,
        name: fixture.storeName
      },
      create: {
        id: fixture.storefrontId,
        merchantId: DEMO_MERCHANT.id,
        name: fixture.storeName
      }
    });

    const domain = await prisma.storefrontDomain.upsert({
      where: { domain: fixture.domain },
      update: {
        storefrontId: storefront.id,
        status: fixture.status,
        isPrimary: fixture.isPrimary
      },
      create: {
        id: fixture.domainId,
        storefrontId: storefront.id,
        domain: fixture.domain,
        status: fixture.status,
        isPrimary: fixture.isPrimary
      }
    });

    await prisma.storefrontSettings.upsert({
      where: { storefrontId: storefront.id },
      update: {
        themeJson: fixture.themeJson
      },
      create: {
        id: fixture.settingsId,
        storefrontId: storefront.id,
        themeJson: fixture.themeJson
      }
    });

    seeded.push({
      storefrontId: storefront.id,
      storefrontDomainId: domain.id,
      domain: domain.domain,
      status: domain.status
    });
  }

  console.log(JSON.stringify({
    ok: true,
    merchantId: DEMO_MERCHANT.id,
    rows: seeded
  }, null, 2));
}

seedDemoStorefronts()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
