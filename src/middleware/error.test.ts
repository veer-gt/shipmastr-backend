import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { Prisma } from "@prisma/client";
import express from "express";
import { ZodError } from "zod";

import { HttpError, PublicHttpError } from "../lib/httpError.js";
import { logger } from "../lib/logger.js";
import { errorHandler } from "./error.js";

async function withApp<T>(
  callback: (baseUrl: string) => Promise<T>,
  throwFromFailure?: () => unknown,
  handler = errorHandler
) {
  const app = express();
  app.use(express.json({ limit: "1kb" }));
  app.post("/json", (_req, res) => res.json({ ok: true }));
  if (throwFromFailure) app.get("/failure", () => { throw throwFromFailure(); });
  app.use(handler);

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

function p2002(meta: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: Prisma.prismaVersion.client,
    meta
  });
}

function p2003(message: string, meta: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code: "P2003",
    clientVersion: Prisma.prismaVersion.client,
    meta
  });
}

function p2025() {
  return new Prisma.PrismaClientKnownRequestError("missing", {
    code: "P2025",
    clientVersion: Prisma.prismaVersion.client
  });
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

async function captureErrors<T>(callback: (errors: unknown[][]) => Promise<T>) {
  const errors: unknown[][] = [];
  const original = logger.error;
  logger.error = ((...args: unknown[]) => { errors.push(args); }) as typeof logger.error;
  try {
    return await callback(errors);
  } finally {
    logger.error = original;
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

  it("returns flattened Zod details while keeping invalid values out of validation warnings", async () => {
    const invalidValue = "sk-zod-input-must-not-leak";
    const error = new ZodError([{
      code: "custom",
      path: ["email"],
      message: "invalid",
      input: invalidValue
    }]);

    await captureWarnings(async (warnings) => {
      await withApp(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/failure`);
        const body = await response.json();

        assert.equal(response.status, 400);
        assert.deepEqual(body, {
          error: "VALIDATION_ERROR",
          details: { formErrors: [], fieldErrors: { email: ["invalid"] } }
        });
        assert.equal(JSON.stringify({ body, warnings }).includes(invalidValue), false);
      }, () => error);

      const warning = warnings[0]?.[0] as {
        security?: { event?: unknown; fields?: unknown };
      };
      assert.equal(warning.security?.event, "request_validation_rejected");
      assert.deepEqual(warning.security?.fields, [{ field: "email", rule: "custom" }]);
    });
  });

  it("returns an exact P2025 not-found response", async () => {
    await withApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/failure`);

      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "NOT_FOUND" });
    }, p2025);
  });

  it("logs a bounded P2003 event without the raw Prisma error or request query", async () => {
    const databaseUrl = "postgresql://raw-prisma-user:raw-prisma-pass@internal.invalid/db?token=sk-raw-prisma";
    const metadataToken = "sk-p2003-metadata-must-not-leak";
    const queryToken = "sk-p2003-query-must-not-leak";
    const error = p2003(`Foreign key constraint failed for ${databaseUrl}`, {
      field_name: "Order_merchantId_fkey",
      databaseUrl,
      token: metadataToken
    });

    await captureErrors(async (errors) => {
      await withApp(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/failure?token=${encodeURIComponent(queryToken)}`);

        assert.equal(response.status, 500);
        assert.deepEqual(await response.json(), { error: "INTERNAL_SERVER_ERROR" });
      }, () => error);

      assert.equal(errors.length, 1);
      const record = errors[0]?.[0] as {
        err?: unknown;
        security?: {
          event?: unknown;
          code?: unknown;
          method?: unknown;
          route?: unknown;
          truncatedNetworkIdentifier?: unknown;
        };
      };
      const serializedErrors = JSON.stringify(errors);
      assert.deepEqual({
        rawErrorObject: record.err === error,
        containsDatabaseUrl: serializedErrors.includes(databaseUrl),
        containsMetadataToken: serializedErrors.includes(metadataToken),
        containsQueryToken: serializedErrors.includes(queryToken),
        containsRawErrProperty: Object.prototype.hasOwnProperty.call(record, "err")
      }, {
        rawErrorObject: false,
        containsDatabaseUrl: false,
        containsMetadataToken: false,
        containsQueryToken: false,
        containsRawErrProperty: false
      });
      assert.equal(record.security?.event, "database_request_failed");
      assert.equal(record.security?.code, "P2003");
      assert.equal(record.security?.method, "GET");
      assert.equal(record.security?.route, "/failure");
      assert.match(String(record.security?.truncatedNetworkIdentifier), /^[a-f0-9]{24}$/);
      assert.equal(errors[0]?.[1], "Database request failed");
    });
  });

  it("replaces malformed Prisma request codes with UNKNOWN", async () => {
    const sentinel = "postgresql://malformed-code-user:malformed-code-pass@internal.invalid/private";
    const error = new Prisma.PrismaClientKnownRequestError("malformed known request error", {
      code: `P2003-${sentinel}`,
      clientVersion: Prisma.prismaVersion.client,
      meta: { sentinel }
    });

    await captureErrors(async (errors) => {
      await withApp(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/failure`);

        assert.equal(response.status, 500);
        assert.deepEqual(await response.json(), { error: "INTERNAL_SERVER_ERROR" });
      }, () => error);

      assert.equal(errors.length, 1);
      const record = errors[0]?.[0] as {
        err?: unknown;
        security?: { code?: unknown };
      };
      assert.equal(record.security?.code, "UNKNOWN");
      assert.equal(Object.prototype.hasOwnProperty.call(record, "err"), false);
      assert.equal(JSON.stringify(errors).includes(sentinel), false);
    });
  });

  it("returns an exact generic 500 response without the internal message", async () => {
    const internalMessage = "sentinel-internal-message";
    const error = new Error(internalMessage);

    await captureErrors(async (errors) => {
      await withApp(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/failure`);

        assert.equal(response.status, 500);
        assert.deepEqual(await response.json(), { error: "INTERNAL_SERVER_ERROR" });
      }, () => error);

      assert.equal(errors.length, 1);
      assert.equal((errors[0]?.[0] as { err?: unknown }).err, error);
      assert.equal(errors[0]?.[1], "Unhandled error");
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

  it("returns an exact safe P2002 response and logs bounded known schema context", async () => {
    const plantedValues = {
      token: "sk-planted-private-token",
      secret: "planted-webhook-secret",
      databaseUrl: "postgresql://db-user:db-pass@internal.example/shipmastr",
      provider: "planted-database-provider",
      arbitrary: "planted-arbitrary-metadata"
    };
    const error = p2002({
      modelName: "Merchant",
      target: ["email", "id"],
      ...plantedValues
    });

    await captureWarnings(async (warnings) => {
      await withApp(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/failure?token=${encodeURIComponent(plantedValues.token)}`);
        const body = await response.json();

        assert.equal(response.status, 409);
        assert.deepEqual(body, { error: "UNIQUE_CONSTRAINT_VIOLATION" });
        const serializedBoundary = JSON.stringify({ body, warnings });
        for (const value of Object.values(plantedValues)) {
          assert.equal(serializedBoundary.includes(value), false);
        }
        assert.equal(serializedBoundary.includes(`/failure?token=${encodeURIComponent(plantedValues.token)}`), false);
      }, () => error);

      assert.equal(warnings.length, 1);
      const warning = warnings[0]?.[0] as {
        security?: {
          event?: unknown;
          method?: unknown;
          route?: unknown;
          truncatedNetworkIdentifier?: unknown;
          model?: unknown;
          fields?: unknown;
        };
      };
      assert.equal(warning.security?.event, "database_unique_constraint_rejected");
      assert.equal(warning.security?.method, "GET");
      assert.equal(warning.security?.route, "/failure");
      assert.match(String(warning.security?.truncatedNetworkIdentifier), /^[a-f0-9]{24}$/);
      assert.equal(warning.security?.model, "Merchant");
      assert.deepEqual(warning.security?.fields, ["email", "id"]);
    });
  });

  it("omits all schema identifiers for an unknown P2002 model", async () => {
    await captureWarnings(async (warnings) => {
      await withApp(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/failure`);
        assert.equal(response.status, 409);
        await response.json();
      }, () => p2002({
        modelName: "UnknownDatabaseModel",
        target: ["email"],
        constraint: "UnknownDatabaseModel_email_key"
      }));

      const security = (warnings[0]?.[0] as { security?: Record<string, unknown> }).security;
      assert.ok(security);
      assert.equal("model" in security, false);
      assert.equal("fields" in security, false);
      assert.equal("constraint" in security, false);
    });
  });

  it("retains only DMMF-known P2002 fields", async () => {
    await captureWarnings(async (warnings) => {
      await withApp(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/failure`);
        assert.equal(response.status, 409);
        await response.json();
      }, () => p2002({
        modelName: "Merchant",
        target: ["unknownField", "email", "hostile;DROP TABLE Merchant", "id"]
      }));

      const security = (warnings[0]?.[0] as {
        security?: { model?: unknown; fields?: unknown };
      }).security;
      assert.equal(security?.model, "Merchant");
      assert.deepEqual(security?.fields, ["email", "id"]);
    });
  });

  it("accepts one known scalar target and omits unknown or malformed target shapes", async () => {
    const cases: Array<{ target: unknown; fields?: string[] }> = [
      { target: "email", fields: ["email"] },
      { target: "Merchant_email_key" },
      { target: "postgresql://hostile-target.invalid/private" },
      { target: 42 },
      { target: { field: "email" } },
      { target: [["email"]] },
      { target: ["email", { field: "id" }] },
      { target: null }
    ];

    await captureWarnings(async (warnings) => {
      for (const testCase of cases) {
        await withApp(async (baseUrl) => {
          const response = await fetch(`${baseUrl}/failure`);
          assert.equal(response.status, 409);
          assert.deepEqual(await response.json(), { error: "UNIQUE_CONSTRAINT_VIOLATION" });
        }, () => p2002({ modelName: "Merchant", target: testCase.target }));
      }

      assert.equal(warnings.length, cases.length);
      cases.forEach((testCase, index) => {
        const security = (warnings[index]?.[0] as {
          security?: { model?: unknown; fields?: unknown };
        }).security;
        assert.equal(security?.model, "Merchant");
        assert.deepEqual(security?.fields, testCase.fields);
      });
    });
  });

  it("omits schema-known model and field names longer than 64 characters in a compiled fresh import", async () => {
    const models = Prisma.dmmf.datamodel.models;
    const mutableModels = models as unknown as Array<(typeof models)[number]>;
    const templateModel = models.find((model) => model.name === "Merchant");
    const templateField = templateModel?.fields.find((field) => field.name === "id");
    assert.ok(templateModel);
    assert.ok(templateField);

    const originalModelCount = models.length;
    const overlongModelName = "M".repeat(65);
    const overlongFieldName = "f".repeat(65);
    mutableModels.push(
      {
        ...templateModel,
        name: overlongModelName,
        fields: [{ ...templateField, name: "id" }]
      },
      {
        ...templateModel,
        name: "BoundaryModel",
        fields: [
          { ...templateField, name: "id" },
          { ...templateField, name: overlongFieldName }
        ]
      }
    );

    try {
      const runtimeUrl = new URL("./error.js", import.meta.url);
      runtimeUrl.searchParams.set("nonce", `${Date.now()}-${Math.random()}`);
      const { errorHandler: freshErrorHandler } = await import(runtimeUrl.href);

      await captureWarnings(async (warnings) => {
        await withApp(async (baseUrl) => {
          const response = await fetch(`${baseUrl}/failure`);
          assert.equal(response.status, 409);
          await response.json();
        }, () => p2002({ modelName: overlongModelName, target: ["id"] }), freshErrorHandler);

        await withApp(async (baseUrl) => {
          const response = await fetch(`${baseUrl}/failure`);
          assert.equal(response.status, 409);
          await response.json();
        }, () => p2002({ modelName: "BoundaryModel", target: [overlongFieldName, "id"] }), freshErrorHandler);

        const longModelSecurity = (warnings[0]?.[0] as {
          security?: Record<string, unknown>;
        }).security;
        assert.ok(longModelSecurity);
        assert.equal("model" in longModelSecurity, false);
        assert.equal("fields" in longModelSecurity, false);

        const longFieldSecurity = (warnings[1]?.[0] as {
          security?: { model?: unknown; fields?: unknown };
        }).security;
        assert.equal(longFieldSecurity?.model, "BoundaryModel");
        assert.deepEqual(longFieldSecurity?.fields, ["id"]);
      });
    } finally {
      mutableModels.splice(originalModelCount);
    }
  });

  it("caps P2002 warning fields at 12", async () => {
    const merchantFields = Prisma.dmmf.datamodel.models
      .find((model) => model.name === "Merchant")
      ?.fields.slice(0, 13).map((field) => field.name);
    assert.ok(merchantFields);
    assert.equal(merchantFields.length, 13);

    await captureWarnings(async (warnings) => {
      await withApp(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/failure`);
        assert.equal(response.status, 409);
        await response.json();
      }, () => p2002({ modelName: "Merchant", target: merchantFields }));

      const security = (warnings[0]?.[0] as {
        security?: { fields?: unknown };
      }).security;
      assert.deepEqual(security?.fields, merchantFields.slice(0, 12));
    });
  });

  it("snapshots a stateful P2002 modelName accessor before validation", async () => {
    const sentinel = "sk-stateful-model-secret";
    let modelNameReads = 0;
    const meta: Record<string, unknown> = { target: ["email"] };
    Object.defineProperty(meta, "modelName", {
      enumerable: true,
      get() {
        modelNameReads += 1;
        return modelNameReads <= 3 ? "Merchant" : sentinel;
      }
    });
    const error = p2002(meta);
    modelNameReads = 0;

    await captureWarnings(async (warnings) => {
      await withApp(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/failure`);
        assert.equal(response.status, 409);
        assert.deepEqual(await response.json(), { error: "UNIQUE_CONSTRAINT_VIOLATION" });
      }, () => error);

      assert.equal(modelNameReads, 1);
      assert.equal(JSON.stringify(warnings).includes(sentinel), false);
      const security = (warnings[0]?.[0] as {
        security?: { model?: unknown; fields?: unknown };
      }).security;
      assert.equal(security?.model, "Merchant");
      assert.deepEqual(security?.fields, ["email"]);
    });
  });

  it("fails closed for a proxied P2002 target", async () => {
    const sentinel = "postgresql://proxy-user:proxy-pass@internal.example/private";
    const target = new Proxy(["email"], {
      get(source, property, receiver) {
        if (property === "every") return () => true;
        if (property === "filter") return () => [sentinel];
        return Reflect.get(source, property, receiver);
      }
    });

    await captureWarnings(async (warnings) => {
      await withApp(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/failure`);
        assert.equal(response.status, 409);
        assert.deepEqual(await response.json(), { error: "UNIQUE_CONSTRAINT_VIOLATION" });
      }, () => p2002({ modelName: "Merchant", target }));

      assert.equal(JSON.stringify(warnings).includes(sentinel), false);
      const security = (warnings[0]?.[0] as {
        security?: { model?: unknown; fields?: unknown };
      }).security;
      assert.equal(security?.model, "Merchant");
      assert.equal(security?.fields, undefined);
    });
  });

  it("ignores overridden P2002 target collection methods", async () => {
    const sentinel = "planted-overridden-array-secret";
    const target = ["email"];
    target.every = (() => true) as unknown as typeof target.every;
    target.filter = (() => target) as typeof target.filter;
    target.slice = (() => [sentinel]) as typeof target.slice;

    await captureWarnings(async (warnings) => {
      await withApp(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/failure`);
        assert.equal(response.status, 409);
        assert.deepEqual(await response.json(), { error: "UNIQUE_CONSTRAINT_VIOLATION" });
      }, () => p2002({ modelName: "Merchant", target }));

      assert.equal(JSON.stringify(warnings).includes(sentinel), false);
      const security = (warnings[0]?.[0] as {
        security?: { model?: unknown; fields?: unknown };
      }).security;
      assert.equal(security?.model, "Merchant");
      assert.deepEqual(security?.fields, ["email"]);
    });
  });
});
