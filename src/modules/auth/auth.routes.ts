import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { HttpError } from "../../lib/httpError.js";

export const authRouter = Router();

const registerSchema = z.object({
  merchantName: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().optional()
});

authRouter.post("/register", async (req, res) => {
  const body = registerSchema.parse(req.body);

  const exists = await prisma.user.findUnique({
    where: { email: body.email }
  });

  if (exists) throw new HttpError(409, "EMAIL_EXISTS");

  const passwordHash = await bcrypt.hash(body.password, 12);

  const merchant = await prisma.merchant.create({
    data: {
      name: body.merchantName,
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

  if (!user) throw new HttpError(401, "INVALID_LOGIN");

  const valid = await bcrypt.compare(body.password, user.passwordHash);

  if (!valid) throw new HttpError(401, "INVALID_LOGIN");

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
