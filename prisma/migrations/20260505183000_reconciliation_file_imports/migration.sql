-- CreateEnum
CREATE TYPE "public"."CourierImportStatus" AS ENUM ('UPLOADED', 'PREVIEWED', 'IMPORTED', 'FAILED', 'DUPLICATE');

-- CreateTable
CREATE TABLE "public"."CourierImportFile" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "courierId" TEXT,
  "fileName" TEXT NOT NULL,
  "mimeType" TEXT,
  "fileHash" TEXT NOT NULL,
  "status" "public"."CourierImportStatus" NOT NULL DEFAULT 'UPLOADED',
  "totalRows" INTEGER NOT NULL DEFAULT 0,
  "validRows" INTEGER NOT NULL DEFAULT 0,
  "invalidRows" INTEGER NOT NULL DEFAULT 0,
  "duplicateAwbRows" INTEGER NOT NULL DEFAULT 0,
  "metadata" JSONB,
  "importedInvoiceId" TEXT,
  "importedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CourierImportFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CourierImportRow" (
  "id" TEXT NOT NULL,
  "importFileId" TEXT NOT NULL,
  "rowNumber" INTEGER NOT NULL,
  "awb" TEXT,
  "orderId" TEXT,
  "externalOrderId" TEXT,
  "valid" BOOLEAN NOT NULL DEFAULT false,
  "duplicateAwb" BOOLEAN NOT NULL DEFAULT false,
  "errors" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "rawData" JSONB NOT NULL,
  "normalizedData" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CourierImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CodRemittanceImportFile" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "mimeType" TEXT,
  "fileHash" TEXT NOT NULL,
  "status" "public"."CourierImportStatus" NOT NULL DEFAULT 'UPLOADED',
  "totalRows" INTEGER NOT NULL DEFAULT 0,
  "validRows" INTEGER NOT NULL DEFAULT 0,
  "invalidRows" INTEGER NOT NULL DEFAULT 0,
  "duplicateAwbRows" INTEGER NOT NULL DEFAULT 0,
  "metadata" JSONB,
  "importedRowCount" INTEGER,
  "importedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CodRemittanceImportFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CodRemittanceImportRow" (
  "id" TEXT NOT NULL,
  "importFileId" TEXT NOT NULL,
  "rowNumber" INTEGER NOT NULL,
  "awb" TEXT,
  "orderId" TEXT,
  "externalOrderId" TEXT,
  "valid" BOOLEAN NOT NULL DEFAULT false,
  "duplicateAwb" BOOLEAN NOT NULL DEFAULT false,
  "errors" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "rawData" JSONB NOT NULL,
  "normalizedData" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CodRemittanceImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CourierImportFile_merchantId_fileHash_key" ON "public"."CourierImportFile"("merchantId", "fileHash");
CREATE INDEX "CourierImportFile_merchantId_idx" ON "public"."CourierImportFile"("merchantId");
CREATE INDEX "CourierImportFile_courierId_idx" ON "public"."CourierImportFile"("courierId");
CREATE INDEX "CourierImportFile_status_idx" ON "public"."CourierImportFile"("status");
CREATE INDEX "CourierImportFile_createdAt_idx" ON "public"."CourierImportFile"("createdAt");
CREATE INDEX "CourierImportRow_importFileId_idx" ON "public"."CourierImportRow"("importFileId");
CREATE INDEX "CourierImportRow_rowNumber_idx" ON "public"."CourierImportRow"("rowNumber");
CREATE INDEX "CourierImportRow_awb_idx" ON "public"."CourierImportRow"("awb");
CREATE INDEX "CourierImportRow_orderId_idx" ON "public"."CourierImportRow"("orderId");
CREATE INDEX "CourierImportRow_externalOrderId_idx" ON "public"."CourierImportRow"("externalOrderId");
CREATE INDEX "CourierImportRow_valid_idx" ON "public"."CourierImportRow"("valid");

CREATE UNIQUE INDEX "CodRemittanceImportFile_merchantId_fileHash_key" ON "public"."CodRemittanceImportFile"("merchantId", "fileHash");
CREATE INDEX "CodRemittanceImportFile_merchantId_idx" ON "public"."CodRemittanceImportFile"("merchantId");
CREATE INDEX "CodRemittanceImportFile_status_idx" ON "public"."CodRemittanceImportFile"("status");
CREATE INDEX "CodRemittanceImportFile_createdAt_idx" ON "public"."CodRemittanceImportFile"("createdAt");
CREATE INDEX "CodRemittanceImportRow_importFileId_idx" ON "public"."CodRemittanceImportRow"("importFileId");
CREATE INDEX "CodRemittanceImportRow_rowNumber_idx" ON "public"."CodRemittanceImportRow"("rowNumber");
CREATE INDEX "CodRemittanceImportRow_awb_idx" ON "public"."CodRemittanceImportRow"("awb");
CREATE INDEX "CodRemittanceImportRow_orderId_idx" ON "public"."CodRemittanceImportRow"("orderId");
CREATE INDEX "CodRemittanceImportRow_externalOrderId_idx" ON "public"."CodRemittanceImportRow"("externalOrderId");
CREATE INDEX "CodRemittanceImportRow_valid_idx" ON "public"."CodRemittanceImportRow"("valid");

-- AddForeignKey
ALTER TABLE "public"."CourierImportRow"
  ADD CONSTRAINT "CourierImportRow_importFileId_fkey"
  FOREIGN KEY ("importFileId") REFERENCES "public"."CourierImportFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."CodRemittanceImportRow"
  ADD CONSTRAINT "CodRemittanceImportRow_importFileId_fkey"
  FOREIGN KEY ("importFileId") REFERENCES "public"."CodRemittanceImportFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
