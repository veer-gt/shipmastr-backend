import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

test("proxy probe executes before the global limiter and health router", () => {
  const source = readFileSync(resolve(process.cwd(), "src/server.ts"), "utf8");
  const probe = source.indexOf("app.use(createRateLimitProxyProbe(");
  const limiter = source.indexOf("rateLimit({");
  const apiRouter = source.indexOf('app.use("/api", apiRouter)');
  assert.ok(probe >= 0, "probe middleware must be mounted");
  assert.ok(limiter > probe, "global limiter must run after the probe");
  assert.ok(apiRouter > limiter, "/api/health must remain behind the global limiter");
});
