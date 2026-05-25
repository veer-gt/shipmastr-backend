-- Apply after UserRole enum widening so Postgres can safely use SELLER_OWNER
-- as the default in a later transaction.

ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'SELLER_OWNER';
