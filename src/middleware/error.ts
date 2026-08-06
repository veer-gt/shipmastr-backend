import type { ErrorRequestHandler, Request, Response } from "express";
import { isProxy } from "node:util/types";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import {
  getPublicHttpErrorDetails,
  HttpError,
  PublicHttpError,
  type PublicErrorDetails
} from "../lib/httpError.js";
import { logger } from "../lib/logger.js";
import { clientNetworkKey } from "../lib/client-network.js";

const HTTP_DETAIL_KEY_ALLOWLIST = new Set([
  "field", "fields", "index", "limit", "reason", "reasons", "status",
  "mode", "event", "events", "fromState", "toState"
]);
const MAX_LOGGED_NAMES = 12;
const MAX_SCHEMA_NAME_LENGTH = 64;
const MAX_SCHEMA_FIELDS = 12;
const UNINSPECTABLE_HTTP_DETAILS = Object.freeze({ type: "uninspectable" as const });

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
    if (isProxy(value)) return UNINSPECTABLE_HTTP_DETAILS;
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
    return UNINSPECTABLE_HTTP_DETAILS;
  }
}

type HttpErrorSnapshot = {
  status: number;
  message: string;
  details: unknown;
  detailsInspectable: boolean;
  publicDetails: PublicErrorDetails | undefined;
};

function snapshotHttpError(err: HttpError): HttpErrorSnapshot | undefined {
  if (isProxy(err)) return undefined;

  try {
    const descriptors = Object.getOwnPropertyDescriptors(err);
    const statusDescriptor = descriptors.status;
    const messageDescriptor = descriptors.message;
    if (
      !statusDescriptor
      || !("value" in statusDescriptor)
      || typeof statusDescriptor.value !== "number"
      || !Number.isInteger(statusDescriptor.value)
      || statusDescriptor.value < 400
      || statusDescriptor.value > 599
      || !messageDescriptor
      || !("value" in messageDescriptor)
      || typeof messageDescriptor.value !== "string"
    ) return undefined;

    const detailsDescriptor = descriptors.details;
    let details: unknown;
    let detailsInspectable = false;
    if (detailsDescriptor && "value" in detailsDescriptor) {
      details = detailsDescriptor.value;
      detailsInspectable = true;
    }
    let publicDetails: PublicErrorDetails | undefined;
    if (err instanceof PublicHttpError) {
      publicDetails = getPublicHttpErrorDetails(err);
    }

    return {
      status: statusDescriptor.value,
      message: messageDescriptor.value,
      details,
      detailsInspectable,
      publicDetails
    };
  } catch {
    return undefined;
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

type PayloadTooLargeClassification = "payload-too-large" | "not-payload-too-large" | "uninspectable";

function classifyPayloadTooLargeError(err: unknown): PayloadTooLargeClassification {
  if ((typeof err !== "object" && typeof err !== "function") || err === null) {
    return "not-payload-too-large";
  }

  try {
    const descriptors = Object.getOwnPropertyDescriptors(err);
    const markerDescriptors = [descriptors.type, descriptors.status, descriptors.statusCode];
    if (markerDescriptors.some((descriptor) => descriptor && !("value" in descriptor))) {
      return "uninspectable";
    }

    const type = descriptors.type && "value" in descriptors.type
      ? descriptors.type.value
      : undefined;
    const status = descriptors.status && "value" in descriptors.status
      ? descriptors.status.value
      : undefined;
    const statusCode = descriptors.statusCode && "value" in descriptors.statusCode
      ? descriptors.statusCode.value
      : undefined;
    return type === "entity.too.large" || status === 413 || statusCode === 413
      ? "payload-too-large"
      : "not-payload-too-large";
  } catch {
    return "uninspectable";
  }
}

function respondToUninspectableRoot(req: Request, res: Response) {
  logger.error({
    security: {
      event: "uninspectable_request_error",
      method: req.method,
      route: req.originalUrl.split("?")[0],
      truncatedNetworkIdentifier: clientNetworkKey(req)
    }
  }, "Uninspectable request error");
  return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (isProxy(err)) return respondToUninspectableRoot(req, res);

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
    const snapshot = snapshotHttpError(err);
    const status = snapshot?.status ?? 500;
    const message = snapshot?.message ?? "INTERNAL_SERVER_ERROR";
    const details = snapshot?.detailsInspectable
      ? summarizeHttpDetails(snapshot.details)
      : UNINSPECTABLE_HTTP_DETAILS;
    logger.warn({
      security: {
        event: "request_http_error_rejected",
        status,
        code: message,
        method: req.method,
        route: req.originalUrl.split("?")[0],
        truncatedNetworkIdentifier: clientNetworkKey(req),
        details
      }
    }, "HTTP request rejected");
    const body = snapshot?.publicDetails
      ? { error: message, details: snapshot.publicDetails }
      : { error: message };
    return res.status(status).json(body);
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    let code: unknown;
    try {
      code = err.code;
    } catch {
      code = undefined;
    }

    if (code === "P2025") {
      return res.status(404).json({ error: "NOT_FOUND" });
    }

    if (code === "P2002") {
      let meta: unknown;
      try {
        meta = err.meta;
      } catch {
        meta = undefined;
      }
      logger.warn({
        security: {
          event: "database_unique_constraint_rejected",
          method: req.method,
          route: req.originalUrl.split("?")[0],
          truncatedNetworkIdentifier: clientNetworkKey(req),
          ...summarizePrismaUniqueConstraint(meta)
        }
      }, "Database unique constraint rejected");
      return res.status(409).json({ error: "UNIQUE_CONSTRAINT_VIOLATION" });
    }

    logger.error({
      security: {
        event: "database_request_failed",
        code: typeof code === "string" && /^P[0-9]{4}$/.test(code) ? code : "UNKNOWN",
        method: req.method,
        route: req.originalUrl.split("?")[0],
        truncatedNetworkIdentifier: clientNetworkKey(req)
      }
    }, "Database request failed");
    return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  }

  const payloadTooLargeClassification = classifyPayloadTooLargeError(err);
  if (payloadTooLargeClassification === "payload-too-large") {
    return res.status(413).json({ error: "PAYLOAD_TOO_LARGE" });
  }
  if (payloadTooLargeClassification === "uninspectable") {
    return respondToUninspectableRoot(req, res);
  }

  logger.error({ err }, "Unhandled error");
  return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
};
