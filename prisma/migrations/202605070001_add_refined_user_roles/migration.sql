-- Add refined Shipmastr internal + merchant roles.
-- Safe only if current User.role is stored as TEXT or enum-compatible.
-- If your DB already has a UserRole enum, Prisma migrate may need enum ALTER instead.

DO $$ BEGIN
  CREATE TYPE "UserRoleNew" AS ENUM (
    'MASTER_ADMIN',
    'ADMIN',
    'OPS_MANAGER',
    'FINANCE_MANAGER',
    'RISK_MANAGER',
    'COURIER_MANAGER',
    'SUPPORT_AGENT',
    'MERCHANT_OWNER',
    'MERCHANT_STAFF'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "role_new" "UserRoleNew" NOT NULL DEFAULT 'MERCHANT_OWNER';

UPDATE "User"
SET "role_new" =
  CASE
    WHEN "role"::text IN ('MASTER_ADMIN') THEN 'MASTER_ADMIN'::"UserRoleNew"
    WHEN "role"::text IN ('ADMIN') THEN 'ADMIN'::"UserRoleNew"
    WHEN "role"::text IN ('OPS', 'OPS_MANAGER') THEN 'OPS_MANAGER'::"UserRoleNew"
    WHEN "role"::text IN ('FINANCE', 'FINANCE_MANAGER') THEN 'FINANCE_MANAGER'::"UserRoleNew"
    WHEN "role"::text IN ('RISK', 'RISK_MANAGER') THEN 'RISK_MANAGER'::"UserRoleNew"
    WHEN "role"::text IN ('COURIER', 'COURIER_MANAGER') THEN 'COURIER_MANAGER'::"UserRoleNew"
    WHEN "role"::text IN ('SUPPORT', 'SUPPORT_AGENT') THEN 'SUPPORT_AGENT'::"UserRoleNew"
    WHEN "role"::text IN ('MERCHANT_STAFF') THEN 'MERCHANT_STAFF'::"UserRoleNew"
    ELSE 'MERCHANT_OWNER'::"UserRoleNew"
  END;

ALTER TABLE "User" DROP COLUMN IF EXISTS "role";
ALTER TABLE "User" RENAME COLUMN "role_new" TO "role";

ALTER TYPE "UserRoleNew" RENAME TO "UserRole";
