import { Router, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";

import { env } from "../../config/env.js";
import {
  deriveCourierAuditIdempotencyKey,
  verifyCourierAuditIntakeAuth
} from "./courier-audit-intake.crypto.js";
import {
  courierAuditIntakeRequestSchema,
  type CourierAuditIntakeRequest
} from "./courier-audit-intake.contract.js";
import {
  CourierAuditIntakeConflictError,
  ingestCourierAuditIntake,
  type CourierAuditIngestResult
} from "./courier-audit-intake.service.js";

export const courierAuditIntakeRateLimit = {
  windowMs: 60_000,
  limit: 60
};

type RouteOptions = {
  signingSecret?: string;
  ingest?: (request: CourierAuditIntakeRequest) => Promise<CourierAuditIngestResult>;
  enableRateLimit?: boolean;
};

function invalidAuthentication(res: Response) {
  return res.status(401).json({ error: "INVALID_INTAKE_AUTHENTICATION" });
}

export function createCourierAuditIntakeRouter(options: RouteOptions = {}) {
  const router = Router();
  const signingSecret = options.signingSecret ?? env.COURIER_AUDIT_INTAKE_SIGNING_SECRET;
  const ingest = options.ingest ?? ingestCourierAuditIntake;
  const limiter = rateLimit({
    ...courierAuditIntakeRateLimit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "TOO_MANY_COURIER_AUDIT_INTAKES" }
  });
  const rateLimitMiddleware = options.enableRateLimit === false ? [] : [limiter];

  router.post("/", ...rateLimitMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    const timestamp = req.header("x-shipmastr-intake-timestamp");
    const signature = req.header("x-shipmastr-intake-signature");
    if (!signingSecret) {
      return invalidAuthentication(res);
    }
    const authInput = {
      secret: signingSecret,
      ...(req.rawBody === undefined ? {} : { rawBody: req.rawBody }),
      ...(timestamp === undefined ? {} : { timestamp }),
      ...(signature === undefined ? {} : { signature })
    };
    if (!verifyCourierAuditIntakeAuth(authInput)) {
      return invalidAuthentication(res);
    }

    const contentType = req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      return res.status(400).json({ error: "INVALID_COURIER_AUDIT_INTAKE_CONTENT_TYPE" });
    }

    const parsed = courierAuditIntakeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "INVALID_COURIER_AUDIT_INTAKE" });
    }

    const expectedKey = deriveCourierAuditIdempotencyKey(parsed.data.source);
    if (req.header("idempotency-key") !== expectedKey) {
      return res.status(400).json({ error: "INVALID_IDEMPOTENCY_KEY" });
    }

    try {
      const result = await ingest(parsed.data);
      return res.status(result.duplicate ? 200 : 201).json(result);
    } catch (error) {
      if (error instanceof CourierAuditIntakeConflictError) {
        return res.status(409).json({ error: "COURIER_AUDIT_INTAKE_SOURCE_CONFLICT" });
      }
      return next(error);
    }
  });

  return router;
}

export const courierAuditIntakeRouter = createCourierAuditIntakeRouter();
