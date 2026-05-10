ALTER TABLE "public"."User" ADD COLUMN IF NOT EXISTS "firebaseUid" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "User_firebaseUid_key" ON "public"."User"("firebaseUid");
CREATE INDEX IF NOT EXISTS "User_firebaseUid_idx" ON "public"."User"("firebaseUid");
