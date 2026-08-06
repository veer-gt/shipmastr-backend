import type { ErrorRequestHandler } from "express";
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
      return res.status(409).json({
        error: "UNIQUE_CONSTRAINT_VIOLATION",
        details: err.meta
      });
    }
  }

  if (isPayloadTooLargeError(err)) {
    return res.status(413).json({ error: "PAYLOAD_TOO_LARGE" });
  }

  logger.error({ err }, "Unhandled error");
  return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
};
