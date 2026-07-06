import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { createPincodeLookupHandler } from "./pincode.routes.js";

function makeResponse() {
  return {
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
}

describe("Address A1 pincode routes", () => {
  it("responds with known pincode lookup data", async () => {
    const handler = createPincodeLookupHandler({
      async lookup(pin) {
        assert.equal(pin, "110001");
        return {
          city: "New Delhi",
          district: "New Delhi",
          state: "Delhi",
          localities: ["Connaught Place"]
        };
      }
    });
    const response = makeResponse();

    await handler({ params: { pin: "110001" } } as any, response as any);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      city: "New Delhi",
      district: "New Delhi",
      state: "Delhi",
      localities: ["Connaught Place"]
    });
  });

  it("is mounted through apiRouter so /api and /v1 expose /pincode/:pin", () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");
    assert.match(routes, /import \{ pincodeRouter \} from "\.\.\/modules\/address\/pincode\.routes\.js";/);
    assert.match(routes, /apiRouter\.use\("\/pincode", pincodeRouter\);/);
  });
});
