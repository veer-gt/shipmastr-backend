#!/usr/bin/env node

if (process.env.NODE_ENV === "production" || process.env.APP_ENV === "production") {
  throw new Error("Refusing password hash audit in a production runtime");
}

const { getRounds } = await import("bcryptjs");
const { prisma } = await import("../dist/lib/prisma.js");

const counts = {
  compliant_bcrypt: 0,
  weak_bcrypt: 0,
  argon2id: 0,
  legacy_unknown: 0,
  empty_or_invalid_hash: 0
};

function classify(value) {
  const hash = typeof value === "string" ? value : "";
  if (!hash) return "empty_or_invalid_hash";
  if (hash.startsWith("$argon2id$")) return "argon2id";
  if (/^\$2[aby]\$\d{2}\$/.test(hash)) {
    try {
      return getRounds(hash) >= 12 ? "compliant_bcrypt" : "weak_bcrypt";
    } catch {
      return "empty_or_invalid_hash";
    }
  }
  return "legacy_unknown";
}

try {
  const [users, courierUsers] = await Promise.all([
    prisma.user.findMany({ select: { passwordHash: true } }),
    prisma.courierUser.findMany({ select: { passwordHash: true } })
  ]);
  for (const record of [...users, ...courierUsers]) counts[classify(record.passwordHash)] += 1;
  process.stdout.write(`${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(" ")}\n`);
} finally {
  await prisma.$disconnect();
}
