import type { ErrorRequestHandler } from "express";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { HttpError } from "../lib/httpError.js";
import { logger } from "../lib/logger.js";

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: "VALIDATION_ERROR",
      details: err.flatten()
    });
  }

  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: err.message,
      details: err.details
    });
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

  logger.error({ err }, "Unhandled error");
  return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
};
