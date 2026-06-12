import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProviderDraftOrderInput } from "../provider-adapter.types.js";
import {
  canResolveShiprocketLiveCredentials,
  resolveShiprocketLiveCredentials,
  ShiprocketCredentialResolutionError
} from "./shiprocket-live-credentials.js";
import { ShiprocketLiveAdapter } from "./shiprocket-live.adapter.js";
import { ShiprocketLiveClient, type ShiprocketLiveFetch } from "./shiprocket-live.client.js";
import {
  mapProviderRateInputToShiprocketServiceability,
  mapProviderDraftToShiprocketOrder,
  mapShiprocketAwbToProviderManifest,
  mapShiprocketServiceabilityToProviderRates,
  mapShiprocketLabelToProviderLabel,
  mapShiprocketOrderToProviderDraft
} from "./shiprocket-live.mapper.js";

const source = {
  SHIPROCKET_LIVE_CREDENTIALS: JSON.stringify({
    email: "pilot@example.test",
    password: "not-a-real-provider-password"
  })
};

function draftInput(): ProviderDraftOrderInput {
  return {
    sellerId: "merchant_1",
    shipmentId: "shipment_1",
    sellerOrderId: "ORD-1",
    segment: "domestic_b2c",
    paymentMode: "cod",
    pickupLocationProviderId: "Primary Warehouse",
    returnLocationProviderId: "Primary Warehouse",
    invoiceNumber: "INV-1",
    invoiceAmount: 1499,
    collectableAmount: 1499,
    deadWeightKg: 0.5,
    dimensions: {
      lengthCm: 20,
      breadthCm: 15,
      heightCm: 10
    },
    buyer: {
      name: "Demo Buyer",
      phone: "8888888888",
      email: null,
      addressLine1: "Buyer line",
      addressLine2: null,
      city: "Mumbai",
      state: "MH",
      country: "IN",
      pincode: "400001"
    },
    products: [{
      name: "Cotton Shirt",
      sku: "SKU-1",
      quantity: 1,
      unitPrice: 1499
    }]
  };
}

describe("Shiprocket live credential resolver", () => {
  it("accepts only the explicit env credential reference", () => {
    const credentials = resolveShiprocketLiveCredentials("env:SHIPROCKET_LIVE_CREDENTIALS", source);
    assert.equal(credentials.email, "pilot@example.test");
    assert.equal(canResolveShiprocketLiveCredentials("env:SHIPROCKET_LIVE_CREDENTIALS", source).ok, true);

    assert.throws(
      () => resolveShiprocketLiveCredentials("plain-email-and-password", source),
      (error) => error instanceof ShiprocketCredentialResolutionError
        && error.code === "LIVE_SHIPROCKET_CREDENTIAL_REF_UNRESOLVED"
    );
    assert.throws(
      () => resolveShiprocketLiveCredentials("vault:shiprocket/live/test", source),
      (error) => error instanceof ShiprocketCredentialResolutionError
        && error.code === "LIVE_SHIPROCKET_CREDENTIAL_REF_UNRESOLVED"
    );
  });

  it("requires email and password without exposing them in errors", () => {
    const result = canResolveShiprocketLiveCredentials("env:SHIPROCKET_LIVE_CREDENTIALS", {
      SHIPROCKET_LIVE_CREDENTIALS: "{\"email\":\"pilot@example.test\"}"
    });
    const json = JSON.stringify(result);
    assert.equal(result.ok, false);
    assert.doesNotMatch(json, /pilot@example.test|password|not-a-real-provider-password/i);
  });
});

describe("Shiprocket live client and mapper", () => {
  it("maps a complete Shiprocket adhoc order payload from safe shipment fields", () => {
    const request = mapProviderDraftToShiprocketOrder(draftInput());
    const items = request.order_items as Array<Record<string, unknown>>;

    assert.equal(request.order_id, "ORD-1");
    assert.equal(request.pickup_location, "Primary Warehouse");
    assert.equal(request.payment_method, "COD");
    assert.equal(request.collectable_amount, 1499);
    assert.equal(request.billing_customer_name, "Demo");
    assert.equal(request.billing_last_name, "Buyer");
    assert.equal(items[0]?.name, "Cotton Shirt");
    assert.equal(items[0]?.sku, "SKU-1");
    assert.equal(items[0]?.units, 1);
    assert.equal(items[0]?.selling_price, 1499);
    assert.doesNotMatch(JSON.stringify(request), /token|secret|credential|rawPayload|rawHeaders|Authorization|Bearer/i);
  });

  it("uses mocked HTTP for login, order creation, serviceability, AWB assignment, and label generation", async () => {
    const calls: Array<{ url: string; body: unknown; authorization: boolean }> = [];
    const fetchImpl: ShiprocketLiveFetch = async (url, init) => {
      calls.push({
        url,
        body: init.body ? JSON.parse(init.body) as unknown : null,
        authorization: Boolean(init.headers?.authorization)
      });
      if (url.endsWith("/auth/login")) return { ok: true, status: 200, json: async () => ({ token: "ephemeral-token", expires_in: 60 }) };
      if (url.endsWith("/orders/create/adhoc")) return { ok: true, status: 200, json: async () => ({ shipment_id: 987654321, order_id: "ORD-1" }) };
      if (url.includes("/v1/external/courier/serviceability/")) {
        assert.match(url, /pickup_postcode=560001/);
        assert.match(url, /delivery_postcode=400001/);
        assert.match(url, /weight=0.5/);
        assert.match(url, /cod=1/);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              recommended_courier_company_id: 12345,
              available_courier_companies: [{
                courier_company_id: 12345,
                rate: 72,
                estimated_delivery_days: 2,
                freight_charge: 72
              }]
            }
          })
        };
      }
      if (url.endsWith("/courier/assign/awb")) return { ok: true, status: 200, json: async () => ({ awb_code: "190123456789", shipment_id: 987654321 }) };
      if (url.endsWith("/courier/generate/label")) return { ok: true, status: 200, json: async () => ({ label_url: "https://label.example.test/safe.pdf" }) };
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const client = new ShiprocketLiveClient({ baseUrl: "https://apiv2.shiprocket.in" }, fetchImpl);
    const login = await client.login({ email: "pilot@example.test", password: "not-a-real-provider-password" });
    const order = await client.createAdhocOrder(mapProviderDraftToShiprocketOrder(draftInput()), login.token!);
    const serviceability = await client.getServiceability({
      pickup_postcode: "560001",
      delivery_postcode: "400001",
      weight: 0.5,
      cod: 1,
      declared_value: 1499
    }, login.token!);
    const awb = await client.assignAwb({ shipment_id: 987654321, courier_id: 12345 }, login.token!);
    const label = await client.generateLabel({ shipment_id: [987654321] }, login.token!);

    assert.equal(login.token, "ephemeral-token");
    assert.equal(mapShiprocketOrderToProviderDraft(order).providerOrderId, "987654321");
    assert.equal(mapShiprocketServiceabilityToProviderRates(serviceability)[0]?.providerCourierId, "12345");
    assert.equal(mapShiprocketAwbToProviderManifest(awb).providerAwb, "190123456789");
    assert.equal(mapShiprocketLabelToProviderLabel(label).labelUrl, "https://label.example.test/safe.pdf");
    assert.equal(calls.length, 5);
    assert.equal(calls[0]?.authorization, false);
    assert.equal(calls.slice(1).every((call) => call.authorization), true);
    assert.doesNotMatch(JSON.stringify({ order, serviceability: mapShiprocketServiceabilityToProviderRates(serviceability), awb, label }), /ephemeral-token|not-a-real-provider-password|Authorization|Bearer/i);
  });

  it("maps Shiprocket serviceability into Shipmastr-branded rates with internal numeric ids", () => {
    const serviceabilityRequest = mapProviderRateInputToShiprocketServiceability({
      sellerId: "merchant_1",
      shipmentId: "shipment_1",
      providerOrderId: null,
      pickupPincode: "560001",
      deliveryPincode: "400001",
      paymentMode: "cod",
      collectableAmount: 1499,
      deadWeightKg: 0.5,
      dimensions: {
        lengthCm: 20,
        breadthCm: 15,
        heightCm: 10
      }
    });
    const rates = mapShiprocketServiceabilityToProviderRates({
      data: {
        recommended_courier_company_id: 2002,
        available_courier_companies: [{
          courier_company_id: 1001,
          rate: 58,
          estimated_delivery_days: 5,
          service_id: "surface"
        }, {
          courier_company_id: 2002,
          rate: 72,
          estimated_delivery_days: 2,
          service_id: "standard"
        }, {
          courier_company_id: 3003,
          rate: 96,
          estimated_delivery_days: 1,
          service_id: "air"
        }]
      }
    });
    const json = JSON.stringify(rates);

    assert.equal(serviceabilityRequest.pickup_postcode, "560001");
    assert.equal(serviceabilityRequest.delivery_postcode, "400001");
    assert.equal(serviceabilityRequest.cod, 1);
    assert.equal(serviceabilityRequest.declared_value, 1499);
    assert.equal(rates.map((rate) => rate.serviceLevel).join(","), "Shipmastr Smart,Shipmastr Economy,Shipmastr Express");
    assert.equal(rates[0]?.providerCourierId, "2002");
    assert.equal(rates[1]?.providerCourierId, "1001");
    assert.equal(rates[2]?.providerCourierId, "3003");
    assert.doesNotMatch(json, /Authorization|Bearer|token|password|rawPayload|rawHeaders|rawResponse|courier_name|courier_company_name/i);
  });

  it("skips serviceability rows without usable numeric courier ids", () => {
    const rates = mapShiprocketServiceabilityToProviderRates({
      data: {
        available_courier_companies: [{
          courier_company_id: "mock_courier_smart",
          rate: 50,
          estimated_delivery_days: 2
        }, {
          rate: 60,
          estimated_delivery_days: 3
        }]
      }
    });

    assert.deepEqual(rates, []);
  });

  it("returns safe provider errors without raw response details", async () => {
    const fetchImpl: ShiprocketLiveFetch = async () => ({
      ok: false,
      status: 401,
      json: async () => ({
        message: "provider says password not-a-real-provider-password failed",
        token: "raw-provider-token"
      })
    });
    const client = new ShiprocketLiveClient({ baseUrl: "https://apiv2.shiprocket.in" }, fetchImpl);

    await assert.rejects(
      () => client.login({ email: "pilot@example.test", password: "not-a-real-provider-password" }),
      (error: any) => {
        const json = JSON.stringify(error);
        assert.equal(error.code, "SHIPROCKET_AUTH_FAILED");
        assert.equal(error.statusCode, 401);
        assert.equal(error.retryable, false);
        assert.doesNotMatch(json, /not-a-real-provider-password|raw-provider-token|provider says/i);
        return true;
      }
    );
  });

  it("adapter keeps tokens in memory and returns safe provider-shaped results", async () => {
    const adapter = new ShiprocketLiveAdapter({
      credentialRef: "env:SHIPROCKET_LIVE_CREDENTIALS",
      source,
      client: {
        login: async () => ({ token: "ephemeral-token", expires_in: 60 }),
        createAdhocOrder: async () => ({ shipment_id: 987654321, order_id: "ORD-1" }),
        getServiceability: async () => ({ data: { available_courier_companies: [{ courier_company_id: 12345, rate: 72 }] } }),
        assignAwb: async () => ({ awb_code: "190123456789", shipment_id: 987654321 }),
        generateLabel: async () => ({ label_url: "https://label.example.test/safe.pdf" })
      }
    });

    const draft = await adapter.createDraftOrder(draftInput());
    const manifest = await adapter.manifestOrder({
      sellerId: "merchant_1",
      shipmentId: "shipment_1",
      providerOrderId: draft.providerOrderId,
      providerCourierId: "12345"
    });
    const label = await adapter.getLabel({
      sellerId: "merchant_1",
      shipmentId: "shipment_1",
      providerOrderId: draft.providerOrderId,
      providerShipmentId: draft.providerOrderId,
      awb: manifest.awb,
      trackingNumber: manifest.trackingNumber
    });
    const json = JSON.stringify({ draft, manifest, label });

    assert.equal(adapter.code, "shiprocket");
    assert.equal(draft.providerOrderId, "987654321");
    assert.equal(manifest.awb, "190123456789");
    assert.equal(label.labelUrl, "https://label.example.test/safe.pdf");
    assert.doesNotMatch(json, /ephemeral-token|not-a-real-provider-password|rawPayload|rawHeaders|Authorization|Bearer/i);
  });

  it("adapter preserves safe credential resolution errors without provider detail", async () => {
    const adapter = new ShiprocketLiveAdapter({
      credentialRef: "env:SHIPROCKET_LIVE_CREDENTIALS",
      source: {},
      client: {
        login: async () => { throw new Error("should not be called"); },
        createAdhocOrder: async () => ({}),
        getServiceability: async () => ({}),
        assignAwb: async () => ({}),
        generateLabel: async () => ({})
      }
    });

    await assert.rejects(
      () => adapter.getRates({
        sellerId: "merchant_1",
        shipmentId: "shipment_1",
        providerOrderId: null,
        pickupPincode: "560001",
        deliveryPincode: "400001",
        paymentMode: "cod",
        collectableAmount: 1499,
        deadWeightKg: 0.5,
        dimensions: {
          lengthCm: 20,
          breadthCm: 15,
          heightCm: 10
        }
      }),
      (error: any) => {
        assert.equal(error.code, "LIVE_SHIPROCKET_CREDENTIAL_REF_UNRESOLVED");
        assert.equal(error.retryable, false);
        assert.doesNotMatch(JSON.stringify(error), /password|token|Authorization|Bearer|pilot@example/i);
        return true;
      }
    );
  });

  it("fails closed for incomplete provider ids before mutation calls", async () => {
    const adapter = new ShiprocketLiveAdapter({
      credentialRef: "env:SHIPROCKET_LIVE_CREDENTIALS",
      source,
      client: {
        login: async () => ({ token: "ephemeral-token", expires_in: 60 }),
        createAdhocOrder: async () => ({ shipment_id: 987654321 }),
        getServiceability: async () => ({}),
        assignAwb: async () => { throw new Error("should not be called"); },
        generateLabel: async () => ({})
      }
    });
    await assert.rejects(
      () => adapter.manifestOrder({
        sellerId: "merchant_1",
        shipmentId: "shipment_1",
        providerOrderId: "mock_provider_order_001",
        providerCourierId: "internal_courier"
      }),
      /Courier provider live request is incomplete/
    );
  });
});
