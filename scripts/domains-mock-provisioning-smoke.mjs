import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

dotenv.config();

const prisma = new PrismaClient();

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const DEFAULT_CANDIDATE_DOMAINS = [
  "failed-demo.test",
  "mock-domain.test",
  "demo-shipmastr-domain.test",
  "demo-merchant.test"
];

function readApiBase() {
  const raw = process.env.SHIPMASTR_LOCAL_API_BASE_URL || process.env.SHIPMASTR_API_BASE_URL || `http://127.0.0.1:${process.env.PORT || "8080"}`;
  const url = new URL(raw);
  if (!LOCAL_HOSTS.has(url.hostname) && process.env.ALLOW_NON_LOCAL_MOCK_PROVISIONING_SMOKE !== "true") {
    throw new Error("Refusing to run mock provisioning smoke against a non-local API base");
  }
  return url.toString().replace(/\/+$/, "");
}

function readInternalSecret() {
  const secret = process.env.SHIPMASTR_INTERNAL_PROVISIONING_SECRET || process.env.SHIPMASTR_INTERNAL_SECRET || process.env.WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("Missing local internal secret env for mock provisioning smoke");
  }
  return secret;
}

function safeDomainSummary(row) {
  return {
    id: row.id,
    merchantId: row.merchantId,
    domain: row.normalizedDomain,
    status: row.status
  };
}

async function findMerchantDomain() {
  if (process.env.MERCHANT_DOMAIN_ID) {
    return prisma.merchantDomain.findUnique({ where: { id: process.env.MERCHANT_DOMAIN_ID } });
  }

  const domain = process.env.DOMAIN || process.env.MOCK_DOMAIN;
  if (domain) {
    return prisma.merchantDomain.findUnique({ where: { normalizedDomain: domain.trim().toLowerCase() } });
  }

  return prisma.merchantDomain.findFirst({
    where: {
      normalizedDomain: { in: DEFAULT_CANDIDATE_DOMAINS },
      status: { in: ["FAILED", "PAYMENT_REQUIRED", "REGISTERING"] }
    },
    orderBy: { updatedAt: "desc" }
  });
}

async function postDomainEvent(apiBase, internalSecret, body) {
  const response = await fetch(`${apiBase}/v1/internal/provisioning/domain-events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": internalSecret
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  return {
    ok: response.ok,
    status: response.status,
    payload
  };
}

function buildEvents(domainRow) {
  const base = {
    merchantId: domainRow.merchantId,
    storefrontId: domainRow.storefrontId || null,
    merchantDomainId: domainRow.id,
    domain: domainRow.normalizedDomain
  };

  const mockResellerClub = {
    entityId: "mock-rc-entity-001",
    orderId: "mock-rc-order-001"
  };

  const mockCloudflare = {
    customHostnameId: "mock-cf-hostname-001",
    hostnameStatus: "active",
    sslStatus: "active",
    validationMethod: "http",
    verifiedAt: new Date().toISOString()
  };

  return [
    {
      label: "REGISTERING",
      body: {
        ...base,
        provider: "RESELLERCLUB",
        eventType: "MOCK_REGISTERING",
        status: "REGISTERING",
        safeMessage: "Mock domain registration started",
        idempotencyKey: `mock-domain:${domainRow.id}:REGISTERING`
      }
    },
    {
      label: "REGISTERED",
      body: {
        ...base,
        provider: "RESELLERCLUB",
        eventType: "MOCK_DOMAIN_REGISTERED",
        status: "REGISTERED",
        safeMessage: "Mock domain registered",
        resellerClubEntityId: mockResellerClub.entityId,
        resellerClubOrderId: mockResellerClub.orderId,
        providerReferenceId: mockResellerClub.orderId,
        responsePayload: { mockResellerClub },
        idempotencyKey: `mock-domain:${domainRow.id}:REGISTERED`
      }
    },
    {
      label: "CLOUDFLARE_PENDING",
      body: {
        ...base,
        provider: "CLOUDFLARE",
        eventType: "MOCK_CUSTOM_HOSTNAME_PENDING",
        status: "CLOUDFLARE_PENDING",
        safeMessage: "Mock custom hostname pending",
        cloudflareCustomHostnameId: mockCloudflare.customHostnameId,
        providerReferenceId: mockCloudflare.customHostnameId,
        responsePayload: { mockCloudflare },
        idempotencyKey: `mock-domain:${domainRow.id}:CLOUDFLARE_PENDING`
      }
    },
    {
      label: "SSL_PENDING",
      body: {
        ...base,
        provider: "CLOUDFLARE",
        eventType: "MOCK_SSL_PENDING",
        status: "SSL_PENDING",
        safeMessage: "Mock SSL pending",
        cloudflareCustomHostnameId: mockCloudflare.customHostnameId,
        sslStatus: "pending_validation",
        responsePayload: { mockCloudflare },
        idempotencyKey: `mock-domain:${domainRow.id}:SSL_PENDING`
      }
    },
    {
      label: "ACTIVE",
      body: {
        ...base,
        provider: "CLOUDFLARE",
        eventType: "MOCK_SSL_ACTIVE",
        status: "ACTIVE",
        safeMessage: "Mock domain active",
        cloudflareCustomHostnameId: mockCloudflare.customHostnameId,
        sslStatus: "active",
        responsePayload: { mockCloudflare },
        idempotencyKey: `mock-domain:${domainRow.id}:ACTIVE`
      }
    }
  ];
}

async function main() {
  const apiBase = readApiBase();
  const internalSecret = readInternalSecret();
  const domainRow = await findMerchantDomain();

  if (!domainRow) {
    throw new Error("No local mock MerchantDomain fixture found. Set MERCHANT_DOMAIN_ID or DOMAIN.");
  }

  console.log(JSON.stringify({
    apiBase,
    selectedDomain: safeDomainSummary(domainRow),
    secretConfigured: true
  }, null, 2));

  const events = buildEvents(domainRow);
  const results = [];

  for (const event of events) {
    const result = await postDomainEvent(apiBase, internalSecret, event.body);
    if (!result.ok) {
      throw new Error(`${event.label} writeback failed with HTTP ${result.status}: ${result.payload?.error || result.payload?.message || "unknown"}`);
    }
    results.push({
      label: event.label,
      httpStatus: result.status,
      eventId: result.payload.eventId,
      domainStatus: result.payload.status
    });
  }

  const duplicateActive = await postDomainEvent(apiBase, internalSecret, events.at(-1).body);
  if (!duplicateActive.ok) {
    throw new Error(`Duplicate ACTIVE idempotency check failed with HTTP ${duplicateActive.status}`);
  }

  const backwards = await postDomainEvent(apiBase, internalSecret, {
    ...events[1].body,
    idempotencyKey: `mock-domain:${domainRow.id}:BACKWARDS_REGISTERED`
  });

  if (backwards.ok || backwards.status !== 409) {
    throw new Error(`Expected backwards transition to be rejected with 409, got HTTP ${backwards.status}`);
  }

  console.log(JSON.stringify({
    ok: true,
    events: results,
    duplicateActive: {
      httpStatus: duplicateActive.status,
      domainStatus: duplicateActive.payload.status
    },
    backwardsTransition: {
      httpStatus: backwards.status,
      rejected: true
    }
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
