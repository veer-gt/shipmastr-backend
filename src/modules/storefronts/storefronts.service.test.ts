import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { StorefrontAssetStatus } from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import {
  GcsStorefrontAssetStorageAdapter,
  InMemoryStorefrontAssetStorageAdapter,
  MAX_STOREFRONT_ASSET_BYTES,
  STOREFRONT_ASSET_UPLOAD_IF_GENERATION_MATCH,
  STOREFRONT_ASSET_UPLOAD_IF_GENERATION_MATCH_HEADER,
  STOREFRONT_ASSET_UPLOAD_LENGTH_RANGE,
  STOREFRONT_ASSET_UPLOAD_LENGTH_RANGE_HEADER
} from "./storefront-asset-storage.js";
import {
  assertReadyStorefrontAssetOwnedByMerchant,
  confirmStorefrontAsset,
  createStorefrontAssetUploadUrl,
  sweepPendingStorefrontAssetOrphans
} from "./storefront-assets.service.js";
import {
  createPublicStorefrontLookupHandler,
  createStorefrontLookupHandler,
  STOREFRONT_THEME_ROUTE_LIMITS,
  storefrontThemeJsonSchema
} from "./storefronts.routes.js";
import {
  addAdminStorefrontDomain,
  assertThemeJsonSaveSafety,
  createAdminStorefront,
  getAdminStorefront,
  getStorefrontByDomain,
  listAdminStorefrontDomainEvents,
  listAdminStorefrontDomains,
  listAdminStorefronts,
  MAX_THEME_JSON_SERIALIZED_BYTES,
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

function maxEscapedString(length: number) {
  return "\u0000".repeat(length);
}

function maxPublicRouteThemeJson() {
  const product = {
    id: maxEscapedString(STOREFRONT_THEME_ROUTE_LIMITS.productId),
    name: maxEscapedString(STOREFRONT_THEME_ROUTE_LIMITS.productName),
    price: maxEscapedString(STOREFRONT_THEME_ROUTE_LIMITS.productPrice),
    description: maxEscapedString(STOREFRONT_THEME_ROUTE_LIMITS.productDescription),
    imageAssetId: maxEscapedString(STOREFRONT_THEME_ROUTE_LIMITS.assetId)
  };

  return {
    primaryColor: maxEscapedString(STOREFRONT_THEME_ROUTE_LIMITS.primaryColor),
    backgroundColor: maxEscapedString(STOREFRONT_THEME_ROUTE_LIMITS.backgroundColor),
    textColor: maxEscapedString(STOREFRONT_THEME_ROUTE_LIMITS.textColor),
    fontFamily: maxEscapedString(STOREFRONT_THEME_ROUTE_LIMITS.fontFamily),
    heroTitle: maxEscapedString(STOREFRONT_THEME_ROUTE_LIMITS.heroTitle),
    heroSubtitle: maxEscapedString(STOREFRONT_THEME_ROUTE_LIMITS.heroSubtitle),
    ctaLabel: maxEscapedString(STOREFRONT_THEME_ROUTE_LIMITS.ctaLabel),
    logoAssetId: maxEscapedString(STOREFRONT_THEME_ROUTE_LIMITS.assetId),
    heroImageAssetId: maxEscapedString(STOREFRONT_THEME_ROUTE_LIMITS.assetId),
    templateStyle: maxEscapedString(STOREFRONT_THEME_ROUTE_LIMITS.templateStyle),
    ctaAction: "shipmastr_checkout",
    heroLayout: "hero-center",
    presetId: maxEscapedString(STOREFRONT_THEME_ROUTE_LIMITS.presetId),
    presetVersion: 999999,
    products: Array.from({ length: STOREFRONT_THEME_ROUTE_LIMITS.products }, () => product)
  };
}

describe("storefront theme size guard", () => {
  it("keeps the public route schema maximum below the save-time service guard", () => {
    const themeJson = storefrontThemeJsonSchema.parse(maxPublicRouteThemeJson());
    const routeMaxBytes = Buffer.byteLength(JSON.stringify(themeJson), "utf8");

    assert.equal(routeMaxBytes, 32776);
    assert.ok(routeMaxBytes < MAX_THEME_JSON_SERIALIZED_BYTES);
  });

  it("keeps THEME_TOO_LARGE as a defense-in-depth service guard", () => {
    assert.throws(
      () => assertThemeJsonSaveSafety({
        ...adminThemeJson,
        heroSubtitle: "x".repeat(MAX_THEME_JSON_SERIALIZED_BYTES + 1)
      }),
      (error) => error instanceof HttpError
        && error.status === 400
        && error.message === "THEME_TOO_LARGE"
    );
  });
});

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

function makeStorefrontAssetHarness(options: { storefrontEntitled?: boolean } = {}) {
  const state = {
    now: new Date("2026-07-08T10:00:00.000Z"),
    merchants: new Map([
      ["merchant_a", { id: "merchant_a" }],
      ["merchant_b", { id: "merchant_b" }]
    ]),
    storefronts: options.storefrontEntitled === false
      ? [] as any[]
      : [{ id: "storefront_a", merchantId: "merchant_a" }],
    assets: [] as any[]
  };

  function selectObject(row: any, select?: Record<string, boolean>) {
    if (!row || !select) return row;
    return Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, row[key]]));
  }

  const client: any = {
    merchant: {
      findUnique: async ({ where, select }: any) => selectObject(state.merchants.get(where.id) ?? null, select)
    },
    storefront: {
      findFirst: async ({ where, select }: any) => selectObject(
        state.storefronts.find((row) => row.merchantId === where.merchantId) ?? null,
        select
      )
    },
    storefrontAsset: {
      create: async ({ data }: any) => {
        const row = {
          id: data.id ?? `asset_${state.assets.length + 1}`,
          merchantId: data.merchantId,
          gcsPath: data.gcsPath,
          mime: data.mime,
          bytes: data.bytes ?? null,
          width: data.width ?? null,
          height: data.height ?? null,
          sha256: data.sha256 ?? null,
          status: data.status ?? StorefrontAssetStatus.PENDING,
          createdAt: data.createdAt ?? state.now,
          updatedAt: data.updatedAt ?? state.now
        };
        state.assets.push(row);
        return structuredClone(row);
      },
      update: async ({ where, data }: any) => {
        const row = state.assets.find((asset) => asset.id === where.id);
        if (!row) throw new Error("ASSET_NOT_FOUND");
        Object.assign(row, data, { updatedAt: state.now });
        return structuredClone(row);
      },
      findUnique: async ({ where, select }: any) => selectObject(
        structuredClone(state.assets.find((asset) => asset.id === where.id) ?? null),
        select
      ),
      findFirst: async ({ where }: any) => structuredClone(state.assets.find((asset) =>
        asset.merchantId === where.merchantId
        && asset.sha256 === where.sha256
        && asset.status === where.status
        && asset.id !== where.id?.not
      ) ?? null),
      findMany: async ({ where, select }: any) => {
        let rows = state.assets.slice();
        if (where?.status) rows = rows.filter((asset) => asset.status === where.status);
        if (where?.createdAt?.lt) rows = rows.filter((asset) => asset.createdAt < where.createdAt.lt);
        return structuredClone(rows.map((row) => selectObject(row, select)));
      }
    }
  };

  const storage = new InMemoryStorefrontAssetStorageAdapter();
  return { state, client, storage };
}

async function createPendingStorefrontAsset(input: {
  client: any;
  storage: InMemoryStorefrontAssetStorageAdapter;
  merchantId?: string;
  contentType?: "image/webp" | "image/jpeg" | "image/png";
}) {
  const upload = await createStorefrontAssetUploadUrl({
    merchantId: input.merchantId ?? "merchant_a",
    contentType: input.contentType ?? "image/png",
    client: input.client,
    storage: input.storage
  });
  const asset = await input.client.storefrontAsset.findUnique({ where: { id: upload.assetId } });
  return { upload, asset };
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

describe("storefront asset signed-upload proof gates", () => {
  it("signs and returns the required GCS upload headers", async () => {
    let signedOptions: any = null;
    const storage = new GcsStorefrontAssetStorageAdapter({
      bucket: "test-bucket",
      projectId: "test-project",
      storage: {
        bucket: () => ({
          file: () => ({
            getSignedUrl: async (options: any) => {
              signedOptions = options;
              return ["https://storage.googleapis.test/signed"];
            }
          })
        })
      } as any
    });

    const result = await storage.createSignedPutUrl({
      gcsPath: "merchants/merchant_a/storefront/asset_1.png",
      contentType: "image/png",
      expiresAt: new Date("2026-07-08T10:05:00.000Z")
    });

    assert.equal(signedOptions.contentType, "image/png");
    assert.deepEqual(signedOptions.extensionHeaders, {
      [STOREFRONT_ASSET_UPLOAD_LENGTH_RANGE_HEADER]: STOREFRONT_ASSET_UPLOAD_LENGTH_RANGE,
      [STOREFRONT_ASSET_UPLOAD_IF_GENERATION_MATCH_HEADER]: STOREFRONT_ASSET_UPLOAD_IF_GENERATION_MATCH
    });
    assert.deepEqual(result.headers, {
      "content-type": "image/png",
      [STOREFRONT_ASSET_UPLOAD_LENGTH_RANGE_HEADER]: STOREFRONT_ASSET_UPLOAD_LENGTH_RANGE,
      [STOREFRONT_ASSET_UPLOAD_IF_GENERATION_MATCH_HEADER]: STOREFRONT_ASSET_UPLOAD_IF_GENERATION_MATCH
    });
  });

  it("falls back to runtime IAM signBlob and signs the required PUT headers", async () => {
    let signBlobUrl: string | null = null;
    let signBlobPayload: string | null = null;
    const signature = Buffer.from("iam-signature").toString("base64");
    const storage = new GcsStorefrontAssetStorageAdapter({
      bucket: "test-bucket",
      projectId: "test-project",
      signingServiceAccount: "storefront-signer@test.iam.gserviceaccount.com",
      storage: {
        bucket: () => ({
          file: () => ({
            getSignedUrl: async () => {
              throw new Error("metadata signer unavailable");
            }
          })
        })
      } as any,
      accessTokenProvider: async () => "test-access-token",
      iamSignBlobRequest: async (input) => {
        assert.equal(input.accessToken, "test-access-token");
        signBlobUrl = input.url;
        signBlobPayload = input.payload;
        return { signedBlob: signature };
      }
    });

    const result = await storage.createSignedPutUrl({
      gcsPath: "merchants/merchant_a/storefront/asset_1.png",
      contentType: "image/png",
      expiresAt: new Date(Date.now() + 5 * 60 * 1000)
    });

    const uploadUrl = new URL(result.uploadUrl);
    assert.equal(uploadUrl.protocol, "https:");
    assert.equal(uploadUrl.hostname, "storage.googleapis.com");
    assert.equal(uploadUrl.pathname, "/test-bucket/merchants/merchant_a/storefront/asset_1.png");
    assert.equal(uploadUrl.searchParams.get("X-Goog-Algorithm"), "GOOG4-RSA-SHA256");
    assert.match(uploadUrl.searchParams.get("X-Goog-Date") || "", /^\d{8}T\d{6}Z$/);
    assert.equal(
      uploadUrl.searchParams.get("X-Goog-SignedHeaders"),
      "content-type;host;x-goog-content-length-range;x-goog-if-generation-match"
    );
    assert.equal(uploadUrl.searchParams.get("X-Goog-Signature"), Buffer.from("iam-signature").toString("hex"));
    assert.equal(
      uploadUrl.searchParams.get("X-Goog-Credential")?.includes("storefront-signer@test.iam.gserviceaccount.com/"),
      true
    );
    assert.equal(
      signBlobUrl,
      "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/storefront-signer%40test.iam.gserviceaccount.com:signBlob"
    );
    assert.ok(signBlobPayload);
    assert.deepEqual(result.headers, {
      "content-type": "image/png",
      [STOREFRONT_ASSET_UPLOAD_LENGTH_RANGE_HEADER]: STOREFRONT_ASSET_UPLOAD_LENGTH_RANGE,
      [STOREFRONT_ASSET_UPLOAD_IF_GENERATION_MATCH_HEADER]: STOREFRONT_ASSET_UPLOAD_IF_GENERATION_MATCH
    });
  });

  it("falls back to authenticated GCS JSON APIs for head, download, and delete", async () => {
    const gcsPath = "merchants/merchant_a/storefront/asset_1.png";
    const calls: string[] = [];
    const storage = new GcsStorefrontAssetStorageAdapter({
      bucket: "test-bucket",
      projectId: "test-project",
      storage: {
        bucket: () => ({
          file: () => ({
            getMetadata: async () => {
              throw new Error("metadata service unavailable");
            },
            download: async () => {
              throw new Error("metadata service unavailable");
            },
            delete: async () => {
              throw new Error("metadata service unavailable");
            }
          })
        })
      } as any,
      accessTokenProvider: async () => "test-access-token",
      metadataRequest: async (input) => {
        assert.equal(input.accessToken, "test-access-token");
        assert.equal(input.gcsPath, gcsPath);
        assert.equal(new URL(input.url).pathname, "/storage/v1/b/test-bucket/o/merchants%2Fmerchant_a%2Fstorefront%2Fasset_1.png");
        calls.push("metadata");
        return {
          ok: true,
          status: 200,
          metadata: {
            name: gcsPath,
            size: "14",
            contentType: "image/png",
            updated: "2026-07-09T10:00:00.000Z"
          }
        };
      },
      downloadRequest: async (input) => {
        assert.equal(input.accessToken, "test-access-token");
        assert.equal(input.gcsPath, gcsPath);
        assert.equal(new URL(input.url).pathname, "/download/storage/v1/b/test-bucket/o/merchants%2Fmerchant_a%2Fstorefront%2Fasset_1.png");
        calls.push("download");
        return {
          ok: true,
          status: 200,
          body: Buffer.from("asset bytes")
        };
      },
      deleteRequest: async (input) => {
        assert.equal(input.accessToken, "test-access-token");
        assert.equal(input.gcsPath, gcsPath);
        calls.push("delete");
        return {
          ok: true,
          status: 204
        };
      }
    });

    const head = await storage.headObject({ gcsPath });
    assert.deepEqual(head, {
      exists: true,
      contentLength: 14,
      contentType: "image/png",
      updatedAt: new Date("2026-07-09T10:00:00.000Z")
    });
    const bytes = await storage.downloadForHashing({ gcsPath, maxBytes: MAX_STOREFRONT_ASSET_BYTES });
    assert.equal(bytes.toString("utf8"), "asset bytes");
    const deleted = await storage.deleteObject({ gcsPath });
    assert.deepEqual(deleted, { deleted: true });
    assert.deepEqual(calls, ["metadata", "download", "delete"]);
  });

  it("B1 returns 422 for missing object confirm and leaves asset pending", async () => {
    const { client, storage, state } = makeStorefrontAssetHarness();
    const { upload } = await createPendingStorefrontAsset({ client, storage });

    await assert.rejects(
      () => confirmStorefrontAsset({ merchantId: "merchant_a", assetId: upload.assetId, client, storage }),
      (error) => error instanceof HttpError && error.status === 422 && error.message === "STOREFRONT_ASSET_UPLOAD_NOT_FOUND"
    );
    assert.equal(state.assets[0].status, StorefrontAssetStatus.PENDING);
  });

  it("B2 returns 422 for wrong object mime", async () => {
    const { client, storage } = makeStorefrontAssetHarness();
    const { upload, asset } = await createPendingStorefrontAsset({ client, storage, contentType: "image/png" });
    storage.seedObject(asset.gcsPath, Buffer.from("jpg"), "image/jpeg");

    await assert.rejects(
      () => confirmStorefrontAsset({ merchantId: "merchant_a", assetId: upload.assetId, client, storage }),
      (error) => error instanceof HttpError && error.status === 422 && error.message === "STOREFRONT_ASSET_MIME_MISMATCH"
    );
  });

  it("B3 returns 422 for uploads larger than 8MB and deletes the object", async () => {
    const { client, storage } = makeStorefrontAssetHarness();
    const { upload, asset } = await createPendingStorefrontAsset({ client, storage });
    storage.seedObject(asset.gcsPath, Buffer.alloc(MAX_STOREFRONT_ASSET_BYTES + 1), "image/png");

    await assert.rejects(
      () => confirmStorefrontAsset({ merchantId: "merchant_a", assetId: upload.assetId, client, storage }),
      (error) => error instanceof HttpError && error.status === 422 && error.message === "STOREFRONT_ASSET_TOO_LARGE"
    );
    assert.equal((await storage.headObject({ gcsPath: asset.gcsPath })).exists, false);
  });

  it("B4 returns 404 when merchant A confirms merchant B asset", async () => {
    const { client, storage } = makeStorefrontAssetHarness();
    const { upload, asset } = await createPendingStorefrontAsset({ client, storage });
    storage.seedObject(asset.gcsPath, Buffer.from("png"), "image/png");

    await assert.rejects(
      () => confirmStorefrontAsset({ merchantId: "merchant_b", assetId: upload.assetId, client, storage }),
      (error) => error instanceof HttpError && error.status === 404 && error.message === "STOREFRONT_ASSET_NOT_FOUND"
    );
  });

  it("B5 rejects pending asset references in themeJson with ASSET_NOT_READY", async () => {
    const { client, storage } = makeStorefrontAssetHarness();
    const { upload } = await createPendingStorefrontAsset({ client, storage });

    await assert.rejects(
      () => assertReadyStorefrontAssetOwnedByMerchant({ merchantId: "merchant_a", assetId: upload.assetId, client }),
      (error) => error instanceof HttpError && error.status === 400 && error.message === "ASSET_NOT_READY"
    );
  });

  it("B6 rejects deleted asset references", async () => {
    const { client, storage } = makeStorefrontAssetHarness();
    const { upload } = await createPendingStorefrontAsset({ client, storage });
    await client.storefrontAsset.update({
      where: { id: upload.assetId },
      data: { status: StorefrontAssetStatus.DELETED }
    });

    await assert.rejects(
      () => assertReadyStorefrontAssetOwnedByMerchant({ merchantId: "merchant_a", assetId: upload.assetId, client }),
      (error) => error instanceof HttpError && error.status === 400 && error.message === "ASSET_NOT_READY"
    );
  });

  it("B7 rejects merchant A referencing merchant B ready asset", async () => {
    const { client, storage } = makeStorefrontAssetHarness();
    const { upload, asset } = await createPendingStorefrontAsset({ client, storage });
    storage.seedObject(asset.gcsPath, Buffer.from("png"), "image/png");
    await confirmStorefrontAsset({ merchantId: "merchant_a", assetId: upload.assetId, client, storage });

    await assert.rejects(
      () => assertReadyStorefrontAssetOwnedByMerchant({ merchantId: "merchant_b", assetId: upload.assetId, client }),
      (error) => error instanceof HttpError && error.status === 400 && error.message === "STOREFRONT_ASSET_NOT_FOUND_OR_NOT_OWNED"
    );
  });

  it("B8 treats double confirm as idempotent", async () => {
    const { client, storage } = makeStorefrontAssetHarness();
    const { upload, asset } = await createPendingStorefrontAsset({ client, storage });
    storage.seedObject(asset.gcsPath, Buffer.from("png"), "image/png");

    const first = await confirmStorefrontAsset({ merchantId: "merchant_a", assetId: upload.assetId, client, storage });
    const second = await confirmStorefrontAsset({ merchantId: "merchant_a", assetId: upload.assetId, client, storage });

    assert.equal(first.id, upload.assetId);
    assert.equal(second.id, upload.assetId);
    assert.equal(first.status, StorefrontAssetStatus.READY);
    assert.equal(second.status, StorefrontAssetStatus.READY);
  });

  it("B9 sweeps pending assets older than 24h and leaves ready assets untouched", async () => {
    const { client, storage, state } = makeStorefrontAssetHarness();
    const oldPending = await client.storefrontAsset.create({
      data: {
        merchantId: "merchant_a",
        gcsPath: "merchants/merchant_a/storefront/old_pending.png",
        mime: "image/png",
        status: StorefrontAssetStatus.PENDING,
        createdAt: new Date("2026-07-06T09:00:00.000Z")
      }
    });
    const oldReady = await client.storefrontAsset.create({
      data: {
        merchantId: "merchant_a",
        gcsPath: "merchants/merchant_a/storefront/old_ready.png",
        mime: "image/png",
        status: StorefrontAssetStatus.READY,
        createdAt: new Date("2026-07-06T09:00:00.000Z")
      }
    });
    const recentPending = await client.storefrontAsset.create({
      data: {
        merchantId: "merchant_a",
        gcsPath: "merchants/merchant_a/storefront/recent_pending.png",
        mime: "image/png",
        status: StorefrontAssetStatus.PENDING,
        createdAt: new Date("2026-07-08T09:30:00.000Z")
      }
    });

    const result = await sweepPendingStorefrontAssetOrphans({
      client,
      storage,
      now: state.now
    });

    assert.deepEqual(result, { scanned: 1, deleted: 1 });
    assert.equal(state.assets.find((asset) => asset.id === oldPending.id).status, StorefrontAssetStatus.DELETED);
    assert.equal(state.assets.find((asset) => asset.id === oldReady.id).status, StorefrontAssetStatus.READY);
    assert.equal(state.assets.find((asset) => asset.id === recentPending.id).status, StorefrontAssetStatus.PENDING);
  });

  it("B10 returns 403 for upload-url issuance without storefront entitlement", async () => {
    const { client, storage } = makeStorefrontAssetHarness({ storefrontEntitled: false });

    await assert.rejects(
      () => createStorefrontAssetUploadUrl({
        merchantId: "merchant_a",
        contentType: "image/png",
        client,
        storage
      }),
      (error) => error instanceof HttpError && error.status === 403 && error.message === "STOREFRONT_ASSET_UPLOAD_NOT_ENTITLED"
    );
  });
});
