import type { ErrorRequestHandler } from "express";
import { isProxy } from "node:util/types";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { HttpError, PublicHttpError } from "../lib/httpError.js";
import { logger } from "../lib/logger.js";
import { clientNetworkKey } from "../lib/client-network.js";

const HTTP_DETAIL_KEY_ALLOWLIST = new Set([
  "field", "fields", "index", "limit", "reason", "reasons", "status",
  "mode", "event", "events", "fromState", "toState"
]);
const MAX_LOGGED_NAMES = 12;
const MAX_SCHEMA_NAME_LENGTH = 64;
const MAX_SCHEMA_FIELDS = 12;

const schemaModels = new Map(Prisma.dmmf.datamodel.models.map((model) => [
  model.name,
  {
    fields: new Set(model.fields.map((field) => field.name))
  }
]));

function detailType(value: unknown) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function summarizeHttpDetails(value: unknown) {
  try {
    const type = detailType(value);
    if (Array.isArray(value)) return { type, itemCount: value.length };
    if (!value || typeof value !== "object") return { type };
    const keys = Object.keys(value);
    return {
      type,
      keyCount: keys.length,
      keys: keys.filter((key) => HTTP_DETAIL_KEY_ALLOWLIST.has(key)).slice(0, MAX_LOGGED_NAMES)
    };
  } catch {
    return { type: "uninspectable" };
  }
}

function summarizePrismaUniqueConstraint(meta: unknown) {
  try {
    if (!meta || typeof meta !== "object") return {};
    const candidate = meta as { modelName?: unknown; target?: unknown };
    const modelName = candidate.modelName;
    if (typeof modelName !== "string" || modelName.length > MAX_SCHEMA_NAME_LENGTH) return {};

    const schemaModel = schemaModels.get(modelName);
    if (!schemaModel) return {};

    const target = candidate.target;
    const fields: string[] = [];
    if (typeof target === "string") {
      if (target.length <= MAX_SCHEMA_NAME_LENGTH && schemaModel.fields.has(target)) fields.push(target);
    } else if (Array.isArray(target) && !isProxy(target)) {
      const targetLength = target.length;
      if (targetLength > schemaModel.fields.size) return { model: modelName };
      for (let index = 0; index < targetLength; index += 1) {
        const field = target[index];
        if (typeof field !== "string") return { model: modelName };
        if (
          fields.length < MAX_SCHEMA_FIELDS
          && field.length <= MAX_SCHEMA_NAME_LENGTH
          && schemaModel.fields.has(field)
        ) {
          fields.push(field);
        }
      }
    }

    return fields.length > 0
      ? { model: modelName, fields }
      : { model: modelName };
  } catch {
    return {};
  }
}

function isPayloadTooLargeError(err: unknown) {
  if (!err || typeof err !== "object") return false;
  const candidate = err as { type?: unknown; status?: unknown; statusCode?: unknown };
  return candidate.type === "entity.too.large" || candidate.status === 413 || candidate.statusCode === 413;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ZodError) {
    logger.warn({
      security: {
        event: "request_validation_rejected",
        fields: err.issues.slice(0, 12).map((issue) => ({
          field: issue.path.join(".") || "body",
          rule: issue.code
        })),
        route: req.originalUrl.split("?")[0],
        method: req.method,
        truncatedNetworkIdentifier: clientNetworkKey(req)
      }
    }, "Request validation rejected");
    return res.status(400).json({
      error: "VALIDATION_ERROR",
      details: err.flatten()
    });
  }

  if (err instanceof HttpError) {
    logger.warn({
      security: {
        event: "request_http_error_rejected",
        status: err.status,
        code: err.message,
        method: req.method,
        route: req.originalUrl.split("?")[0],
        truncatedNetworkIdentifier: clientNetworkKey(req),
        details: summarizeHttpDetails(err.details)
      }
    }, "HTTP request rejected");
    const body = err instanceof PublicHttpError && err.publicDetails
      ? { error: err.message, details: err.publicDetails }
      : { error: err.message };
    return res.status(err.status).json(body);
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "NOT_FOUND" });
    }

    if (err.code === "P2002") {
      logger.warn({
        security: {
          event: "database_unique_constraint_rejected",
          method: req.method,
          route: req.originalUrl.split("?")[0],
          truncatedNetworkIdentifier: clientNetworkKey(req),
          ...summarizePrismaUniqueConstraint(err.meta)
        }
      }, "Database unique constraint rejected");
      return res.status(409).json({ error: "UNIQUE_CONSTRAINT_VIOLATION" });
    }
  }

  if (isPayloadTooLargeError(err)) {
    return res.status(413).json({ error: "PAYLOAD_TOO_LARGE" });
  }

  logger.error({ err }, "Unhandled error");
  return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
};
