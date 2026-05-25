import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DomainStatus } from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import {
  approveAdminDomainRequest,
  checkAdminDomainActivationStatus,
  getAdminDomainDnsInstructions,
  getAdminDomainActivationOverview,
  linkAdminDomainStorefront,
  normalizeActivationDomain,
  rejectAdminDomainRequest,
  reviewAdminDomainRequest,
  startAdminDomainProviderSetup
} from "./domain-activation.service.js";

const themeJson = {
  primaryColor: "#0d597f",
  backgroundColor: "#f7f8f5",
  textColor: "#14212f",
  fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
  heroTitle: "Shipmastr Demo Store",
  heroSubtitle: "A controlled storefront activation test.",
  ctaLabel: "Visit store"
};

function makeActivationClient() {
  const now = new Date("2026-05-23T10:00:00.000Z");
  const state = {
    merchants: new Map([
      ["merchant_1", { id: "merchant_1", name: "Demo Merchant", email: "ops@example.test" }]
    ]),
    storefronts: new Map([
      ["storefront_1", { id: "storefront_1", merchantId: "merchant_1", name: "Shipmastr Demo Store", createdAt: now, updatedAt: now }]
    ]),
    settings: new Map([
      ["storefront_1", { id: "settings_1", storefrontId: "storefront_1", themeJson, createdAt: now, updatedAt: now }]
    ]),
    storefrontDomains: new Map<string, any>(),
    merchantDomains: new Map<string, any>(),
    events: [] as any[],
    auditLogs: [] as any[]
  };

  function selectObject(row: any, select?: Record<string, boolean>) {
    if (!row || !select) return row;
    return Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, row[key]]));
  }

  function storefrontWithIncludes(id: string, include?: any, select?: any) {
    const storefront = state.storefronts.get(id);
    if (!storefront) return null;
    if (select) return selectObject(storefront, select);
    const row: any = { ...storefront };
    if (include?.merchant) row.merchant = state.merchants.get(storefront.merchantId) || null;
    if (include?.settings) row.settings = state.settings.get(id) || null;
    return row;
  }

  function storefrontDomainRow(domainOrId: string, where: any, include?: any, select?: any) {
    const row = where.domain
      ? state.storefrontDomains.get(domainOrId)
      : Array.from(state.storefrontDomains.values()).find((item) => item.id === domainOrId);
    if (!row) return null;
    if (select) return selectObject(row, select);
    const result: any = { ...row };
    if (include?.storefront) {
      result.storefront = storefrontWithIncludes(row.storefrontId, include.storefront.include);
    }
    return result;
  }

  const client: any = {
    storefront: {
      async findUnique({ where, include, select }: any) {
        return storefrontWithIncludes(where.id, include, select);
      }
    },
    merchantDomain: {
      async findUnique({ where }: any) {
        return state.merchantDomains.get(where.normalizedDomain) || null;
      },
      async update({ where, data }: any) {
        const existing = Array.from(state.merchantDomains.values()).find((item) => item.id === where.id);
        if (!existing) return null;
        const updated = { ...existing, ...data, updatedAt: now };
        state.merchantDomains.set(updated.normalizedDomain, updated);
        return updated;
      }
    },
    storefrontDomain: {
      async findUnique({ where, include, select }: any) {
        const key = where.domain || where.id;
        return storefrontDomainRow(key, where, include, select);
      },
      async updateMany({ where, data }: any) {
        let count = 0;
        for (const [domain, row] of state.storefrontDomains.entries()) {
          if (row.storefrontId === where.storefrontId) {
            state.storefrontDomains.set(domain, { ...row, ...data, updatedAt: now });
            count += 1;
          }
        }
        return { count };
      },
      async upsert({ where, update, create }: any) {
        const existing = state.storefrontDomains.get(where.domain);
        const row = existing
          ? { ...existing, ...update, updatedAt: now }
          : {
              id: `storefront_domain_${state.storefrontDomains.size + 1}`,
              storefrontId: create.storefrontId,
              domain: create.domain,
              status: create.status,
              isPrimary: create.isPrimary,
              verificationStatus: null,
              dnsTarget: null,
              cloudflareCustomHostnameId: null,
              sslStatus: null,
              failureReason: null,
              lastCheckedAt: create.lastCheckedAt || null,
              createdAt: now,
              updatedAt: now
            };
        state.storefrontDomains.set(where.domain, row);
        return row;
      }
    },
    domainProvisioningEvent: {
      async create({ data }: any) {
        const row = { id: `event_${state.events.length + 1}`, ...data, createdAt: now };
        state.events.push(row);
        return row;
      }
    },
    auditLog: {
      async create({ data }: any) {
        const row = { id: `audit_${state.auditLogs.length + 1}`, ...data, createdAt: now };
        state.auditLogs.push(row);
        return row;
      }
    }
  };

  return { client, state, now };
}

function makeStatusCheckAdapters(overrides: Partial<{
  cname: string[];
  a: string[];
  ns: string[];
  soa: string | null;
  httpStatus: number | null;
  httpsStatus: number | null;
  workerShimHeaderPresent: boolean;
  googleFrontend404: boolean;
  hostingerDetected: boolean;
  apiResponseDetected: boolean;
  expectedRendererResponse: boolean;
  cloudflareStatus: string;
  cloudflareSslStatus: string | null;
}> = {}) {
  return {
    dns: {
      async cname() {
        return overrides.cname || [];
      },
      async a() {
        return overrides.a || [];
      },
      async ns() {
        return overrides.ns || [];
      },
      async soa() {
        return overrides.soa ?? null;
      }
    },
    storefront: {
      async check() {
        return {
          httpStatus: overrides.httpStatus ?? 200,
          httpsStatus: overrides.httpsStatus ?? 200,
          workerShimHeaderPresent: overrides.workerShimHeaderPresent ?? true,
          workerShimHeaderValue: overrides.workerShimHeaderPresent === false ? null : "cloudflare-worker",
          googleFrontend404: Boolean(overrides.googleFrontend404),
          hostingerDetected: Boolean(overrides.hostingerDetected),
          apiResponseDetected: Boolean(overrides.apiResponseDetected),
          expectedRendererResponse: overrides.expectedRendererResponse ?? true
        };
      }
    },
    cloudflare: {
      async check() {
        return {
          checked: false,
          status: overrides.cloudflareStatus || "not_checked_auth_missing",
          sslStatus: overrides.cloudflareSslStatus ?? "active",
          validationMethod: null,
          validationRecordPresence: null
        };
      }
    }
  };
}

describe("admin domain activation workflow", () => {
  it("mounts activation routes behind the existing admin domains guard", () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");
    const domainRoutes = readFileSync("src/modules/domains/domains.routes.ts", "utf8");

    assert.match(routes, /apiRouter\.use\("\/admin\/domains", requireAdminJwt, adminDomainsRouter\);/);
    assert.match(domainRoutes, /adminDomainsRouter\.get\("\/:domain\/activation"/);
    assert.match(domainRoutes, /adminDomainsRouter\.post\("\/:domain\/link-storefront"/);
    assert.match(domainRoutes, /adminDomainsRouter\.post\("\/:domain\/check-status"/);
    assert.match(domainRoutes, /adminDomainsRouter\.post\("\/:domain\/review"/);
    assert.match(domainRoutes, /adminDomainsRouter\.post\("\/:domain\/approve"/);
    assert.match(domainRoutes, /adminDomainsRouter\.post\("\/:domain\/reject"/);
    assert.match(domainRoutes, /adminDomainsRouter\.post\("\/:domain\/start-provider-setup"/);
    assert.match(domainRoutes, /adminDomainsRouter\.get\("\/:domain\/dns-instructions"/);
  });

  it("normalizes exact activation hostnames without stripping www", () => {
    assert.equal(normalizeActivationDomain(" HTTPS://WWW.SHIPMASTR.CO.IN/path "), "www.shipmastr.co.in");
    assert.equal(normalizeActivationDomain("brand.example.in."), "brand.example.in");
    assert.throws(() => normalizeActivationDomain("bad host"), /INVALID_DOMAIN/);
    assert.throws(() => normalizeActivationDomain("api.shipmastr.com"), /DOMAIN_RESERVED_FOR_SHIPMASTR/);
    assert.throws(() => normalizeActivationDomain("demo.run.app"), /DOMAIN_RESERVED_FOR_SHIPMASTR/);
  });

  it("returns a safe intake state for an unknown domain", async () => {
    const { client } = makeActivationClient();
    const result = await getAdminDomainActivationOverview({ domain: "unknown.example.in", client });

    assert.equal(result.normalizedDomain, "unknown.example.in");
    assert.equal(result.storefrontDomainStatus, "NOT_FOUND");
    assert.equal(result.storefrontLookupStatus, "NOT_FOUND");
    assert.equal(result.activationState, "STOREFRONT_MAPPING_PENDING");
    assert.equal(JSON.stringify(result).includes("api-key"), false);
  });

  it("keeps requested merchant domains in admin review before provider setup starts", async () => {
    const { client, state, now } = makeActivationClient();
    state.merchantDomains.set("merchant-smoke-test.example.in", {
      id: "merchant_domain_requested",
      merchantId: "merchant_1",
      storefrontId: "storefront_1",
      domain: "merchant-smoke-test.example.in",
      normalizedDomain: "merchant-smoke-test.example.in",
      status: DomainStatus.REQUESTED,
      provider: "MANUAL",
      source: "EXTERNAL_CONNECTED",
      cloudflareCustomHostnameId: null,
      cloudflareCustomHostnameStatus: null,
      dnsValidationStatus: null,
      sslStatus: null,
      lastCheckedAt: now,
      updatedAt: now
    });

    const result = await getAdminDomainActivationOverview({ domain: "merchant-smoke-test.example.in", client });

    assert.equal(result.activationState, "REVIEW_REQUIRED");
    assert.equal(result.nextAction.label, "Review required");
    assert.equal(result.nextAction.actionKey, "ADMIN_REVIEW");
    assert.equal(result.storefrontDomainStatus, "NOT_FOUND");
    assert.equal(result.diagnostics.merchantDomain?.status, DomainStatus.REQUESTED);
  });

  it("moves a merchant request through review and approval without provider calls", async () => {
    const { client, state, now } = makeActivationClient();
    state.merchantDomains.set("merchant-smoke-test.example.in", {
      id: "merchant_domain_requested",
      merchantId: "merchant_1",
      storefrontId: "storefront_1",
      domain: "merchant-smoke-test.example.in",
      normalizedDomain: "merchant-smoke-test.example.in",
      status: DomainStatus.REQUESTED,
      provider: "MANUAL",
      source: "EXTERNAL_CONNECTED",
      validationRecords: { requestStatus: "PENDING_REVIEW", intent: "CONNECT_EXISTING_DOMAIN" },
      cloudflareCustomHostnameId: null,
      cloudflareCustomHostnameStatus: null,
      dnsValidationStatus: null,
      sslStatus: null,
      lastCheckedAt: now,
      updatedAt: now
    });

    const reviewed = await reviewAdminDomainRequest({
      domain: "merchant-smoke-test.example.in",
      actorId: "admin_1",
      note: "Looks safe for first merchant workflow.",
      client
    });

    assert.equal(reviewed.activationState, "REVIEW_REQUIRED");
    assert.equal(reviewed.workflow.state, "ADMIN_REVIEW_REQUIRED");
    assert.equal(state.merchantDomains.get("merchant-smoke-test.example.in")?.status, DomainStatus.REQUESTED);

    const approved = await approveAdminDomainRequest({
      domain: "merchant-smoke-test.example.in",
      actorId: "admin_1",
      note: "Approved for setup.",
      client
    });

    const row = state.merchantDomains.get("merchant-smoke-test.example.in");
    assert.equal(approved.activationState, "ADMIN_APPROVED");
    assert.equal(approved.workflow.providerActionsAllowed, true);
    assert.equal(row?.status, DomainStatus.APPROVAL_REQUIRED);
    assert.equal(row?.provider, "MANUAL");
    assert.equal(state.events.map((event) => event.eventType).includes("DOMAIN_ACTIVATION_REVIEWED"), true);
    assert.equal(state.events.map((event) => event.eventType).includes("DOMAIN_ACTIVATION_APPROVED"), true);
    assert.equal(JSON.stringify(state.events).includes("cloudflareMutation\":true"), false);
  });

  it("rejects a merchant request with a reason and keeps it provider-safe", async () => {
    const { client, state, now } = makeActivationClient();
    state.merchantDomains.set("merchant-smoke-test.example.in", {
      id: "merchant_domain_requested",
      merchantId: "merchant_1",
      storefrontId: "storefront_1",
      domain: "merchant-smoke-test.example.in",
      normalizedDomain: "merchant-smoke-test.example.in",
      status: DomainStatus.REQUESTED,
      provider: "MANUAL",
      source: "EXTERNAL_CONNECTED",
      validationRecords: { requestStatus: "PENDING_REVIEW", intent: "CONNECT_EXISTING_DOMAIN" },
      cloudflareCustomHostnameId: null,
      cloudflareCustomHostnameStatus: null,
      dnsValidationStatus: null,
      sslStatus: null,
      lastCheckedAt: now,
      updatedAt: now
    });

    const result = await rejectAdminDomainRequest({
      domain: "merchant-smoke-test.example.in",
      actorId: "admin_1",
      reason: "Merchant must confirm ownership first.",
      client
    });

    const row = state.merchantDomains.get("merchant-smoke-test.example.in");
    assert.equal(result.activationState, "FAILED_NEEDS_REVIEW");
    assert.equal(result.workflow.rejected, true);
    assert.equal(row?.status, DomainStatus.FAILED);
    assert.equal(row?.provider, "MANUAL");
    assert.equal(state.events[0]?.eventType, "DOMAIN_ACTIVATION_REJECTED");
    assert.equal(state.events[0]?.provider, "MANUAL");
    assert.equal(JSON.stringify(result).includes("Cloudflare"), false);
  });

  it("requires approval before provider setup can be marked started", async () => {
    const { client, state, now } = makeActivationClient();
    state.merchantDomains.set("merchant-smoke-test.example.in", {
      id: "merchant_domain_requested",
      merchantId: "merchant_1",
      storefrontId: "storefront_1",
      domain: "merchant-smoke-test.example.in",
      normalizedDomain: "merchant-smoke-test.example.in",
      status: DomainStatus.REQUESTED,
      provider: "MANUAL",
      source: "EXTERNAL_CONNECTED",
      validationRecords: { requestStatus: "PENDING_REVIEW", intent: "CONNECT_EXISTING_DOMAIN" },
      cloudflareCustomHostnameId: null,
      cloudflareCustomHostnameStatus: null,
      dnsValidationStatus: null,
      sslStatus: null,
      lastCheckedAt: now,
      updatedAt: now
    });

    await assert.rejects(
      () => startAdminDomainProviderSetup({
        domain: "merchant-smoke-test.example.in",
        confirmDomain: "merchant-smoke-test.example.in",
        actorId: "admin_1",
        client
      }),
      /DOMAIN_REQUEST_APPROVAL_REQUIRED/
    );

    assert.equal(state.merchantDomains.get("merchant-smoke-test.example.in")?.status, DomainStatus.REQUESTED);
    assert.equal(state.events.length, 0);
  });

  it("marks provider setup started only after approval and exposes DNS instructions then", async () => {
    const { client, state, now } = makeActivationClient();
    state.merchantDomains.set("merchant-smoke-test.example.in", {
      id: "merchant_domain_requested",
      merchantId: "merchant_1",
      storefrontId: "storefront_1",
      domain: "merchant-smoke-test.example.in",
      normalizedDomain: "merchant-smoke-test.example.in",
      status: DomainStatus.APPROVAL_REQUIRED,
      provider: "MANUAL",
      source: "EXTERNAL_CONNECTED",
      validationRecords: {
        requestStatus: "APPROVED",
        intent: "CONNECT_EXISTING_DOMAIN",
        activationWorkflow: { state: "ADMIN_APPROVED" }
      },
      cloudflareCustomHostnameId: null,
      cloudflareCustomHostnameStatus: null,
      dnsValidationStatus: null,
      sslStatus: null,
      lastCheckedAt: now,
      updatedAt: now
    });

    const beforeInstructions = await getAdminDomainDnsInstructions({ domain: "merchant-smoke-test.example.in", client });
    assert.equal(beforeInstructions.available, false);
    assert.match(beforeInstructions.nextAction, /not available until provider setup/i);

    const result = await startAdminDomainProviderSetup({
      domain: "merchant-smoke-test.example.in",
      confirmDomain: "merchant-smoke-test.example.in",
      actorId: "admin_1",
      note: "Start controlled setup.",
      dnsInstructions: {
        available: true,
        summary: "Add the connection record when instructed by Shipmastr.",
        records: [{
          type: "CNAME",
          name: "merchant-smoke-test",
          value: "storefront-origin.shipmastr.com",
          ttl: "default",
          purpose: "Storefront connection"
        }]
      },
      client
    });

    const row = state.merchantDomains.get("merchant-smoke-test.example.in");
    const instructions = await getAdminDomainDnsInstructions({ domain: "merchant-smoke-test.example.in", client });
    assert.equal(result.activationState, "DNS_INSTRUCTIONS_AVAILABLE");
    assert.equal(result.workflow.providerSetupStarted, true);
    assert.equal(row?.status, DomainStatus.CLOUDFLARE_PENDING);
    assert.equal(row?.provider, "CLOUDFLARE");
    assert.equal(instructions.available, true);
    assert.equal(instructions.instructions?.records?.[0]?.type, "CNAME");
    assert.equal(state.events[0]?.eventType, "DOMAIN_PROVIDER_SETUP_STARTED");
    assert.equal(state.events[0]?.payload.providerMutation, false);
    assert.equal(state.events[0]?.payload.dnsChanged, false);
  });

  it("keeps provider-started domains in a pending-instructions state when records are missing", async () => {
    const { client, state, now } = makeActivationClient();
    state.merchantDomains.set("merchant-smoke-test.example.in", {
      id: "merchant_domain_requested",
      merchantId: "merchant_1",
      storefrontId: "storefront_1",
      domain: "merchant-smoke-test.example.in",
      normalizedDomain: "merchant-smoke-test.example.in",
      status: DomainStatus.APPROVAL_REQUIRED,
      provider: "MANUAL",
      source: "EXTERNAL_CONNECTED",
      validationRecords: {
        requestStatus: "APPROVED",
        intent: "CONNECT_EXISTING_DOMAIN",
        activationWorkflow: { state: "ADMIN_APPROVED" }
      },
      cloudflareCustomHostnameId: null,
      cloudflareCustomHostnameStatus: null,
      dnsValidationStatus: null,
      sslStatus: null,
      lastCheckedAt: now,
      updatedAt: now
    });

    const result = await startAdminDomainProviderSetup({
      domain: "merchant-smoke-test.example.in",
      confirmDomain: "merchant-smoke-test.example.in",
      actorId: "admin_1",
      note: "Start controlled setup.",
      client
    });

    const instructions = await getAdminDomainDnsInstructions({ domain: "merchant-smoke-test.example.in", client });
    assert.equal(result.activationState, "PROVIDER_SETUP_STARTED");
    assert.equal(result.workflow.providerSetupStarted, true);
    assert.equal(result.workflow.dnsInstructionsAvailable, false);
    assert.equal(result.workflow.dnsInstructionsPending, true);
    assert.equal(instructions.available, false);
    assert.equal(instructions.instructions, null);
    assert.match(instructions.nextAction, /pending preparation/i);
    assert.equal(state.events[0]?.payload.providerMutation, false);
    assert.equal(state.events[0]?.payload.cloudflareMutation, false);
    assert.equal(state.events[0]?.payload.workerRouteChanged, false);
  });

  it("links a storefront with an exact db-only upsert and audit event", async () => {
    const { client, state } = makeActivationClient();
    const result = await linkAdminDomainStorefront({
      pathDomain: "www.shipmastr.co.in",
      domain: "www.shipmastr.co.in",
      storefrontId: "storefront_1",
      isPrimary: true,
      client
    });

    const row = state.storefrontDomains.get("www.shipmastr.co.in");
    assert.ok(row);
    assert.equal(row.domain, "www.shipmastr.co.in");
    assert.equal(row.storefrontId, "storefront_1");
    assert.equal(row.status, DomainStatus.REQUESTED);
    assert.equal(result.diagnostics.storefrontDomain?.domain, "www.shipmastr.co.in");
    assert.equal(state.events.length, 1);
    const event = state.events[0];
    assert.ok(event);
    assert.equal(event.eventType, "STOREFRONT_DOMAIN_LINKED");
    assert.equal(event.provider, "MANUAL");
    assert.equal(event.payload.providerMutation, false);
  });

  it("rejects mismatched link-storefront domains before writing", async () => {
    const { client, state } = makeActivationClient();

    await assert.rejects(
      () => linkAdminDomainStorefront({
        pathDomain: "www.shipmastr.co.in",
        domain: "other.example.in",
        storefrontId: "storefront_1",
        client
      }),
      (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.message, "DOMAIN_MISMATCH");
        return true;
      }
    );

    assert.equal(state.storefrontDomains.size, 0);
    assert.equal(state.events.length, 0);
  });

  it("reports live when www.shipmastr.co.in has an active storefront mapping", async () => {
    const { client, state, now } = makeActivationClient();
    state.storefrontDomains.set("www.shipmastr.co.in", {
      id: "storefront_domain_live",
      storefrontId: "storefront_1",
      domain: "www.shipmastr.co.in",
      status: DomainStatus.ACTIVE,
      isPrimary: true,
      verificationStatus: "accepted",
      dnsTarget: "storefront-origin.shipmastr.com",
      cloudflareCustomHostnameId: "cf_id_internal",
      sslStatus: "active",
      failureReason: null,
      lastCheckedAt: now,
      createdAt: now,
      updatedAt: now
    });

    const result = await getAdminDomainActivationOverview({ domain: "www.shipmastr.co.in", client });

    assert.equal(result.activationState, "LIVE");
    assert.equal(result.storefrontLookupStatus, "ACTIVE");
    assert.equal(result.storefront?.name, "Shipmastr Demo Store");
    assert.equal(result.diagnostics.storefrontLookup?.storeName, "Shipmastr Demo Store");
  });

  it("runs a read-only status check for a live mapped domain and writes an audit log", async () => {
    const { client, state, now } = makeActivationClient();
    state.storefrontDomains.set("www.shipmastr.co.in", {
      id: "storefront_domain_live",
      storefrontId: "storefront_1",
      domain: "www.shipmastr.co.in",
      status: DomainStatus.ACTIVE,
      isPrimary: true,
      verificationStatus: "accepted",
      dnsTarget: "storefront-origin.shipmastr.com",
      cloudflareCustomHostnameId: "cf_id_internal",
      sslStatus: "active",
      failureReason: null,
      lastCheckedAt: now,
      createdAt: now,
      updatedAt: now
    });

    const result = await checkAdminDomainActivationStatus({
      domain: "www.shipmastr.co.in",
      actorId: "admin_1",
      client,
      adapters: makeStatusCheckAdapters({
        cname: ["storefront-origin.shipmastr.com"],
        a: ["104.21.26.198"],
        ns: ["skymax1326907.mercury.orderbox-dns.com"],
        soa: "skymax1326907.mercury.orderbox-dns.com hostmaster.shipmastr.co.in"
      })
    });

    assert.equal(result.activationState, "LIVE");
    assert.equal(result.dbMapping.exists, true);
    assert.equal(result.publicLookup.status, "ACTIVE");
    assert.equal(result.storefront.workerShimHeaderPresent, true);
    assert.equal(result.tls.httpsSucceeded, true);
    assert.equal(result.cloudflare.status, "not_checked_auth_missing");
    assert.equal(result.warnings.includes("CLOUDFLARE_AUTH_MISSING_NON_FATAL"), true);
    assert.equal(state.events.length, 0);
    assert.equal(state.auditLogs.length, 1);
    assert.equal(state.auditLogs[0]?.action, "DOMAIN_STATUS_CHECKED");
    assert.equal(state.auditLogs[0]?.metadata.providerMutation, false);
    assert.equal(state.auditLogs[0]?.metadata.cloudflareMutation, false);
    assert.equal(state.auditLogs[0]?.metadata.resellerClubMutation, false);
  });

  it("keeps read-only status checks for requested domains in review before provider setup starts", async () => {
    const { client, state, now } = makeActivationClient();
    state.merchantDomains.set("merchant-smoke-test.example.in", {
      id: "merchant_domain_requested",
      merchantId: "merchant_1",
      storefrontId: "storefront_1",
      domain: "merchant-smoke-test.example.in",
      normalizedDomain: "merchant-smoke-test.example.in",
      status: DomainStatus.REQUESTED,
      provider: "MANUAL",
      source: "EXTERNAL_CONNECTED",
      cloudflareCustomHostnameId: null,
      cloudflareCustomHostnameStatus: null,
      dnsValidationStatus: null,
      sslStatus: null,
      lastCheckedAt: now,
      updatedAt: now
    });

    const result = await checkAdminDomainActivationStatus({
      domain: "merchant-smoke-test.example.in",
      actorId: "admin_1",
      client,
      adapters: makeStatusCheckAdapters({
        cname: [],
        a: [],
        httpsStatus: 404,
        workerShimHeaderPresent: false,
        expectedRendererResponse: false
      })
    });

    assert.equal(result.activationState, "REVIEW_REQUIRED");
    assert.equal(result.nextAction.label, "Review required");
    assert.equal(result.nextAction.actionKey, "ADMIN_REVIEW");
    assert.equal(result.dbMapping.exists, false);
    assert.equal(result.warnings.includes("STOREFRONT_DOMAIN_ROW_MISSING"), true);
    assert.equal(JSON.stringify(state.merchantDomains.get("merchant-smoke-test.example.in")?.validationRecords || {}).includes("dnsInstructions"), false);
    assert.equal(state.events.length, 0);
    assert.equal(state.auditLogs.length, 1);
    assert.equal(state.auditLogs[0]?.action, "DOMAIN_STATUS_CHECKED");
    assert.equal(state.auditLogs[0]?.metadata.activationState, "REVIEW_REQUIRED");
    assert.equal(state.auditLogs[0]?.metadata.providerMutation, false);
  });

  it("returns a safe pending state for an unknown domain without provider mutations", async () => {
    const { client, state } = makeActivationClient();

    const result = await checkAdminDomainActivationStatus({
      domain: "unknown.example.in",
      client,
      adapters: makeStatusCheckAdapters({
        cname: [],
        a: [],
        httpsStatus: 404,
        workerShimHeaderPresent: false,
        expectedRendererResponse: false
      })
    });

    assert.equal(result.activationState, "STOREFRONT_MAPPING_PENDING");
    assert.equal(result.dbMapping.exists, false);
    assert.equal(result.publicLookup.status, "NOT_FOUND");
    assert.equal(result.warnings.includes("STOREFRONT_DOMAIN_ROW_MISSING"), true);
    assert.equal(result.warnings.includes("DNS_TARGET_MISSING"), true);
    assert.equal(result.cloudflare.status, "not_checked_auth_missing");
    assert.equal(state.events.length, 0);
    assert.equal(state.auditLogs.length, 1);
    assert.equal(JSON.stringify(result).includes("api-key"), false);
  });
});
