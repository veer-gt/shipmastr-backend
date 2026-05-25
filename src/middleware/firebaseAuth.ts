import type { Request, Response, NextFunction } from "express";
import admin from "../lib/firebase.js";
import { normalizeAccountRole } from "../lib/accountRoles.js";
import { prisma } from "../lib/prisma.js";

export type AuthUser = {
  userId: string;
  merchantId: string;
  courierId?: string;
  role: string;
  firebaseUid?: string;
  email?: string | null;
  phone?: string | null;
};

export type FirebaseRequestUser = {
  id?: string;
  firebaseUid: string;
  email: string | null;
  phone: string | null;
  role?: string;
  merchantId?: string;
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

  let decoded: admin.auth.DecodedIdToken;

  try {
    decoded = await admin.auth().verifyIdToken(token);
  } catch (err) {
    console.error("Firebase token verification failed:", err);
    return res.status(401).json({ error: "Invalid Firebase token" });
  }

  const firebaseUid = decoded.uid;
  const email = decoded.email || null;
  const phone = decoded.phone_number || null;

  try {
    let user = await prisma.user.findUnique({
      where: { firebaseUid },
      include: { merchant: true },
    });

    if (!user && email) {
      const emailMatchedUser = await prisma.user.findUnique({
        where: { email },
        include: { merchant: true },
      });

      user = emailMatchedUser && !emailMatchedUser.firebaseUid
        ? await prisma.user.update({
            where: { id: emailMatchedUser.id },
            data: { firebaseUid },
            include: { merchant: true },
          })
        : emailMatchedUser;
    }

    const fallbackUser = !user && email
      ? await prisma.user.findUnique({
          where: { email },
          include: { merchant: true },
        })
      : null;
    user = user || fallbackUser;

    if (!user) {
      return res.status(403).json({
        error: "USER_NOT_ONBOARDED",
        message:
          "Firebase login is valid, but no Shipmastr Merchant or Seller account is linked to this user.",
      });
    }

    (req as any).user = {
      firebaseUid,
      email: user.email,
      phone
    };

    (req as any).auth = {
      userId: user.id,
      firebaseUid,
      email: user.email,
      phone,
      role: normalizeAccountRole(user.role),
      merchantId: user.merchantId,
    };

    next();
  } catch (err) {
    console.error("Firebase auth DB lookup failed:", err);
    return res.status(500).json({ error: "AUTH_MERCHANT_LOOKUP_FAILED" });
  }
}
