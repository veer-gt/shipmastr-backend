import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { HttpError } from "../../lib/httpError.js";
import { createPublicStorefrontLookupHandler, createStorefrontLookupHandler } from "./storefronts.routes.js";
import {
  addAdminStorefrontDomain,
  createAdminStorefront,
  getAdminStorefront,
  getStorefrontByDomain,
  listAdminStorefrontDomainEvents,
  listAdminStorefrontDomains,
  listAdminStorefronts,
  normalizeStorefrontDomain,
  redactStorefrontEventPayload,
  storefrontTestFixtures,
  updateAdminStorefrontDomainStatus,
  updateAdminStorefrontSettings,
  type StorefrontLookupClient
} from "./storefronts.service.js";

type StorefrontDomainLookupRow = Awaited<
  ReturnType<StorefrontLookupClient["storefrontDomain"]["findUnique"]>
>;

function makeStorefrontLookupClient(overrides?: Record<string, StorefrontDomainLookupRow>): StorefrontLookupClient {
  const rows = new Map<string, StorefrontDomainLookupRow>(
    storefrontTestFixtures.map((fixture) => [
      fixture.domain,
      {
        domain: fixture.domain,
        status: fixture.domainStatus,
        storefront: {
          id: fixture.tenantId,
          merchantId: fixture.merchantId,
          name: fixture.storeName,
          settings: {
            themeJson: fixture.themeJson
          }
        }
      }
    ])
  );

  for (const [domain, row] of Object.entries(overrides || {})) {
    rows.set(domain, row);
  }

  return {
  storefrontDomain: {
      async findUnique(input) {
        return rows.get(input.where.domain) || null;
      }
    }
  };
}

async function invokeLookup(domain: string, client = makeStorefrontLookupClient()) {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    }
  };

  await createStorefrontLookupHandler(client)({ params: { domain } } as any, response as any);
  return response;
}

async function invokePublicLookup(domain: string, client = makeStorefrontLookupClient()) {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    }
  };

  await createPublicStorefrontLookupHandler(client)({ query: { domain } } as any, response as any);
  return response;
}

const adminThemeJson = {
  primaryColor: "#2dd4bf",
  backgroundColor: "#080b10",
  textColor: "#f8fafc",
  fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
  heroTitle: "Demo hosted storefront",
  heroSubtitle: "A local Shipmastr storefront for backend smoke tests.",
  ctaLabel: "Visit store"
};

function makeAdminStorefrontClient() {
  const state = {
    merchants: new Map([
      ["merchant_1", { id: "merchant_1" }]
    ]),
    storefronts: new Map<string, any>(),
    settings: new Map<string, any>(),
    domains: new Map<string, any>(),
    events: [] as any[]
  };

  function now() {
    return new Date("2026-05-19T10:00:00.000Z");
  }

  function selectObject(row: any, select?: Record<string, boolean>) {
    if (!row || !select) return row;
    return Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, row[key]]));
  }

  function storefrontRow(id: string, include?: any, select?: any) {
    const row = state.storefronts.get(id);
    if (!row) return null;
    if (select) return selectObject(row, select);

    const result = { ...row };
    if (include?.settings) {
      result.settings = state.settings.get(id) || null;
    }
    if (include?.domains) {
      result.domains = Array.from(state.domains.values())
        .filter((domain) => domain.storefrontId === id)
        .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.createdAt.getTime() - b.createdAt.getTime());
    }
    return result;
  }

  const client: any = {
    merchant: {
      async findUnique({ where, select }: any) {
        return selectObject(state.merchants.get(where.id), select);
      }
    },
    storefront: {
      async create({ data, include }: any) {
        const id = data.id || `storefront_${state.storefronts.size + 1}`;
        const row = {
          id,
          merchantId: data.merchantId,
          name: data.name,
          createdAt: now(),
          updatedAt: now()
        };
        state.storefronts.set(id, row);
        if (data.settings?.create) {
          state.settings.set(id, {
            id: `settings_${id}`,
            storefrontId: id,
            themeJson: data.settings.create.themeJson,
            createdAt: now(),
            updatedAt: now()
          });
        }
        return storefrontRow(id, include);
      },
      async findUnique({ where, include, select }: any) {
        return storefrontRow(where.id, include, select);
      },
      async findMany({ include }: any) {
        return Array.from(state.storefronts.keys())
          .map((id) => storefrontRow(id, include))
          .sort((a, b) => (b as any).createdAt.getTime() - (a as any).createdAt.getTime());
      }
    },
    storefrontSettings: {
      async upsert({ where, update, create }: any) {
        const existing = state.settings.get(where.storefrontId);
        const row = existing
          ? { ...existing, ...update, updatedAt: now() }
          : {
              id: create.id || `settings_${where.storefrontId}`,
              storefrontId: create.storefrontId,
              themeJson: create.themeJson,
              createdAt: now(),
              updatedAt: now()
            };
        state.settings.set(where.storefrontId, row);
        return row;
      }
    },
    storefrontProduct: {
      updateMany: async () => ({ count: 0 }),
      upsert: async (args: any) => ({
        id: args?.create?.id ?? args?.where?.id ?? "test_storefront_product",
        ...(args?.create ?? {}),
        ...(args?.update ?? {})
      }),
      create: async (args: any) => ({
        id: args?.data?.id ?? "test_storefront_product",
        ...(args?.data ?? {})
      }),
      createMany: async (args: any) => ({
        count: Array.isArray(args?.data) ? args.data.length : 0
      }),
      findFirst: async () => null,
      findMany: async () => [],
      deleteMany: async () => ({ count: 0 })
    },
    storefrontDomain: {
      async findMany({ where }: any) {
        return Array.from(state.domains.values())
          .filter((domain) => domain.storefrontId === where.storefrontId)
          .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.createdAt.getTime() - b.createdAt.getTime());
      },
      async findUnique({ where, select }: any) {
        const row = where.domain
          ? Array.from(state.domains.values()).find((domain) => domain.domain === where.domain)
          : state.domains.get(where.id);
        return selectObject(row || null, select);
      },
      async updateMany({ where, data }: any) {
        for (const [id, row] of state.domains.entries()) {
          if (row.storefrontId === where.storefrontId) {
            state.domains.set(id, { ...row, ...data, updatedAt: now() });
          }
        }
        return { count: 1 };
      },
      async create({ data }: any) {
        const id = data.id || `domain_${state.domains.size + 1}`;
        const row = {
          id,
          storefrontId: data.storefrontId,
          domain: data.domain,
          status: data.status,
          isPrimary: data.isPrimary,
          verificationStatus: null,
          dnsTarget: null,
          sslStatus: null,
          failureReason: null,
          lastCheckedAt: null,
          createdAt: now(),
          updatedAt: now(),
          cloudflareId: "cf_123_secret",
          customHostnameId: "hostname_secret",
          resellerClubId: "club_secret",
          providerId: "provider_secret",
          txtRecord: "txt_record_secret",
          txtValue: "txt_value_secret",
          token: "token_secret",
          secret: "secret_secret",
          rawPayload: "raw_payload_secret"
        };
        state.domains.set(id, row);
        return row;
      },
      async update({ where, data }: any) {
        const existing = state.domains.get(where.id);
        if (!existing) return null;
        const row = { ...existing, ...data, updatedAt: now() };
        state.domains.set(where.id, row);
        return row;
      }
    },
    domainProvisioningEvent: {
      async create({ data }: any) {
        const row = {
          id: `event_${state.events.length + 1}`,
          ...data,
          createdAt: now()
        };
        state.events.push(row);
        return row;
      },
      async findMany({ where }: any) {
        return state.events
          .filter((event) => event.storefrontId === where.storefrontId)
          .filter((event) => !where.storefrontDomainId || event.storefrontDomainId === where.storefrontDomainId)
          .slice()
          .reverse();
      }
    }
  };

  return { client, state };
}

describe("internal storefront renderer lookup", () => {
  it("mounts the Phase 3 storefront lookup without auth for renderer reads", () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");
    const storefrontRoutes = readFileSync("src/modules/storefronts/storefronts.routes.ts", "utf8");

    assert.match(routes, /apiRouter\.use\("\/internal\/storefronts", storefrontsRouter\);/);
    assert.match(routes, /apiRouter\.use\("\/storefronts", publicStorefrontsRouter\);/);
    assert.match(routes, /apiRouter\.use\("\/admin\/storefronts", requireAdminJwt, adminStorefrontsRouter\);/);
    assert.match(storefrontRoutes, /storefrontsRouter\.get\("\/:domain", lookupInternalStorefront\);/);
    assert.match(storefrontRoutes, /publicStorefrontsRouter\.get\("\/lookup", lookupPublicStorefront\);/);
    assert.match(storefrontRoutes, /adminStorefrontsRouter\.get\("\/", async \(req, res\) =>/);
    assert.match(storefrontRoutes, /adminStorefrontsRouter\.get\("\/:id\/domains"/);
    assert.match(storefrontRoutes, /adminStorefrontsRouter\.get\("\/:id\/domains\/:domainId\/events"/);
  });

  it("returns a public-safe storefront lookup shape for the renderer origin", async () => {
    const response = await invokePublicLookup("celvyawellness.in");

    assert.equal(response.statusCode, 200);
    assert.deepEqual(Object.keys(response.body as Record<string, unknown>).sort(), [
      "domain",
      "merchantId",
      "status",
      "storeName",
      "themeJson"
    ]);
    assert.equal((response.body as any).domain, "celvyawellness.in");
    assert.equal((response.body as any).merchantId, "merchant_celvya");
    assert.equal((response.body as any).status, "ACTIVE");
    assert.equal(JSON.stringify(response.body).includes("tenant_"), false);
    assert.equal(Object.hasOwn(response.body as Record<string, unknown>, "tenantId"), false);
    assert.equal(Object.hasOwn(response.body as Record<string, unknown>, "customHostnameId"), false);
    assert.equal(Object.hasOwn(response.body as Record<string, unknown>, "provider"), false);
    assert.equal(Object.hasOwn(response.body as Record<string, unknown>, "provisioningStatus"), false);
  });

  it("returns NOT_FOUND for missing public storefront lookup domains", async () => {
    const response = await invokePublicLookup("unknown.test");

    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.body, {
      status: "NOT_FOUND",
      error: "STOREFRONT_NOT_FOUND"
    });
  });

  it("returns the active storefront from Prisma-backed data", async () => {
    const response = await invokeLookup("celvyawellness.in");

    assert.equal(response.statusCode, 200);
    assert.equal((response.body as any).domain, "celvyawellness.in");
    assert.equal((response.body as any).status, "ACTIVE");
    assert.equal((response.body as any).storeName, "Celvya Wellness");
    assert.equal((response.body as any).themeJson.ctaLabel, "Explore the store");
  });

  it("maps pending domain statuses to PENDING_DOMAIN", async () => {
    const response = await invokeLookup("pending.shipmastr.store");

    assert.equal(response.statusCode, 200);
    assert.equal((response.body as any).domain, "pending.shipmastr.store");
    assert.equal((response.body as any).status, "PENDING_DOMAIN");
  });

  it("maps suspended domain statuses to SUSPENDED", async () => {
    const response = await invokeLookup("suspended.shipmastr.store");

    assert.equal(response.statusCode, 200);
    assert.equal((response.body as any).domain, "suspended.shipmastr.store");
    assert.equal((response.body as any).status, "SUSPENDED");
  });

  it("returns a stable 404 for unknown storefront domains", async () => {
    const response = await invokeLookup("non-existent-brand.com");

    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.body, {
      error: "STOREFRONT_NOT_FOUND"
    });
  });

  it("returns a validation error for malformed domains", async () => {
    const response = await invokeLookup("bad host!");

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.body, {
      error: "VALIDATION_ERROR"
    });
  });

  it("normalizes www domains to the attached storefront", async () => {
    const response = await invokeLookup("www.celvyawellness.in");

    assert.equal(response.statusCode, 200);
    assert.equal(normalizeStorefrontDomain(" www.celvyawellness.in "), "celvyawellness.in");
    assert.equal((await getStorefrontByDomain("www.celvyawellness.in", makeStorefrontLookupClient()))?.domain, "celvyawellness.in");
    assert.equal((response.body as any).domain, "celvyawellness.in");
  });

  it("prefers exact www storefront domain rows when present", async () => {
    const client = makeStorefrontLookupClient({
      "www.shipmastr.co.in": {
        domain: "www.shipmastr.co.in",
        status: "ACTIVE",
        storefront: {
          id: "storefront_demo_shipmastr_co_in",
          merchantId: "merchant_storefront_demo",
          name: "Shipmastr Demo Store",
          settings: {
            themeJson: {
              primaryColor: "#f97316",
              backgroundColor: "#100d08",
              textColor: "#fff8f0",
              fontFamily: "Inter",
              heroTitle: "Shipmastr controlled storefront",
              heroSubtitle: "A safe demo storefront for the first controlled custom-domain activation.",
              ctaLabel: "Storefront ready"
            }
          }
        }
      }
    });

    const response = await invokePublicLookup("www.shipmastr.co.in", client);

    assert.equal(response.statusCode, 200);
    assert.equal((response.body as any).domain, "www.shipmastr.co.in");
    assert.equal((response.body as any).merchantId, "merchant_storefront_demo");
    assert.equal((response.body as any).storeName, "Shipmastr Demo Store");
    assert.equal((response.body as any).status, "ACTIVE");
    assert.equal(Object.hasOwn(response.body as Record<string, unknown>, "tenantId"), false);
    assert.equal(JSON.stringify(response.body).includes("customHostnameId"), false);
  });

  it("falls back from an apex lookup to a www storefront row", async () => {
    const client = makeStorefrontLookupClient({
      "www.shipmastr.co.in": {
        domain: "www.shipmastr.co.in",
        status: "ACTIVE",
        storefront: {
          id: "storefront_demo_shipmastr_co_in",
          merchantId: "merchant_storefront_demo",
          name: "Shipmastr Demo Store",
          settings: {
            themeJson: {
              primaryColor: "#f97316",
              backgroundColor: "#100d08",
              textColor: "#fff8f0",
              fontFamily: "Inter",
              heroTitle: "Shipmastr controlled storefront",
              heroSubtitle: "A safe demo storefront for the first controlled custom-domain activation.",
              ctaLabel: "Storefront ready"
            }
          }
        }
      }
    });

    const response = await invokePublicLookup("shipmastr.co.in", client);

    assert.equal(response.statusCode, 200);
    assert.equal((response.body as any).domain, "www.shipmastr.co.in");
    assert.equal((response.body as any).merchantId, "merchant_storefront_demo");
    assert.equal((response.body as any).storeName, "Shipmastr Demo Store");
    assert.equal(Object.hasOwn(response.body as Record<string, unknown>, "tenantId"), false);
  });

  it("returns CONFIG_ERROR when theme settings are missing", async () => {
    const response = await invokeLookup(
      "broken-theme.test",
      makeStorefrontLookupClient({
        "broken-theme.test": {
          domain: "broken-theme.test",
          status: "ACTIVE",
          storefront: {
            id: "tenant_broken",
            merchantId: "merchant_broken",
            name: "Broken Theme",
            settings: null
          }
        }
      })
    );

    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.body, {
      error: "CONFIG_ERROR"
    });
  });

  it("returns CONFIG_ERROR when a required theme field is invalid", async () => {
    const response = await invokeLookup(
      "invalid-theme.test",
      makeStorefrontLookupClient({
        "invalid-theme.test": {
          domain: "invalid-theme.test",
          status: "ACTIVE",
          storefront: {
            id: "tenant_invalid",
            merchantId: "merchant_invalid",
            name: "Invalid Theme",
            settings: {
              themeJson: {
                primaryColor: "#000000",
                backgroundColor: "#ffffff",
                textColor: "#111111",
                fontFamily: "Inter",
                heroTitle: "Invalid",
                heroSubtitle: "Missing CTA"
              }
            }
          }
        }
      })
    );

    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.body, {
      error: "CONFIG_ERROR"
    });
  });
});

describe("admin storefront management", () => {
  it("creates a storefront with settings and writes a provisioning event", async () => {
    const { client, state } = makeAdminStorefrontClient();
    const result = await createAdminStorefront({
      merchantId: "merchant_1",
      name: "Celvya Wellness",
      themeJson: adminThemeJson,
      client
    });

    assert.equal(result.name, "Celvya Wellness");
    assert.ok(result.settings);
    assert.equal(result.settings.themeJson.ctaLabel, "Visit store");
    assert.equal(state.events.at(-1).eventType, "STOREFRONT_CREATED");
  });

  it("gets an admin storefront detail", async () => {
    const { client } = makeAdminStorefrontClient();
    const created = await createAdminStorefront({
      merchantId: "merchant_1",
      name: "Celvya Wellness",
      themeJson: adminThemeJson,
      client
    });

    const result = await getAdminStorefront({ id: created.id, client });
    assert.equal(result.id, created.id);
    assert.deepEqual(result.domains, []);
  });

  it("updates storefront settings and writes a provisioning event", async () => {
    const { client, state } = makeAdminStorefrontClient();
    const created = await createAdminStorefront({
      merchantId: "merchant_1",
      name: "Celvya Wellness",
      themeJson: adminThemeJson,
      client
    });

    const result = await updateAdminStorefrontSettings({
      id: created.id,
      themeJson: {
        ...adminThemeJson,
        ctaLabel: "Shop now"
      },
      client
    });

    assert.ok(result.settings);
    assert.equal(result.settings.themeJson.ctaLabel, "Shop now");
    assert.equal(state.events.at(-1).eventType, "STOREFRONT_SETTINGS_UPDATED");
  });

  it("adds a normalized storefront domain and writes a provisioning event", async () => {
    const { client, state } = makeAdminStorefrontClient();
    const created = await createAdminStorefront({
      merchantId: "merchant_1",
      name: "Celvya Wellness",
      themeJson: adminThemeJson,
      client
    });

    const result = await addAdminStorefrontDomain({
      id: created.id,
      domain: " WWW.BrandExample.COM ",
      isPrimary: true,
      client
    });

    assert.equal(result.domains[0].domain, "brandexample.com");
    assert.equal(result.domains[0].status, "REQUESTED");
    assert.equal(result.domains[0].isPrimary, true);
    assert.equal(state.events.at(-1).eventType, "STOREFRONT_DOMAIN_ADDED");
  });

  it("returns a clean 409 when a domain is already attached", async () => {
    const { client } = makeAdminStorefrontClient();
    const created = await createAdminStorefront({
      merchantId: "merchant_1",
      name: "Celvya Wellness",
      themeJson: adminThemeJson,
      client
    });

    await addAdminStorefrontDomain({ id: created.id, domain: "brand.com", client });

    await assert.rejects(
      () => addAdminStorefrontDomain({ id: created.id, domain: "brand.com", client }),
      (error) => error instanceof HttpError && error.status === 409 && error.message === "DOMAIN_ALREADY_ATTACHED"
    );
  });

  it("rejects malformed storefront domains", async () => {
    const { client } = makeAdminStorefrontClient();
    const created = await createAdminStorefront({
      merchantId: "merchant_1",
      name: "Celvya Wellness",
      themeJson: adminThemeJson,
      client
    });

    await assert.rejects(
      () => addAdminStorefrontDomain({ id: created.id, domain: "bad host!", client }),
      (error) => error instanceof HttpError && error.status === 400 && error.message === "VALIDATION_ERROR"
    );
  });

  it("rejects Shipmastr platform domains", async () => {
    const { client } = makeAdminStorefrontClient();
    const created = await createAdminStorefront({
      merchantId: "merchant_1",
      name: "Celvya Wellness",
      themeJson: adminThemeJson,
      client
    });

    await assert.rejects(
      () => addAdminStorefrontDomain({ id: created.id, domain: "www.shipmastr.com", client }),
      (error) => error instanceof HttpError && error.status === 400 && error.message === "DOMAIN_RESERVED_FOR_SHIPMASTR"
    );
  });

  it("updates storefront domain status and exposes the mapped renderer status", async () => {
    const { client, state } = makeAdminStorefrontClient();
    const created = await createAdminStorefront({
      merchantId: "merchant_1",
      name: "Celvya Wellness",
      themeJson: adminThemeJson,
      client
    });
    const withDomain = await addAdminStorefrontDomain({ id: created.id, domain: "brand.com", client });
    const domainId = withDomain.domains[0].id;

    const result = await updateAdminStorefrontDomainStatus({
      id: created.id,
      domainId,
      status: "ACTIVE",
      client
    });

    assert.equal(result.domains[0].status, "ACTIVE");
    assert.equal(result.domains[0].rendererStatus, "ACTIVE");
    assert.equal(state.events.at(-1).eventType, "STOREFRONT_DOMAIN_STATUS_UPDATED");
  });

  it("lists storefront domains for lifecycle visibility", async () => {
    const { client } = makeAdminStorefrontClient();
    const created = await createAdminStorefront({
      merchantId: "merchant_1",
      name: "Celvya Wellness",
      themeJson: adminThemeJson,
      client
    });
    await addAdminStorefrontDomain({ id: created.id, domain: "brand.com", isPrimary: true, client });

    const result = await listAdminStorefrontDomains({ id: created.id, client });

    assert.equal(result.storefrontId, created.id);
    assert.equal(result.domains.length, 1);
    const domain = result.domains[0];
    assert.ok(domain);
    assert.deepEqual(Object.keys(domain).sort(), [
      "createdAt",
      "dnsTarget",
      "domain",
      "failureReason",
      "id",
      "isPrimary",
      "lastCheckedAt",
      "sslStatus",
      "status",
      "updatedAt",
      "verificationStatus"
    ].sort());
    assert.equal(domain.domain, "brand.com");
  });

  it("returns 404 when listing domains for an unknown storefront", async () => {
    const { client } = makeAdminStorefrontClient();

    await assert.rejects(
      () => listAdminStorefrontDomains({ id: "missing_storefront", client }),
      (error) => error instanceof HttpError && error.status === 404 && error.message === "STOREFRONT_NOT_FOUND"
    );
  });

  it("lists storefront domain events with sensitive payload fields redacted", async () => {
    const { client, state } = makeAdminStorefrontClient();
    const created = await createAdminStorefront({
      merchantId: "merchant_1",
      name: "Celvya Wellness",
      themeJson: adminThemeJson,
      client
    });
    const withDomain = await addAdminStorefrontDomain({ id: created.id, domain: "brand.com", client });
    const domainId = withDomain.domains[0].id;
    state.events.push({
      id: "event_sensitive",
      storefrontId: created.id,
      storefrontDomainId: domainId,
      eventType: "PROVIDER_DEBUG",
      payload: {
        status: "ok",
        apiKey: "should-not-leak",
        nested: {
          authorization: "Bearer secret-token",
          regular: "visible"
        },
        headers: [
          {
            token: "abc"
          }
        ]
      },
      createdAt: new Date("2026-05-19T10:05:00.000Z")
    });

    const result = await listAdminStorefrontDomainEvents({
      id: created.id,
      domainId,
      client
    });

    const event = result.events.find((item) => item.id === "event_sensitive");
    assert.ok(event);
    assert.deepEqual(event.payload, {
      status: "ok",
      apiKey: "[redacted]",
      nested: {
        authorization: "[redacted]",
        regular: "visible"
      },
      headers: [
        {
          token: "[redacted]"
        }
      ]
    });
  });

  it("returns 404 when listing events for an unknown storefront domain", async () => {
    const { client } = makeAdminStorefrontClient();
    const created = await createAdminStorefront({
      merchantId: "merchant_1",
      name: "Celvya Wellness",
      themeJson: adminThemeJson,
      client
    });

    await assert.rejects(
      () => listAdminStorefrontDomainEvents({ id: created.id, domainId: "missing_domain", client }),
      (error) => error instanceof HttpError && error.status === 404 && error.message === "STOREFRONT_DOMAIN_NOT_FOUND"
    );
  });

  it("redacts obvious sensitive event payload keys recursively", () => {
    assert.deepEqual(redactStorefrontEventPayload({
      password: "secret",
      safe: "ok",
      nested: {
        bearer: "token-value"
      }
    }), {
      password: "[redacted]",
      safe: "ok",
      nested: {
        bearer: "[redacted]"
      }
    });
  });

  it("lists all admin storefronts ordered by creation date desc", async () => {
    const { client, state } = makeAdminStorefrontClient();

    const first = await createAdminStorefront({
      merchantId: "merchant_1",
      name: "Store One",
      themeJson: adminThemeJson,
      client
    });

    const second = await createAdminStorefront({
      merchantId: "merchant_1",
      name: "Store Two",
      themeJson: adminThemeJson,
      client
    });

    // Make second storefront created after first storefront to test desc sorting
    state.storefronts.get(second.id).createdAt = new Date("2026-05-19T10:05:00.000Z");

    await addAdminStorefrontDomain({
      id: first.id,
      domain: "brandexample.com",
      isPrimary: true,
      client
    });

    const storefronts = await listAdminStorefronts({ client });

    assert.equal(storefronts.length, 2);
    assert.equal(storefronts[0]!.name, "Store Two");
    assert.equal(storefronts[1]!.name, "Store One");
    assert.ok(storefronts[0]!.settings);

    // Check that domain was returned for first storefront (which is storefronts[1] because of createdAt desc sorting)
    assert.equal(storefronts[1]!.domains.length, 1);
    const domain = storefronts[1]!.domains[0]!;
    assert.equal(domain.domain, "brandexample.com");

    // Negative assertions for sensitive fields
    const sensitiveKeys = [
      "cloudflareId",
      "customHostnameId",
      "resellerClubId",
      "providerId",
      "txtRecord",
      "txtValue",
      "token",
      "secret",
      "rawPayload"
    ];

    for (const key of sensitiveKeys) {
      assert.equal(key in domain, false, `Domain object should not contain sensitive key: ${key}`);
    }
  });
});
