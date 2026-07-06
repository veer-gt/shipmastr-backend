import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { HttpError } from "../../lib/httpError.js";
import { AddressPincodeService, BoundedPincodeCache, type AddressPincodeClient } from "./pincode.service.js";

function makeClient(rows: Record<string, any> = {}) {
  const calls: string[] = [];
  const client: AddressPincodeClient = {
    addressPincode: {
      async findUnique(input) {
        calls.push(input.where.pincode);
        return rows[input.where.pincode] ?? null;
      }
    }
  };

  return { client, calls };
}

describe("Address A1 pincode lookup service", () => {
  it("resolves a known pincode with city, district, state, and localities only", async () => {
    const { client } = makeClient({
      "110001": {
        pincode: "110001",
        city: "New Delhi",
        district: "New Delhi",
        state: "Delhi",
        localities: ["Connaught Place", "Janpath"]
      }
    });

    const service = new AddressPincodeService(client, new BoundedPincodeCache());
    const result = await service.lookup("110001");

    assert.deepEqual(result, {
      city: "New Delhi",
      district: "New Delhi",
      state: "Delhi",
      localities: ["Connaught Place", "Janpath"]
    });
    assert.deepEqual(Object.keys(result).sort(), ["city", "district", "localities", "state"]);
  });

  it("returns 404 for an unknown pincode", async () => {
    const { client } = makeClient();
    const service = new AddressPincodeService(client, new BoundedPincodeCache());

    await assert.rejects(
      () => service.lookup("999999"),
      (error) => error instanceof HttpError && error.status === 404 && error.message === "PINCODE_NOT_FOUND"
    );
  });

  it("returns 400 for invalid pincode input", async () => {
    const { client } = makeClient();
    const service = new AddressPincodeService(client, new BoundedPincodeCache());

    await assert.rejects(
      () => service.lookup("11001"),
      (error) => error instanceof HttpError && error.status === 400 && error.message === "PINCODE_INVALID"
    );
    await assert.rejects(
      () => service.lookup("ABCDEF"),
      (error) => error instanceof HttpError && error.status === 400 && error.message === "PINCODE_INVALID"
    );
  });

  it("caches known lookups in a bounded in-process map", async () => {
    const { client, calls } = makeClient({
      "560001": {
        pincode: "560001",
        city: "Bengaluru",
        district: "Bengaluru Urban",
        state: "Karnataka",
        localities: ["MG Road"]
      }
    });

    const service = new AddressPincodeService(client, new BoundedPincodeCache(2));
    await service.lookup("560001");
    await service.lookup("560001");

    assert.deepEqual(calls, ["560001"]);
  });

  it("does not add external pincode, Google, or Places calls in the lookup path", () => {
    const source = readFileSync("src/modules/address/pincode.service.ts", "utf8");
    const forbidden = [
      ["api", "postalpincode", "in"].join("."),
      ["google", "apis"].join(""),
      ["pla", "ces"].join(""),
      ["fetch", "("].join("")
    ];
    assert.equal(new RegExp(forbidden.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i").test(source), false);
  });
});
