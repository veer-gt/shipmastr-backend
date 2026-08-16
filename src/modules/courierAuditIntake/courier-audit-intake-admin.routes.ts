import { Router } from "express";
import { z } from "zod";

import { audit } from "../audit/audit.service.js";
import { HttpError } from "../../lib/httpError.js";
import {
  getCourierAuditIntakeDetail,
  listCourierAuditIntakes
} from "./courier-audit-intake.service.js";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
const MAX_DATE_RANGE_MS = 90 * 24 * 60 * 60 * 1_000;

const listQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.string().regex(/^\d+$/u).transform(Number).pipe(z.number().int().min(1).max(MAX_LIMIT)).optional(),
  from: z.string().datetime({ offset: true }).transform((value) => new Date(value)).optional(),
  to: z.string().datetime({ offset: true }).transform((value) => new Date(value)).optional()
}).strict();

type AdminRouterDependencies = {
  listCourierAuditIntakes: typeof listCourierAuditIntakes;
  getCourierAuditIntakeDetail: typeof getCourierAuditIntakeDetail;
  audit: typeof audit;
};

function parseListQuery(query: unknown) {
  const parsed = listQuerySchema.parse(query);
  if ((parsed.from === undefined) !== (parsed.to === undefined)) {
    throw new HttpError(400, "COURIER_AUDIT_INTAKE_DATE_RANGE_REQUIRES_BOTH_BOUNDS");
  }
  if (parsed.from && parsed.to && parsed.from > parsed.to) {
    throw new HttpError(400, "INVALID_COURIER_AUDIT_INTAKE_DATE_RANGE");
  }
  if (parsed.from && parsed.to && parsed.to.getTime() - parsed.from.getTime() > MAX_DATE_RANGE_MS) {
    throw new HttpError(400, "COURIER_AUDIT_INTAKE_DATE_RANGE_TOO_LARGE");
  }
  const result: Parameters<typeof listCourierAuditIntakes>[0] = {
    limit: parsed.limit ?? DEFAULT_LIMIT
  };
  if (parsed.cursor !== undefined) result.cursor = parsed.cursor;
  if (parsed.from !== undefined) result.from = parsed.from;
  if (parsed.to !== undefined) result.to = parsed.to;
  return result;
}

export function createCourierAuditIntakeAdminRouter(
  dependencies: Partial<AdminRouterDependencies> = {}
) {
  const services: AdminRouterDependencies = {
    listCourierAuditIntakes,
    getCourierAuditIntakeDetail,
    audit,
    ...dependencies
  };
  const router = Router();

  router.get("/", async (req, res) => {
    const result = await services.listCourierAuditIntakes(parseListQuery(req.query));
    return res.json(result);
  });

  router.get("/:id", async (req, res) => {
    const intake = await services.getCourierAuditIntakeDetail(req.params.id);
    if (!intake) {
      throw new HttpError(404, "COURIER_AUDIT_INTAKE_NOT_FOUND");
    }

    await services.audit({
      actorId: req.auth!.userId,
      action: "courier_audit_intake.detail_viewed",
      entityType: "CourierAuditIntake",
      entityId: intake.id,
      metadata: { status: "success" }
    });

    return res.json(intake);
  });

  return router;
}

export const courierAuditIntakeAdminRouter = createCourierAuditIntakeAdminRouter();
