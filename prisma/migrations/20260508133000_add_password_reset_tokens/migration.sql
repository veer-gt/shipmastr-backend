CREATE TYPE "PasswordResetPurpose" AS ENUM ('INVITE', 'RESET');

CREATE TABLE "PasswordResetToken" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "purpose" "PasswordResetPurpose" NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");
CREATE INDEX "PasswordResetToken_purpose_idx" ON "PasswordResetToken"("purpose");
CREATE INDEX "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken"("expiresAt");
CREATE INDEX "PasswordResetToken_usedAt_idx" ON "PasswordResetToken"("usedAt");

ALTER TABLE "PasswordResetToken"
  ADD CONSTRAINT "PasswordResetToken_userId_fkey"
  FOREIGN KEY ("userId")
  REFERENCES "User"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;
