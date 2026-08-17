import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { loggerRedactPaths } from "./logger.js";

describe("logger redaction", () => {
  it("redacts internal and provider-sensitive request headers", () => {
    for (const path of [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers.x-internal-secret",
      "req.headers.x-shipmastr-task-secret",
      "req.headers.x-shipmastr-courier-key",
      "req.headers.x-shipmastr-signature",
      "req.headers.forwarded",
      "req.headers.x-forwarded-for",
      "req.headers.x-shipmastr-rate-limit-probe-token",
      "req.headers['forwarded']",
      "req.headers['x-forwarded-for']",
      "req.headers['x-internal-secret']",
      "req.headers['x-shipmastr-task-secret']",
      "req.headers['x-shipmastr-rate-limit-probe-token']",
      "req.ip",
      "req.ips",
      "req.remoteAddress",
      "req.socket.remoteAddress",
      "req.connection.remoteAddress",
      "req.client.remoteAddress"
    ]) {
      assert.ok(loggerRedactPaths.includes(path), `${path} should be redacted`);
    }
  });

  it("removes controlled probe inputs from emitted request-completion JSON", () => {
    const token = "a".repeat(64);
    const forbiddenValues = [
      token,
      "192.0.2.10",
      "192.0.2.30",
      "198.51.100.20",
      "198.51.100.40",
      "2001:db8::1",
      "2001:db8::2",
      "203.0.113.101",
      "203.0.113.102"
    ];
    const result = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `
        import { EventEmitter } from "node:events";
        import { pinoHttp } from "pino-http";
        import { logger } from "./dist/lib/logger.js";

        const req = {
          method: "GET",
          url: "/api/health",
          headers: {
            forwarded: 'for=192.0.2.10, for=192.0.2.30, for="[2001:db8::1]"',
            "x-forwarded-for": "198.51.100.20, 198.51.100.40, 2001:db8::2",
            "x-shipmastr-rate-limit-probe-token": ${JSON.stringify(token)}
          },
          ip: "203.0.113.101",
          socket: { remoteAddress: "203.0.113.102", remotePort: 443 }
        };
        const res = Object.assign(new EventEmitter(), {
          statusCode: 200,
          writableEnded: true,
          getHeaders: () => ({})
        });
        pinoHttp({ logger })(req, res, () => res.emit("finish"));
      `
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "test" }
    });

    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 1, result.stdout);
    const emitted = JSON.parse(lines[0] ?? "") as {
      req?: { headers?: Record<string, unknown>; remoteAddress?: unknown };
    };
    const serialized = JSON.stringify(emitted);
    for (const forbiddenValue of forbiddenValues) {
      assert.equal(serialized.includes(forbiddenValue), false, `${forbiddenValue} leaked in ${serialized}`);
    }
    assert.equal(emitted.req?.headers?.forwarded, "[redacted]");
    assert.equal(emitted.req?.headers?.["x-forwarded-for"], "[redacted]");
    assert.equal(emitted.req?.headers?.["x-shipmastr-rate-limit-probe-token"], "[redacted]");
    assert.equal(emitted.req?.remoteAddress, "[redacted]");
  });
});
