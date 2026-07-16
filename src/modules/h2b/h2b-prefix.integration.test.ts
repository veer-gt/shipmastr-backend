import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createApp } from "../../server.js";
import { allowH2BRequest, resetH2BRateLimitForTests } from "./h2b-rate-limit.js";

async function request(app: any, method: string, path: string, body = "not-json", chunked = false) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as { port: number };
  const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (!chunked) headers["content-length"] = String(Buffer.byteLength(body));
    const req = http.request({ hostname: "127.0.0.1", port: address.port, method, path, headers }, (res) => {
      const chunks: Buffer[] = []; res.on("data", (chunk) => chunks.push(Buffer.from(chunk))); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (chunked) { req.write(body.slice(0, Math.floor(body.length / 2))); req.end(body.slice(Math.floor(body.length / 2))); }
    else req.end(body);
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return result;
}

test("H2B disabled prefix is terminal before body parsing", async () => {
  const app = await createApp({ h2bEnabled: false });
  for (const method of ["POST", "GET", "PUT", "DELETE"]) {
    const response = await request(app, method, "/api/public/provider-webhooks/shp_bad");
    assert.equal(response.status, 404);
    assert.deepEqual(JSON.parse(response.body), { error: "H2B_ROUTE_NOT_FOUND" });
  }
});

test("H2B enabled malformed and near-prefix paths have the same safe terminal response", async () => {
  const app = await createApp({ h2bEnabled: true });
  const responses = await Promise.all([
    request(app, "POST", "/api/public/provider-webhooks/not-a-token"),
    request(app, "POST", "/api/public/provider-webhooks/shp_bad/extra"),
    request(app, "GET", "/api/public/provider-webhooks/shp_bad"),
    request(app, "POST", "/api/public/provider-webhooks/%E0%A4%A"),
    request(app, "POST", `/api/public/provider-webhooks/not-a-token?${"k=".repeat(2049)}`)
  ]);
  for (const response of responses) { assert.equal(response.status, 404); assert.deepEqual(JSON.parse(response.body), { error: "H2B_ROUTE_NOT_FOUND" }); }
  const validShape = `/api/public/provider-webhooks/shp_${"A".repeat(43)}`;
  assert.equal((await request(app, "POST", validShape, "x".repeat(262_145))).status, 413);
  assert.equal((await request(app, "POST", validShape, "x".repeat(262_145), true)).status, 413);
});

test("unknown valid endpoints share the malformed safe response and pre-resolution abuse control", async () => {
  resetH2BRateLimitForTests();
  const malformed = allowH2BRequest(null, "198.51.100.10", 10_000, "unknown");
  const unknown = allowH2BRequest(null, "198.51.100.10", 10_000, "shp");
  assert.equal(malformed, true);
  assert.equal(unknown, true);
  for (let attempt = 1; attempt < 60; attempt += 1) assert.equal(allowH2BRequest(null, "198.51.100.10", 10_000, "unknown"), true);
  assert.equal(allowH2BRequest(null, "198.51.100.10", 10_000, "unknown"), false);
  resetH2BRateLimitForTests();
});
