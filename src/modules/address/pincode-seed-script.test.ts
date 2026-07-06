import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { describe, it } from "node:test";

async function loadSeedScript() {
  return import(pathToFileURL(join(process.cwd(), "scripts/address/seed-pincodes.mjs")).href) as Promise<any>;
}

function makeAddressPincodeClient() {
  const rows = new Map<string, any>();
  return {
    client: {
      addressPincode: {
        async upsert({ where, create, update }: any) {
          const existing = rows.get(where.pincode);
          const next = existing ? { ...existing, ...update } : create;
          rows.set(where.pincode, next);
          return next;
        }
      }
    },
    rows
  };
}

describe("Address A1 pincode seed script helpers", () => {
  it("aggregates localities for duplicate pincode CSV rows", async () => {
    const { parsePincodeSeedContent, normalizePincodeSeedRows } = await loadSeedScript();
    const csv = [
      "pincode,city,district,state,locality,lat,lng",
      "110001,New Delhi,New Delhi,Delhi,Connaught Place,28.6315000,77.2167000",
      "110001,New Delhi,New Delhi,Delhi,Janpath,28.6315000,77.2167000"
    ].join("\n");

    const rows = normalizePincodeSeedRows(parsePincodeSeedContent(csv, "pins.csv"));

    assert.equal(rows.length, 1);
    assert.equal(rows[0].pincode, "110001");
    assert.deepEqual(rows[0].localities, ["Connaught Place", "Janpath"]);
  });

  it("is idempotent when upserting the same normalized records repeatedly", async () => {
    const { normalizePincodeSeedRows, upsertAddressPincodes } = await loadSeedScript();
    const { client, rows } = makeAddressPincodeClient();
    const records = normalizePincodeSeedRows([
      {
        pincode: "560001",
        city: "Bengaluru",
        district: "Bengaluru Urban",
        state: "Karnataka",
        locality: "MG Road"
      }
    ]);

    await upsertAddressPincodes(client, records);
    await upsertAddressPincodes(client, records);

    assert.equal(rows.size, 1);
    assert.deepEqual(rows.get("560001")?.localities, ["MG Road"]);
  });
});
