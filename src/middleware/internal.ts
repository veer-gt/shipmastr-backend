import type { RequestHandler } from "express";
import { env } from "../config/env.js";
import { HttpError } from "../lib/httpError.js";

export const requireInternalSecret: RequestHandler = (req, _res, next) => {
  const secret = req.header("x-shipmastr-task-secret") || req.header("x-internal-secret");
  const expectedSecret = env.SHIPMASTR_INTERNAL_PROVISIONING_SECRET || env.SHIPMASTR_INTERNAL_SECRET || env.WEBHOOK_SECRET;

  if (!secret || secret !== expectedSecret) {
    throw new HttpError(401, "UNAUTHORIZED_INTERNAL_TASK");
  }

  next();
};
