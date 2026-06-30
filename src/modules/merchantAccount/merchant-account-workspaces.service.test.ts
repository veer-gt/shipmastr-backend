import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  assertMerchantWorkspaceResponseSafe,
  buildMerchantSetupWorkspace,
  createMerchantCustomer,
  createMerchantWarehouse,
  listMerchantCustomers,
  listMerchantWarehouses,
  updateMerchantCustomer,
  updateMerchantWarehouse
} from "./merchant-account-workspaces.service.js";
import { requireMerchantCommandCenterActor } from "./merchant-account.routes.js";

const now = new Date("2026-06-30T00:00:00.000Z");

function makeStore() {
  const warehouses: any[] = [];
  const customers: any[] = [];
  return {
    warehouses,
    customers,
    client: {
      merchant: {
        findUnique: async ({ where }: any) => ({
          id: where.id,
          name: "Safe Merchant",
          email: "merchant@example.test",
          phone: "9999999999",
          gstin: null,
          onboardingStatus: "READY_TO_SHIP",
          pickupAddressStatus: "COMPLETED",
          kycStatus: "COMPLETED",
          bankStatus: "COMPLETED",
          sellerKycStatus: "VERIFIED"
        })
      },
      merchantGstinRecord: {
        findMany: async () => []
      },
      merchantPickupPoint: {
        findMany: async ({ where }: any) => where.merchantId === "merchant_1" ? [{
          id: "pickup_1",
          linkedGstinId: null,
          linkedGstin: null,
          label: "Primary pickup",
          contactName: "Ops",
          phone: "9999999999",
          addressLine1: "Line 1",
          addressLine2: null,
          city: "Mumbai",
          state: "MH",
          pincode: "400001",
          status: "PENDING",
          isDefault: true,
          blockerReason: null,
          approvedAt: null,
          approvedBy: null,
          rejectedAt: null,
          rejectedBy: null,
          rejectionReason: null,
          createdAt: now,
          updatedAt: now
        }] : []
      },
      merchantWarehouse: {
        findMany: async ({ where }: any) => warehouses.filter((row) => row.merchantId === where.merchantId),
        findFirst: async ({ where }: any) => warehouses.find((row) => row.id === where.id && row.merchantId === where.merchantId) || null,
        create: async ({ data }: any) => {
          const row = { id: `warehouse_${warehouses.length + 1}`, createdAt: now, updatedAt: now, ...data };
          warehouses.push(row);
          return row;
        },
        updateMany: async ({ where, data }: any) => {
          warehouses.forEach((row) => {
            if (row.merchantId === where.merchantId && (!where.id?.not || row.id !== where.id.not)) Object.assign(row, data);
          });
          return { count: warehouses.length };
        },
        update: async ({ where, data }: any) => {
          const row = warehouses.find((item) => item.id === where.id);
          Object.assign(row, data, { updatedAt: now });
          return row;
        }
      },
      merchantCustomer: {
        findMany: async ({ where }: any) => customers.filter((row) => row.merchantId === where.merchantId),
        findFirst: async ({ where }: any) => customers.find((row) => row.id === where.id && row.merchantId === where.merchantId) || null,
        create: async ({ data }: any) => {
          const row = { id: `customer_${customers.length + 1}`, createdAt: now, updatedAt: now, ...data };
          customers.push(row);
          return row;
        },
        update: async ({ where, data }: any) => {
          const row = customers.find((item) => item.id === where.id);
          Object.assign(row, data, { updatedAt: now });
          return row;
        }
      }
    }
  };
}

const warehouseInput = {
  name: "Primary Warehouse",
  contactName: "Warehouse Ops",
  phone: "9999999999",
  addressLine1: "Warehouse line 1",
  city: "Mumbai",
  state: "MH",
  pincode: "400001",
  isPrimary: true
};

const customerInput = {
  name: "Test Buyer",
  phone: "9888888888",
  email: "buyer@example.test",
  addressLine1: "Buyer line 1",
  city: "Pune",
  state: "MH",
  pincode: "411001"
};

describe("merchant account workspaces", () => {
  it("mounts merchant workspace routes behind JWT auth", () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");
    assert.match(routes, /apiRouter\.use\("\/merchant", requireJwtAuth, merchantWorkspaceRouter\);/);
  });

  it("keeps customer masters separate from pickup contact validation", () => {
    const routes = readFileSync("src/modules/merchantAccount/merchant-account.routes.ts", "utf8");
    assert.match(routes, /const customerSchema = baseAddressSchema\.extend/);
    assert.match(routes, /const baseLocationSchema = baseAddressSchema\.extend\(\{\s*contactName:/);
  });

  it("keeps workspace routes merchant-only", async () => {
    await assert.rejects(
      () => requireMerchantCommandCenterActor({
        userId: "seller_1",
        merchantId: "merchant_1"
      }, {
        user: {
          findUnique: async () => ({
            id: "seller_1",
            merchantId: "merchant_1",
            role: "SELLER_OWNER",
            userType: "SELLER_ACCOUNT",
            merchant: { onboardingStatus: "PENDING" }
          })
        }
      } as any),
      /MERCHANT_ACCOUNT_ONLY/
    );
  });

  it("lists, creates, and edits merchant-owned warehouses", async () => {
    const { client } = makeStore();
    const created = await createMerchantWarehouse("merchant_1", warehouseInput, client as any);
    assert.equal(created.isPrimary, true);

    const edited = await updateMerchantWarehouse("merchant_1", created.id, {
      name: "Edited Warehouse",
      isActive: false
    }, client as any);
    assert.equal(edited.name, "Edited Warehouse");
    assert.equal(edited.isActive, false);

    const rows = await listMerchantWarehouses("merchant_1", client as any);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, created.id);
  });

  it("denies cross-merchant warehouse edits", async () => {
    const { client } = makeStore();
    const created = await createMerchantWarehouse("merchant_1", warehouseInput, client as any);
    await assert.rejects(
      () => updateMerchantWarehouse("merchant_2", created.id, { name: "Nope" }, client as any),
      /MERCHANT_WAREHOUSE_NOT_FOUND/
    );
  });

  it("rejects invalid warehouse input", async () => {
    const { client } = makeStore();
    await assert.rejects(
      () => createMerchantWarehouse("merchant_1", { ...warehouseInput, pincode: "bad" }, client as any),
      /MERCHANT_PINCODE_INVALID/
    );
  });

  it("lists, creates, and edits merchant-owned customers", async () => {
    const { client } = makeStore();
    const created = await createMerchantCustomer("merchant_1", customerInput, client as any);
    assert.equal(created.email, "buyer@example.test");

    const edited = await updateMerchantCustomer("merchant_1", created.id, {
      name: "Edited Buyer",
      email: ""
    }, client as any);
    assert.equal(edited.name, "Edited Buyer");
    assert.equal(edited.email, null);

    const rows = await listMerchantCustomers("merchant_1", client as any);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, created.id);
  });

  it("denies cross-merchant customer edits", async () => {
    const { client } = makeStore();
    const created = await createMerchantCustomer("merchant_1", customerInput, client as any);
    await assert.rejects(
      () => updateMerchantCustomer("merchant_2", created.id, { name: "Nope" }, client as any),
      /MERCHANT_CUSTOMER_NOT_FOUND/
    );
  });

  it("rejects invalid customer input", async () => {
    const { client } = makeStore();
    await assert.rejects(
      () => createMerchantCustomer("merchant_1", { ...customerInput, phone: "12" }, client as any),
      /MERCHANT_PHONE_INVALID/
    );
  });

  it("reflects pickup, warehouse, and customer readiness without unsafe leaks", async () => {
    const { client } = makeStore();
    await createMerchantWarehouse("merchant_1", warehouseInput, client as any);
    await createMerchantCustomer("merchant_1", customerInput, client as any);

    const setup = await buildMerchantSetupWorkspace("merchant_1", client as any);
    assert.equal(setup.counts.pickupPoints, 1);
    assert.equal(setup.counts.warehouses, 1);
    assert.equal(setup.counts.customers, 1);
    assert.equal(setup.readiness.pickups, "ready");
    assert.equal(setup.readiness.warehouses, "ready");
    assert.equal(setup.readiness.customers, "ready");
    assert.doesNotThrow(() => assertMerchantWorkspaceResponseSafe(setup));
  });
});
