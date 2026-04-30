import type { RequestHandler } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { HttpError } from "../lib/httpError.js";

export const requireIdempotency: RequestHandler = async (req, res, next) => {
  const key = req.header("Idempotency-Key");
  const merchantId = req.auth?.merchantId;
  const route = `${req.method}:${req.baseUrl}${req.route?.path ?? req.path}`;

  if (!merchantId) {
    throw new HttpError(401, "UNAUTHORIZED");
  }

  if (!key) {
    throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED");
  }

  const existing = await prisma.idempotencyKey.findUnique({
    where: {
      merchantId_route_key: {
        merchantId,
        route,
        key
      }
    }
  });

  if (existing?.response) {
    return res.status(200).json(existing.response);
  }

  try {
    await prisma.idempotencyKey.create({
      data: {
        merchantId,
        key,
        route
      }
    });
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") {
      throw err;
    }

    const replay = await prisma.idempotencyKey.findUnique({
      where: {
        merchantId_route_key: {
          merchantId,
          route,
          key
        }
      }
    });

    if (replay?.response) {
      return res.status(200).json(replay.response);
    }

    throw new HttpError(409, "IDEMPOTENCY_KEY_IN_PROGRESS");
  }

  const originalJson = res.json.bind(res);

  res.json = (body: unknown) => {
    void prisma.idempotencyKey.update({
      where: {
        merchantId_route_key: {
          merchantId,
          route,
          key
        }
      },
      data: { response: body as object }
    });

    return originalJson(body);
  };

  next();
};
