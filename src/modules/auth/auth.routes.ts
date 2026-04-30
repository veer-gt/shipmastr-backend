import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { HttpError } from "../../lib/httpError.js";

export const authRouter = Router();

authRouter.use((_req, res, next) => {
  res.setHeader("Deprecation", "true");
  res.setHeader(
    "Link",
    '</v1/auth>; rel="deprecation"; title="JWT auth is retained only for backward compatibility. Use Firebase ID tokens for protected APIs."'
  );
  next();
});

const registerSchema = z.object({
  businessName: z.string().min(2).optional(),
  merchantName: z.string().min(2).optional(),
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().optional()
}).refine((body) => body.businessName || body.merchantName, {
  path: ["businessName"],
  message: "businessName is required"
});

authRouter.post("/register", async (req, res) => {
  const body = registerSchema.parse(req.body);

  const exists = await prisma.user.findUnique({
    where: { email: body.email }
  });

  if (exists) throw new HttpError(409, "EMAIL_EXISTS");

  const passwordHash = await bcrypt.hash(body.password, 12);
  const merchantName = body.businessName || body.merchantName!;

  const merchant = await prisma.merchant.create({
    data: {
      name: merchantName,
      email: body.email
    }
  });

  const user = await prisma.user.create({
    data: {
      merchantId: merchant.id,
      email: body.email,
      passwordHash,
      ...(body.name ? { name: body.name } : {})
    }
  });

  const token = jwt.sign(
    {
      userId: user.id,
      merchantId: merchant.id,
      role: user.role
    },
    env.JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.status(201).json({
    token,
    merchant: {
      id: merchant.id,
      name: merchant.name
    }
  });
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string()
});

authRouter.post("/login", async (req, res) => {
  const body = loginSchema.parse(req.body);

  const user = await prisma.user.findUnique({
    where: { email: body.email }
  });

  if (!user) throw new HttpError(400, "INVALID_LOGIN");

  const valid = await bcrypt.compare(body.password, user.passwordHash);

  if (!valid) throw new HttpError(400, "INVALID_LOGIN");

  const token = jwt.sign(
    {
      userId: user.id,
      merchantId: user.merchantId,
      role: user.role
    },
    env.JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.json({ token });
});

authRouter.get("/me", async (req, res) => {
  const xAuthToken = req.header("x-auth-token");
  const authorization = req.header("authorization") || "";
  const token = xAuthToken || (authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "");

  if (!token) {
    return res.status(401).json({ error: "No token, authorization denied" });
  }

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as {
      userId: string;
      merchantId: string;
      role?: string;
    };

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: { merchant: true }
    });

    if (!user) return res.status(401).json({ error: "Token is not valid" });

    return res.json({
      id: user.id,
      email: user.email,
      businessName: user.merchant.name,
      merchantId: user.merchantId,
      plan: "Lite",
      role: user.role
    });
  } catch (err) {
    return res.status(401).json({ error: "Token is not valid" });
  }
});
