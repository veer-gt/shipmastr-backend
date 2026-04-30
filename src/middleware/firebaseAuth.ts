import type { Request, Response, NextFunction } from "express";
import type { DecodedIdToken } from "firebase-admin/auth";
import admin from "../lib/firebase.js";
import { prisma } from "../lib/prisma.js";

export type AuthUser = {
  userId: string;
  merchantId: string;
  role: string;
  firebaseUid?: string;
};

export type FirebaseRequestUser = {
  firebaseUid: string;
  email: string | null;
  phone: string | null;
};

declare global {
  namespace Express {
    interface Request {
      auth?: AuthUser;
      user?: FirebaseRequestUser;
    }
  }
}

export async function requireFirebaseAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing Firebase token" });
  }

  let decoded: DecodedIdToken;

  try {
    decoded = await admin.auth().verifyIdToken(token);
  } catch {
    return res.status(401).json({ error: "Invalid Firebase token" });
  }

  const email = decoded.email ?? null;
  const phone = decoded.phone_number ?? null;

  req.user = {
    firebaseUid: decoded.uid,
    email,
    phone,
  };

  try {
    const user = await resolveFirebaseUser(decoded.uid, email);

    req.auth = {
      userId: user.id,
      merchantId: user.merchant.id,
      role: user.role,
      firebaseUid: decoded.uid,
    };

    next();
  } catch (error) {
    if (error instanceof Error && error.message === "FIREBASE_USER_NOT_MAPPED") {
      return res.status(403).json({ error: "Firebase user is not mapped to a merchant" });
    }

    return next(error);
  }
}

async function resolveFirebaseUser(firebaseUid: string, email: string | null) {
  const existingByUid = await prisma.user.findUnique({
    where: { firebaseUid },
    include: { merchant: true },
  });

  if (existingByUid) {
    return existingByUid;
  }

  if (email) {
    const existingByEmail = await prisma.user.findUnique({
      where: { email },
      include: { merchant: true },
    });

    if (existingByEmail) {
      return prisma.user.update({
        where: { id: existingByEmail.id },
        data: { firebaseUid },
        include: { merchant: true },
      });
    }
  }

  throw new Error("FIREBASE_USER_NOT_MAPPED");
}
