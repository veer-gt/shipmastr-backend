import type { RequestHandler } from "express";
import { env } from "../config/env.js";
import { HttpError } from "../lib/httpError.js";

export const requireInternalSecret: RequestHandler = (req, _res, next) => {
  const secret = req.header("x-shipmastr-task-secret");

  if (!secret || secret !== env.WEBHOOK_SECRET) {
    throw new HttpError(401, "UNAUTHORIZED_INTERNAL_TASK");
  }

  next();
};
