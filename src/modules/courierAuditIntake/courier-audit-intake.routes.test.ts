import assert from "node:assert/strict";
import { createServer } from "node:http";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import test from "node:test";

import { createCourierAuditIntakeSignature, deriveCourierAuditIdempotencyKey } from "./courier-audit-intake.crypto.js";
import { CourierAuditIntakeConflictError } from "./courier-audit-intake.service.js";
import { loggerRedactPaths } from "../../lib/logger.js";

process.env.COURIER_AUDIT_INTAKE_ENABLED = "false";
process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";
process.env.JWT_SECRET ??= "j".repeat(32);
process.env.APP_SECRET_PEPPER ??= "p".repeat(16);
process.env.WEBHOOK_SECRET ??= "w".repeat(32);

const SIGNING_SECRET = "c".repeat(32);
const ROUTE_PATH = "/api/v1/integrations/intakes/courier-audit";

type IngestResult = {
  intakeId: string;
  ingestionStatus: "VALIDATED";
  reviewStatus: "NEEDS_REVIEW";
  duplicate: boolean;
};

type RouteOptions = {
  signingSecret?: string;
  ingest?: (request: unknown) => Promise<IngestResult>;
  enableRateLimit?: boolean;
};

type IntakeRoutesModule = {
  createCourierAuditIntakeRouter: (options?: RouteOptions) => express.Router;
  courierAuditIntakeRateLimit: { windowMs: number; limit: number };
};

let routeModulePromise: Promise<IntakeRoutesModule> | undefined;

async function loadIntakeRoutes(): Promise<IntakeRoutesModule> {
  routeModulePromise ??= import(new URL("./courier-audit-intake.routes.js", import.meta.url).href)
    .then((module) => module as unknown as IntakeRoutesModule)
    .catch((error: unknown) => {
      assert.fail(`courier intake route module is unavailable: ${String(error)}`);
    });
  return routeModulePromise;
}

function basePayload() {
  return {
    schemaVersion: "courier-audit-intake.v1",
    source: {
      provider: "GMAIL" as const,
      accountId: "courier-audit-inbox-test",
      messageId: "gmail-msg-1",
      threadId: "gmail-thread-1",
      receivedAt: "2026-08-07T10:20:30.000Z",
      from: { name: "Synthetic Merchant", email: "synthetic@example.test" },
      subject: "Synthetic courier invoice",
      bodySha256: "a".repeat(64),
      snippet: "Synthetic data only"
    },
    attachments: [],
    extraction: {
      extractedAt: "2026-08-07T10:21:10.000Z",
      parserName: "courier-audit-intake",
      parserVersion: "1.0.0",
      mode: "DETERMINISTIC" as const,
      modelProvider: null,
      modelName: null,
      promptVersion: null,
      result: {
        companyName: "Synthetic Merchant",
        contactName: null,
        contactEmail: null,
        contactPhone: null,
        courierName: "Synthetic Courier",
        documentKinds: ["COURIER_INVOICE"],
        invoiceNumbers: [],
        billingPeriodStart: null,
        billingPeriodEnd: null,
        currency: "INR",
        totalBilledAmount: null,
        shipmentCount: null,
        awbSamples: [],
        summary: "Synthetic test evidence"
      },
      warnings: [],
      confidence: null
    }
  };
}

function signedHeaders(body: string, timestamp = String(Math.floor(Date.now() / 1000))) {
  const payload = JSON.parse(body) as { source: { provider: "GMAIL"; accountId: string; messageId: string } };
  return {
    "content-type": "application/json",
    "x-shipmastr-intake-timestamp": timestamp,
    "x-shipmastr-intake-signature": createCourierAuditIntakeSignature({
      rawBody: Buffer.from(body, "utf8"),
      timestamp,
      secret: SIGNING_SECRET
    }),
    "idempotency-key": deriveCourierAuditIdempotencyKey(payload.source)
  };
}

function createParserApp(router: express.Router) {
  const app = express();
  app.use(express.json({
    limit: "256kb",
    verify: (req, _res, buffer) => {
      (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
    }
  }));
  app.use(ROUTE_PATH, router);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
      ? error.status
      : 500;
    return res.status(status === 413 ? 413 : 500).json({ error: status === 413 ? "PAYLOAD_TOO_LARGE" : "UNEXPECTED_TEST_ERROR" });
  });
  return app;
}

async function sendRequest(app: Express, body: string, headers: Record<string, string> = {}) {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${ROUTE_PATH}`, {
      method: "POST",
      headers,
      body
    });
    const text = await response.text();
    let parsedBody: unknown;
    try {
      parsedBody = text ? JSON.parse(text) as unknown : undefined;
    } catch {
      parsedBody = undefined;
    }
    return {
      status: response.status,
      text,
      body: parsedBody
    };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

function createMemoryIngest() {
  const ids = new Map<string, string>();
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    ingest: async (request: unknown): Promise<IngestResult> => {
      calls += 1;
      const source = (request as { source: { provider: "GMAIL"; accountId: string; messageId: string } }).source;
      const key = deriveCourierAuditIdempotencyKey(source);
      const existingId = ids.get(key);
      if (existingId) {
        return { intakeId: existingId, ingestionStatus: "VALIDATED", reviewStatus: "NEEDS_REVIEW", duplicate: true };
      }
      const intakeId = "00000000-0000-4000-8000-000000000001";
      ids.set(key, intakeId);
      return { intakeId, ingestionStatus: "VALIDATED", reviewStatus: "NEEDS_REVIEW", duplicate: false };
    }
  };
}

test("feature-disabled intake route is unmounted from the API router", async () => {
  const routes = await import(new URL("../../routes/index.js", import.meta.url).href) as unknown as { apiRouter: express.Router };
  const app = express();
  app.use("/api", routes.apiRouter);

  const response = await sendRequest(app, JSON.stringify(basePayload()), { "content-type": "application/json" });

  assert.equal(response.status, 404);
});

test("valid signed exact body returns 201 then 200 for an exact duplicate", async () => {
  const routes = await loadIntakeRoutes();
  const memory = createMemoryIngest();
  const app = createParserApp(routes.createCourierAuditIntakeRouter({ signingSecret: SIGNING_SECRET, ingest: memory.ingest }));
  const body = JSON.stringify(basePayload());

  const first = await sendRequest(app, body, signedHeaders(body));
  const duplicate = await sendRequest(app, body, signedHeaders(body));

  assert.equal(first.status, 201);
  assert.deepEqual(first.body, {
    intakeId: "00000000-0000-4000-8000-000000000001",
    ingestionStatus: "VALIDATED",
    reviewStatus: "NEEDS_REVIEW",
    duplicate: false
  });
  assert.equal(duplicate.status, 200);
  assert.deepEqual(duplicate.body, { ...first.body as object, duplicate: true });
  assert.equal(memory.calls, 2);
});

test("changed whitespace with the old signature returns the generic authentication error", async () => {
  const routes = await loadIntakeRoutes();
  const memory = createMemoryIngest();
  const app = createParserApp(routes.createCourierAuditIntakeRouter({ signingSecret: SIGNING_SECRET, ingest: memory.ingest }));
  const compactBody = JSON.stringify(basePayload());
  const spacedBody = JSON.stringify(JSON.parse(compactBody), null, 2);
  const headers = signedHeaders(compactBody);

  const response = await sendRequest(app, spacedBody, headers);

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, { error: "INVALID_INTAKE_AUTHENTICATION" });
  assert.equal(memory.calls, 0);
});

test("missing raw body fails closed with a generic 401", async () => {
  const routes = await loadIntakeRoutes();
  const memory = createMemoryIngest();
  const app = express();
  app.use(ROUTE_PATH, routes.createCourierAuditIntakeRouter({ signingSecret: SIGNING_SECRET, ingest: memory.ingest }));
  const body = JSON.stringify(basePayload());

  const response = await sendRequest(app, body, signedHeaders(body));

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, { error: "INVALID_INTAKE_AUTHENTICATION" });
  assert.equal(memory.calls, 0);
});

test("missing or malformed authentication material never exposes a reason oracle", async () => {
  const routes = await loadIntakeRoutes();
  const body = JSON.stringify(basePayload());
  const cases = [
    {},
    { ...signedHeaders(body), "x-shipmastr-intake-timestamp": "not-a-timestamp" },
    { ...signedHeaders(body), "x-shipmastr-intake-signature": "sha256=" + "A".repeat(64) },
    { ...signedHeaders(body), "x-shipmastr-intake-signature": "sha256=not-hex" }
  ];

  for (const headers of cases) {
    const app = createParserApp(routes.createCourierAuditIntakeRouter({ signingSecret: SIGNING_SECRET, ingest: async () => {
      throw new Error("persistence must not run");
    } }));
    const response = await sendRequest(app, body, headers);
    assert.equal(response.status, 401);
    assert.deepEqual(response.body, { error: "INVALID_INTAKE_AUTHENTICATION" });
    assert.equal(/timestamp|signature|secret/i.test(response.text), false);
  }
});

test("stale and excessively future signed requests return 401", async () => {
  const routes = await loadIntakeRoutes();
  const body = JSON.stringify(basePayload());
  for (const timestamp of [
    String(Math.floor(Date.now() / 1000) - 301),
    String(Math.floor(Date.now() / 1000) + 301)
  ]) {
    const app = createParserApp(routes.createCourierAuditIntakeRouter({ signingSecret: SIGNING_SECRET, ingest: async () => {
      throw new Error("persistence must not run");
    } }));
    const response = await sendRequest(app, body, signedHeaders(body, timestamp));
    assert.equal(response.status, 401);
    assert.deepEqual(response.body, { error: "INVALID_INTAKE_AUTHENTICATION" });
  }
});

test("strict schema errors are returned only after authentication succeeds", async () => {
  const routes = await loadIntakeRoutes();
  const memory = createMemoryIngest();
  const app = createParserApp(routes.createCourierAuditIntakeRouter({ signingSecret: SIGNING_SECRET, ingest: memory.ingest }));
  const body = JSON.stringify({ ...basePayload(), unexpected: true });

  const response = await sendRequest(app, body, signedHeaders(body));

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: "INVALID_COURIER_AUDIT_INTAKE" });
  assert.equal(memory.calls, 0);
});

test("idempotency mismatch is rejected before persistence", async () => {
  const routes = await loadIntakeRoutes();
  const memory = createMemoryIngest();
  const app = createParserApp(routes.createCourierAuditIntakeRouter({ signingSecret: SIGNING_SECRET, ingest: memory.ingest }));
  const body = JSON.stringify(basePayload());

  const response = await sendRequest(app, body, { ...signedHeaders(body), "idempotency-key": "f".repeat(64) });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: "INVALID_IDEMPOTENCY_KEY" });
  assert.equal(memory.calls, 0);
});

test("source fingerprint conflicts return 409 without a generic error response", async () => {
  const routes = await loadIntakeRoutes();
  const app = createParserApp(routes.createCourierAuditIntakeRouter({
    signingSecret: SIGNING_SECRET,
    ingest: async () => {
      throw new CourierAuditIntakeConflictError();
    }
  }));
  const body = JSON.stringify(basePayload());

  const response = await sendRequest(app, body, signedHeaders(body));

  assert.equal(response.status, 409);
  assert.deepEqual(response.body, { error: "COURIER_AUDIT_INTAKE_SOURCE_CONFLICT" });
});

test("the inbound limiter allows 60 requests per minute per source IP and rejects the 61st", async () => {
  const routes = await loadIntakeRoutes();
  assert.equal(routes.courierAuditIntakeRateLimit.windowMs, 60_000);
  assert.equal(routes.courierAuditIntakeRateLimit.limit, 60);
  const app = createParserApp(routes.createCourierAuditIntakeRouter({ signingSecret: SIGNING_SECRET, ingest: async () => {
    throw new Error("persistence must not run");
  } }));
  const body = JSON.stringify(basePayload());

  const statuses: number[] = [];
  for (let index = 0; index < 61; index += 1) {
    statuses.push((await sendRequest(app, body, { "content-type": "application/json" })).status);
  }

  assert.equal(statuses.slice(0, 60).every((status) => status === 401), true);
  assert.equal(statuses[60], 429);
});

test("the global 256kb JSON parser rejects oversize bodies before persistence", async () => {
  const routes = await loadIntakeRoutes();
  let calls = 0;
  const app = createParserApp(routes.createCourierAuditIntakeRouter({ signingSecret: SIGNING_SECRET, enableRateLimit: false, ingest: async () => {
    calls += 1;
    throw new Error("persistence must not run");
  } }));
  const payload = basePayload();
  payload.extraction.result.summary = "x".repeat(270_000);
  const body = JSON.stringify(payload);

  const response = await sendRequest(app, body, signedHeaders(body));

  assert.equal(response.status, 413);
  assert.deepEqual(response.body, { error: "PAYLOAD_TOO_LARGE" });
  assert.equal(calls, 0);
});

test("logger redactions explicitly cover intake signature and idempotency header dot and bracket paths", () => {
  for (const path of [
    "req.headers.x-shipmastr-intake-signature",
    "req.headers.idempotency-key",
    "req.headers['x-shipmastr-intake-signature']",
    "req.headers['idempotency-key']"
  ]) {
    assert.equal(loggerRedactPaths.includes(path), true, `missing logger redaction: ${path}`);
  }
  assert.equal(loggerRedactPaths.includes("req.headers.authorization"), true);
  assert.equal(loggerRedactPaths.includes("req.headers.x-shipmastr-signature"), true);
});
