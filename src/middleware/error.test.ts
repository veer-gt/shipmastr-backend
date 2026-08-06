import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import express from "express";

import { HttpError, PublicHttpError } from "../lib/httpError.js";
import { logger } from "../lib/logger.js";
import { errorHandler } from "./error.js";

async function withApp<T>(
  callback: (baseUrl: string) => Promise<T>,
  throwFromFailure?: () => unknown
) {
  const app = express();
  app.use(express.json({ limit: "1kb" }));
  app.post("/json", (_req, res) => res.json({ ok: true }));
  if (throwFromFailure) app.get("/failure", () => { throw throwFromFailure(); });
  app.use(errorHandler);

  const server = createServer(app);
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

async function captureWarnings<T>(callback: (warnings: unknown[][]) => Promise<T>) {
  const warnings: unknown[][] = [];
  const original = logger.warn;
  logger.warn = ((...args: unknown[]) => { warnings.push(args); }) as typeof logger.warn;
  try {
    return await callback(warnings);
  } finally {
    logger.warn = original;
  }
}

describe("errorHandler", () => {
  it("maps oversized JSON bodies to a safe 413 response", async () => {
    await withApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/json`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: "x".repeat(2048) })
      });

      assert.equal(response.status, 413);
      assert.deepEqual(await response.json(), { error: "PAYLOAD_TOO_LARGE" });
    });
  });

  it("keeps ordinary HttpError details out of the response", async () => {
    const sentinel = "postgresql://db-user:db-pass@internal.example/shipmastr?token=sk-private";
    const error = new HttpError(409, "ORDER_ALREADY_EXISTS", {
      field: "externalOrderId",
      token: sentinel,
      nested: { secret: sentinel }
    });

    await withApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/failure?token=${encodeURIComponent(sentinel)}`);

      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: "ORDER_ALREADY_EXISTS" });
    }, () => error);
  });

  it("records a bounded HttpError warning without detail values or query strings", async () => {
    const sentinel = "postgresql://db-user:db-pass@internal.example/shipmastr?token=sk-private";
    const error = new HttpError(409, "ORDER_ALREADY_EXISTS", {
      field: "externalOrderId",
      token: sentinel,
      nested: { secret: sentinel }
    });

    await captureWarnings(async (warnings) => {
      await withApp(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/failure?token=${encodeURIComponent(sentinel)}`);
        assert.equal(response.status, 409);
        await response.json();
      }, () => error);

      const serializedWarnings = JSON.stringify(warnings);
      assert.equal(serializedWarnings.includes(sentinel), false);
      assert.equal(serializedWarnings.includes("externalOrderId"), false);
      assert.equal(serializedWarnings.includes("token"), false);
      assert.equal(serializedWarnings.includes("secret"), false);
      assert.equal(serializedWarnings.includes(`/failure?token=${encodeURIComponent(sentinel)}`), false);

      assert.equal(warnings.length, 1);
      const warning = warnings[0]?.[0] as {
        security?: {
          event?: unknown;
          status?: unknown;
          code?: unknown;
          method?: unknown;
          route?: unknown;
          truncatedNetworkIdentifier?: unknown;
          details?: unknown;
        };
      };
      assert.equal(warning.security?.event, "request_http_error_rejected");
      assert.equal(warning.security?.status, 409);
      assert.equal(warning.security?.code, "ORDER_ALREADY_EXISTS");
      assert.equal(warning.security?.method, "GET");
      assert.equal(warning.security?.route, "/failure");
      assert.match(String(warning.security?.truncatedNetworkIdentifier), /^[a-f0-9]{24}$/);
      assert.deepEqual(warning.security?.details, {
        type: "object",
        keyCount: 3,
        keys: ["field"]
      });
    });
  });

  it("returns validated PublicHttpError details unchanged", async () => {
    const details = { field: "externalOrderId", reasons: ["duplicate", 409, false, null] };
    const error = new PublicHttpError(409, "ORDER_ALREADY_EXISTS", details);

    await withApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/failure`);

      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: "ORDER_ALREADY_EXISTS", details });
    }, () => error);
  });

  it("fails closed when PublicHttpError details are invalid at runtime", async () => {
    const error = new PublicHttpError(400, "INVALID_PUBLIC_DETAILS", {
      field: { secret: "internal" }
    } as never);

    await withApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/failure`);

      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "INVALID_PUBLIC_DETAILS" });
    }, () => error);
  });
});
