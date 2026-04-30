import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

type SellerJwtPayload = {
  userId: string;
  merchantId: string;
  role?: string;
};

function readToken(req: Request) {
  const xAuthToken = req.header("x-auth-token");
  if (xAuthToken) return xAuthToken.trim();

  const authorization = req.header("authorization") || "";
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }

  return "";
}

export function requireJwtAuth(req: Request, res: Response, next: NextFunction) {
  const token = readToken(req);

  if (!token) {
    return res.status(401).json({ error: "No token, authorization denied" });
  }

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as SellerJwtPayload;

    if (!decoded.userId || !decoded.merchantId) {
      return res.status(401).json({ error: "Token is not valid" });
    }

    req.auth = {
      userId: decoded.userId,
      merchantId: decoded.merchantId,
      role: decoded.role || "OWNER"
    };

    next();
  } catch (err) {
    return res.status(401).json({ error: "Token is not valid" });
  }
}
