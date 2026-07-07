import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { describe, it } from "node:test";
import express from "express";

import { HttpError } from "../../lib/httpError.js";
import { errorHandler } from "../../middleware/error.js";
import {
  GOOGLE_PLACES_AUTOCOMPLETE_SERVICE_COUNTER,
  GOOGLE_PLACES_DETAILS_SERVICE_COUNTER
} from "../addressGeocoding/google-maps-quota.service.js";
import { createCheckoutPlacesRouter } from "./checkout-places.routes.js";
import {
  GOOGLE_PLACES_AUTOCOMPLETE_ENDPOINT,
  GOOGLE_PLACES_AUTOCOMPLETE_FIELD_MASK,
  GOOGLE_PLACES_DETAILS_ENDPOINT_PREFIX,
  GOOGLE_PLACES_DETAILS_FIELD_MASK
} from "./checkout-google-places.client.js";
import {
  DisabledPlacesProvider,
  createCheckoutPlacesProvider,
  type CheckoutPlacesConfig,
  type PlacesProvider
} from "./checkout-places-provider.js";

const baseConfig: CheckoutPlacesConfig = {
  autocompleteEnabled: true,
  detailsEnabled: true,
  apiKey: "server-side-google-key",
  minQueryChars: 3,
  debounceMs: 300
};

type FetchCall = {
  url: string;
  init: RequestInit;
  body: any;
};

function makePlacesHarness(input: {
  config?: Partial<CheckoutPlacesConfig>;
  pincodeRow?: { lat: unknown; lng: unknown } | null;
  quotaBlocked?: boolean;
  autocompleteBody?: unknown;
  detailsBody?: unknown;
} = {}) {
  const state = {
    fetchCalls: [] as FetchCall[],
    pincodeLookups: [] as string[],
    counters: [] as any[]
  };
  const config = {
    ...baseConfig,
    ...(input.config ?? {})
  };

  const client: any = {
    addressPincode: {
      findUnique: async ({ where }: any) => {
        state.pincodeLookups.push(where.pincode);
        if (input.pincodeRow === null) return null;
        return input.pincodeRow ?? { lat: "28.6139000", lng: "77.2090000" };
      }
    },
    googleMapsUsageCounter: {
      upsert: async ({ where, create, update }: any) => {
        const key = where.service_yearMonth;
        if (input.quotaBlocked) {
          return {
            id: "counter_blocked",
            service: key.service,
            yearMonth: key.yearMonth,
            count: Number.MAX_SAFE_INTEGER,
            softLimit: 5000,
            hardLimit: 7000
          };
        }
        const existing = state.counters.find((row) => row.service === key.service && row.yearMonth === key.yearMonth);
        if (existing) {
          existing.count += update.count.increment;
          existing.softLimit = update.softLimit;
          existing.hardLimit = update.hardLimit;
          return { ...existing };
        }
        const row = { id: `counter_${state.counters.length + 1}`, ...create };
        state.counters.push(row);
        return { ...row };
      }
    }
  };

  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const requestUrl = String(url);
    const requestInit = init ?? {};
    const requestBody = typeof requestInit.body === "string" ? JSON.parse(requestInit.body) : null;
    state.fetchCalls.push({ url: requestUrl, init: requestInit, body: requestBody });
    return {
      ok: true,
      json: async () => {
        if (requestUrl === GOOGLE_PLACES_AUTOCOMPLETE_ENDPOINT) {
          return input.autocompleteBody ?? {
            suggestions: [{
              placePrediction: {
                placeId: "place_safe_1",
                structuredFormat: {
                  mainText: { text: "Connaught Place" },
                  secondaryText: { text: "New Delhi, Delhi, India" }
                },
                rawUnsafeField: "do-not-return"
              }
            }]
          };
        }
        return input.detailsBody ?? {
          id: "place_safe_1",
          formattedAddress: "A Block, Connaught Place, New Delhi, Delhi 110001, India",
          addressComponents: [
            { longText: "A Block", types: ["premise"] },
            { longText: "Connaught Place", types: ["sublocality_level_1"] },
            { longText: "New Delhi", types: ["locality"] },
            { longText: "Delhi", types: ["administrative_area_level_1"] },
            { longText: "110001", types: ["postal_code"] }
          ],
          nationalPhoneNumber: "9999999999",
          rating: 4.9,
          websiteUri: "https://example.invalid"
        };
      }
    } as any;
  };

  const provider = createCheckoutPlacesProvider({
    client,
    fetchImpl: fetchImpl as typeof fetch,
    config
  });

  return { state, provider, client, fetchImpl: fetchImpl as typeof fetch, config };
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function withPlacesApp<T>(
  provider: PlacesProvider,
  callback: (baseUrl: string) => Promise<T>
) {
  const app = express();
  app.use(express.json());
  app.use("/checkout", createCheckoutPlacesRouter({
    provider,
    sessionResolver: async (token) => {
      if (!token) throw new HttpError(401, "CHECKOUT_SESSION_TOKEN_REQUIRED");
      if (token !== "active_session") throw new HttpError(401, "CHECKOUT_SESSION_TOKEN_INVALID");
      return {
        sessionId: "session_1",
        merchantId: "merchant_1",
        cartId: "cart_1",
        status: "created"
      };
    }
  }));
  app.use(errorHandler);
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("CHECKOUT_PLACES_TEST_SERVER_ADDRESS_UNAVAILABLE");
  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await closeServer(server);
  }
}

async function request(baseUrl: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null
  };
}

describe("Checkout Places A7 config and disabled provider", () => {
  it("uses existing Google flags, adds only Places tuning config, and defaults disabled", async () => {
    const envSource = readFileSync("src/config/env.ts", "utf8");
    assert.match(envSource, /GOOGLE_ADDRESS_AUTOCOMPLETE_ENABLED:\s*envBoolean\(false\)/);
    assert.match(envSource, /GOOGLE_PLACE_DETAILS_ENABLED:\s*envBoolean\(false\)/);
    assert.match(envSource, /GOOGLE_GEOCODING_API_KEY:\s*z\.string\(\)\.optional\(\)/);
    assert.match(envSource, /PLACES_MIN_QUERY_CHARS:[\s\S]*default\(3\)/);
    assert.match(envSource, /PLACES_DEBOUNCE_MS:[\s\S]*default\(300\)/);
    assert.doesNotMatch(envSource, /PLACES_ENABLED|PLACES_PROVIDER/);

    const { state, provider } = makePlacesHarness({
      config: { autocompleteEnabled: false, detailsEnabled: false, apiKey: "server-side-google-key" }
    });
    assert.deepEqual(await provider.autocomplete({ q: "Connaught Place" }), {
      enabled: false,
      suggestions: [],
      reason: "disabled"
    });
    assert.deepEqual(await provider.details({ placeId: "place_safe_1" }), {
      enabled: false,
      place: null,
      reason: "disabled"
    });
    assert.equal(state.fetchCalls.length, 0);
    assert.equal(state.counters.length, 0);
  });

  it("returns not_configured without network calls when the server key is missing", async () => {
    const { state, provider } = makePlacesHarness({
      config: { autocompleteEnabled: true, detailsEnabled: true, apiKey: "" }
    });

    assert.deepEqual(await provider.autocomplete({ q: "Connaught Place" }), {
      enabled: false,
      suggestions: [],
      reason: "not_configured"
    });
    assert.deepEqual(await provider.details({ placeId: "place_safe_1" }), {
      enabled: false,
      place: null,
      reason: "not_configured"
    });
    assert.equal(state.fetchCalls.length, 0);
    assert.equal(state.counters.length, 0);
  });

  it("enforces min query length before quota, pincode, or Google calls", async () => {
    const { state, provider } = makePlacesHarness();
    assert.deepEqual(await provider.autocomplete({ q: "cp", pincode: "110001" }), {
      enabled: true,
      suggestions: [],
      reason: "query_too_short"
    });
    assert.equal(state.fetchCalls.length, 0);
    assert.equal(state.pincodeLookups.length, 0);
    assert.equal(state.counters.length, 0);
  });

  it("DisabledPlacesProvider performs zero network work", async () => {
    const provider = new DisabledPlacesProvider();
    assert.deepEqual(await provider.autocomplete({ q: "anything", pincode: "110001" }), {
      enabled: false,
      suggestions: [],
      reason: "disabled"
    });
    assert.deepEqual(await provider.details({ placeId: "place_safe_1" }), {
      enabled: false,
      place: null,
      reason: "disabled"
    });
  });
});

describe("Checkout Places A7 Google client guardrails", () => {
  it("restricts autocomplete to India, uses pincode centroid bias only when available, and returns safe fields", async () => {
    const { state, provider } = makePlacesHarness();
    const result = await provider.autocomplete({ q: "Connaught Place", pincode: "110001" });

    assert.equal(result.enabled, true);
    assert.equal(result.reason, "ok");
    assert.deepEqual(result.suggestions, [{
      placeId: "place_safe_1",
      mainText: "Connaught Place",
      secondaryText: "New Delhi, Delhi, India"
    }]);
    assert.deepEqual(state.pincodeLookups, ["110001"]);
    const counter = state.counters[0];
    assert.ok(counter);
    assert.equal(counter.service, GOOGLE_PLACES_AUTOCOMPLETE_SERVICE_COUNTER);

    const call = state.fetchCalls[0];
    assert.ok(call);
    assert.equal(call.url, GOOGLE_PLACES_AUTOCOMPLETE_ENDPOINT);
    assert.equal(call.url.includes(baseConfig.apiKey), false);
    assert.equal((call.init.headers as Record<string, string>)["X-Goog-Api-Key"], baseConfig.apiKey);
    assert.equal((call.init.headers as Record<string, string>)["X-Goog-FieldMask"], GOOGLE_PLACES_AUTOCOMPLETE_FIELD_MASK);
    assert.deepEqual(call.body.includedRegionCodes, ["in"]);
    assert.equal(call.body.locationBias.circle.center.latitude, 28.6139);
    assert.equal(call.body.locationBias.circle.center.longitude, 77.209);
    assert.equal(/rawUnsafeField|server-side-google-key|phoneHash|email|proof|token/i.test(JSON.stringify(result)), false);
  });

  it("attempts pincode lookup only when supplied and still calls Places without bias for unknown pincode", async () => {
    const noPincode = makePlacesHarness();
    await noPincode.provider.autocomplete({ q: "Connaught Place" });
    assert.deepEqual(noPincode.state.pincodeLookups, []);
    const noPincodeCall = noPincode.state.fetchCalls[0];
    assert.ok(noPincodeCall);
    assert.equal("locationBias" in noPincodeCall.body, false);

    const unknown = makePlacesHarness({ pincodeRow: null });
    await unknown.provider.autocomplete({ q: "Connaught Place", pincode: "999999" });
    assert.deepEqual(unknown.state.pincodeLookups, ["999999"]);
    const unknownCall = unknown.state.fetchCalls[0];
    assert.ok(unknownCall);
    assert.equal("locationBias" in unknownCall.body, false);
  });

  it("returns a safe quota response without a Google call when hard cap blocks the request", async () => {
    const autocomplete = makePlacesHarness({ quotaBlocked: true });
    assert.deepEqual(await autocomplete.provider.autocomplete({ q: "Connaught Place" }), {
      enabled: false,
      suggestions: [],
      reason: "quota"
    });
    assert.equal(autocomplete.state.fetchCalls.length, 0);

    const details = makePlacesHarness({ quotaBlocked: true });
    assert.deepEqual(await details.provider.details({ placeId: "place_safe_1" }), {
      enabled: false,
      place: null,
      reason: "quota"
    });
    assert.equal(details.state.fetchCalls.length, 0);
  });

  it("uses strict details FieldMask and returns normalized address fields only", async () => {
    const { state, provider } = makePlacesHarness();
    const result = await provider.details({ placeId: "place_safe_1" });

    assert.deepEqual(result, {
      enabled: true,
      place: {
        placeId: "place_safe_1",
        line1Suggestion: "A Block, Connaught Place",
        city: "New Delhi",
        state: "Delhi",
        pincode: "110001"
      },
      reason: "ok"
    });
    const counter = state.counters[0];
    assert.ok(counter);
    assert.equal(counter.service, GOOGLE_PLACES_DETAILS_SERVICE_COUNTER);
    const call = state.fetchCalls[0];
    assert.ok(call);
    assert.equal(call.url, `${GOOGLE_PLACES_DETAILS_ENDPOINT_PREFIX}place_safe_1`);
    assert.equal(call.url.includes(baseConfig.apiKey), false);
    assert.equal((call.init.headers as Record<string, string>)["X-Goog-Api-Key"], baseConfig.apiKey);
    assert.equal((call.init.headers as Record<string, string>)["X-Goog-FieldMask"], GOOGLE_PLACES_DETAILS_FIELD_MASK);
    assert.equal(GOOGLE_PLACES_DETAILS_FIELD_MASK, "id,addressComponents,formattedAddress");
    assert.equal(/photos|reviews|rating|phone|website|openingHours|location/i.test(GOOGLE_PLACES_DETAILS_FIELD_MASK), false);
    assert.equal(/formattedAddress|nationalPhoneNumber|rating|websiteUri|server-side-google-key/i.test(JSON.stringify(result)), false);
  });
});

describe("Checkout Places A7 routes", () => {
  it("mounts /checkout/places routes through the existing public checkout router", () => {
    const checkoutRoutes = readFileSync("src/modules/checkout/checkout.routes.ts", "utf8");
    assert.match(checkoutRoutes, /checkoutRouter\.use\("\/", checkoutPlacesRouter\);/);
  });

  it("rejects missing and invalid checkout session tokens", async () => {
    const { provider } = makePlacesHarness({ config: { autocompleteEnabled: false } });
    await withPlacesApp(provider, async (baseUrl) => {
      const missing = await request(baseUrl, "/checkout/places/autocomplete?q=Connaught");
      const invalid = await request(baseUrl, "/checkout/places/autocomplete?q=Connaught", {
        headers: { "x-checkout-session-token": "invalid" }
      });

      assert.equal(missing.status, 401);
      assert.equal(missing.body.error, "CHECKOUT_SESSION_TOKEN_REQUIRED");
      assert.equal(invalid.status, 401);
      assert.equal(invalid.body.error, "CHECKOUT_SESSION_TOKEN_INVALID");
    });
  });

  it("returns safe empty route responses when Places is disabled", async () => {
    const { provider } = makePlacesHarness({ config: { autocompleteEnabled: false, detailsEnabled: false } });
    await withPlacesApp(provider, async (baseUrl) => {
      const autocomplete = await request(baseUrl, "/checkout/places/autocomplete?q=Connaught", {
        headers: { "x-checkout-session-token": "active_session" }
      });
      const details = await request(baseUrl, "/checkout/places/details", {
        method: "POST",
        headers: { "x-checkout-session-token": "active_session" },
        body: JSON.stringify({ placeId: "place_safe_1" })
      });

      assert.equal(autocomplete.status, 200);
      assert.deepEqual(autocomplete.body, { enabled: false, suggestions: [], reason: "disabled" });
      assert.equal(details.status, 200);
      assert.deepEqual(details.body, { enabled: false, place: null, reason: "disabled" });
    });
  });

  it("does not expose API keys or raw Google payloads through autocomplete/details routes", async () => {
    const { state, provider } = makePlacesHarness();
    await withPlacesApp(provider, async (baseUrl) => {
      const autocomplete = await request(baseUrl, "/checkout/places/autocomplete?q=Connaught&pincode=110001", {
        headers: { "x-checkout-session-token": "active_session" }
      });
      const details = await request(baseUrl, "/checkout/places/details", {
        method: "POST",
        headers: { "x-checkout-session-token": "active_session" },
        body: JSON.stringify({ placeId: "place_safe_1" })
      });

      assert.equal(autocomplete.status, 200);
      assert.equal(details.status, 200);
      assert.equal(/server-side-google-key|rawUnsafeField|formattedAddress|rating|websiteUri|phoneHash|email|proof|token/i.test(JSON.stringify(autocomplete.body)), false);
      assert.equal(/server-side-google-key|rawUnsafeField|formattedAddress|rating|websiteUri|phoneHash|email|proof|token/i.test(JSON.stringify(details.body)), false);
      assert.equal(state.fetchCalls.every((call) => !call.url.includes(baseConfig.apiKey)), true);
    });
  });
});

describe("Checkout Places A7 safety boundaries", () => {
  it("does not add unrelated Google APIs, browser-key exposure, frontend, or payment surfaces", () => {
    const sourceFiles = [
      "src/modules/checkout/checkout-places-provider.ts",
      "src/modules/checkout/checkout-google-places.client.ts",
      "src/modules/checkout/checkout-places.routes.ts"
    ];
    const sources = sourceFiles.map((file) => readFileSync(file, "utf8")).join("\n");

    assert.equal(/addressvalidation|routes\.googleapis|tile|nearby|textsearch|map ui|browser key/i.test(sources), false);
    assert.equal(/razorpay|cashfree|wallet|settlement|payout|custody|cod.?ledger|payment/i.test(sourceFiles.join("\n")), false);
    assert.equal(readFileSync("src/modules/checkout/checkout-payment.service.ts", "utf8").includes("checkoutPlaces"), false);
  });
});
