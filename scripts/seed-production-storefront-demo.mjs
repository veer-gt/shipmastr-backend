import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

dotenv.config();

export const APPROVED_DOMAIN = "www.shipmastr.co.in";
export const DEMO_STORE_NAME = "Shipmastr Demo Store";
export const DEMO_STATUS = "ACTIVE";

const DEMO_MERCHANT = {
  id: "merchant_storefront_demo_shipmastr_co_in",
  name: "Shipmastr Controlled Demo Merchant",
  email: "storefront-demo-shipmastr-co-in@shipmastr.local"
};

const DEMO_STOREFRONT = {
  id: "storefront_demo_shipmastr_co_in",
  domainId: "storefront_domain_demo_shipmastr_co_in_www",
  settingsId: "storefront_settings_demo_shipmastr_co_in",
  domain: APPROVED_DOMAIN,
  status: DEMO_STATUS,
  isPrimary: true,
  storeName: DEMO_STORE_NAME,
  themeJson: {
    primaryColor: "#f97316",
    backgroundColor: "#100d08",
    textColor: "#fff8f0",
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
    heroTitle: "Shipmastr controlled storefront",
    heroSubtitle: "A safe demo storefront for the first controlled custom-domain activation.",
    ctaLabel: "Storefront ready"
  }
};

function parseDomainArg(argv = process.argv.slice(2)) {
  const inline = argv.find((arg) => arg.startsWith("--domain="));
  if (inline) return inline.slice("--domain=".length);

  const index = argv.indexOf("--domain");
  if (index >= 0) return argv[index + 1] || "";

  return "";
}

export function assertProductionDemoSeedSafety(source = process.env, argv = process.argv.slice(2)) {
  const approved = source.ALLOW_PRODUCTION_STOREFRONT_DEMO_SEED === "true";
  const domain = parseDomainArg(argv);
  const inCloudRunJob = Boolean(source.CLOUD_RUN_JOB);
  const explicitProductionContext = source.SHIPMASTR_PRODUCTION_DB_SEED_CONTEXT === "controlled-production-db";

  if (!approved) {
    throw new Error("ALLOW_PRODUCTION_STOREFRONT_DEMO_SEED=true is required");
  }

  if (domain !== APPROVED_DOMAIN) {
    throw new Error(`Refusing to seed any storefront domain except ${APPROVED_DOMAIN}`);
  }

  if (!source.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }

  if (!inCloudRunJob && !explicitProductionContext) {
    throw new Error("Run this through a controlled Cloud Run job or set SHIPMASTR_PRODUCTION_DB_SEED_CONTEXT=controlled-production-db");
  }

  return {
    domain
  };
}

export async function seedProductionStorefrontDemo({ client, source = process.env, argv = process.argv.slice(2) }) {
  const { domain } = assertProductionDemoSeedSafety(source, argv);

  await client.merchant.upsert({
    where: { id: DEMO_MERCHANT.id },
    update: {
      name: DEMO_MERCHANT.name,
      email: DEMO_MERCHANT.email
    },
    create: DEMO_MERCHANT
  });

  const storefront = await client.storefront.upsert({
    where: { id: DEMO_STOREFRONT.id },
    update: {
      merchantId: DEMO_MERCHANT.id,
      name: DEMO_STOREFRONT.storeName
    },
    create: {
      id: DEMO_STOREFRONT.id,
      merchantId: DEMO_MERCHANT.id,
      name: DEMO_STOREFRONT.storeName
    }
  });

  const storefrontDomain = await client.storefrontDomain.upsert({
    where: { domain },
    update: {
      storefrontId: storefront.id,
      status: DEMO_STOREFRONT.status,
      isPrimary: DEMO_STOREFRONT.isPrimary
    },
    create: {
      id: DEMO_STOREFRONT.domainId,
      storefrontId: storefront.id,
      domain,
      status: DEMO_STOREFRONT.status,
      isPrimary: DEMO_STOREFRONT.isPrimary
    }
  });

  await client.storefrontSettings.upsert({
    where: { storefrontId: storefront.id },
    update: {
      themeJson: DEMO_STOREFRONT.themeJson
    },
    create: {
      id: DEMO_STOREFRONT.settingsId,
      storefrontId: storefront.id,
      themeJson: DEMO_STOREFRONT.themeJson
    }
  });

  return {
    ok: true,
    domain: storefrontDomain.domain,
    storeName: DEMO_STOREFRONT.storeName,
    status: storefrontDomain.status
  };
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const result = await seedProductionStorefrontDemo({ client: prisma });
    console.log(JSON.stringify(result, null, 2));
    console.log("Controlled storefront mapping seed completed. No provider credentials, DNS, Cloudflare, or ResellerClub actions were performed.");
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
