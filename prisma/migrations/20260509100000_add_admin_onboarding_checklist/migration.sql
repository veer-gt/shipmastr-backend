CREATE TYPE "AdminOnboardingChecklistItemStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'DONE', 'BLOCKED');

CREATE TABLE "AdminOnboardingChecklist" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AdminOnboardingChecklist_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdminOnboardingChecklistItem" (
  "id" TEXT NOT NULL,
  "checklistId" TEXT NOT NULL,
  "itemKey" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "prompt" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "status" "AdminOnboardingChecklistItemStatus" NOT NULL DEFAULT 'PENDING',
  "owner" TEXT,
  "notes" TEXT,
  "dueDate" TIMESTAMP(3),
  "blockerReason" TEXT,
  "completedAt" TIMESTAMP(3),
  "updatedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AdminOnboardingChecklistItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdminOnboardingChecklistAudit" (
  "id" TEXT NOT NULL,
  "checklistId" TEXT NOT NULL,
  "itemId" TEXT,
  "itemKey" TEXT,
  "actorId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "oldValues" JSONB,
  "newValues" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AdminOnboardingChecklistAudit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdminOnboardingChecklist_key_key" ON "AdminOnboardingChecklist"("key");
CREATE INDEX "AdminOnboardingChecklist_key_idx" ON "AdminOnboardingChecklist"("key");
CREATE INDEX "AdminOnboardingChecklist_createdAt_idx" ON "AdminOnboardingChecklist"("createdAt");

CREATE UNIQUE INDEX "AdminOnboardingChecklistItem_checklistId_itemKey_key" ON "AdminOnboardingChecklistItem"("checklistId", "itemKey");
CREATE INDEX "AdminOnboardingChecklistItem_checklistId_idx" ON "AdminOnboardingChecklistItem"("checklistId");
CREATE INDEX "AdminOnboardingChecklistItem_itemKey_idx" ON "AdminOnboardingChecklistItem"("itemKey");
CREATE INDEX "AdminOnboardingChecklistItem_status_idx" ON "AdminOnboardingChecklistItem"("status");
CREATE INDEX "AdminOnboardingChecklistItem_updatedBy_idx" ON "AdminOnboardingChecklistItem"("updatedBy");
CREATE INDEX "AdminOnboardingChecklistItem_dueDate_idx" ON "AdminOnboardingChecklistItem"("dueDate");
CREATE INDEX "AdminOnboardingChecklistItem_updatedAt_idx" ON "AdminOnboardingChecklistItem"("updatedAt");

CREATE INDEX "AdminOnboardingChecklistAudit_checklistId_idx" ON "AdminOnboardingChecklistAudit"("checklistId");
CREATE INDEX "AdminOnboardingChecklistAudit_itemId_idx" ON "AdminOnboardingChecklistAudit"("itemId");
CREATE INDEX "AdminOnboardingChecklistAudit_itemKey_idx" ON "AdminOnboardingChecklistAudit"("itemKey");
CREATE INDEX "AdminOnboardingChecklistAudit_actorId_idx" ON "AdminOnboardingChecklistAudit"("actorId");
CREATE INDEX "AdminOnboardingChecklistAudit_action_idx" ON "AdminOnboardingChecklistAudit"("action");
CREATE INDEX "AdminOnboardingChecklistAudit_createdAt_idx" ON "AdminOnboardingChecklistAudit"("createdAt");

ALTER TABLE "AdminOnboardingChecklistItem"
  ADD CONSTRAINT "AdminOnboardingChecklistItem_checklistId_fkey"
  FOREIGN KEY ("checklistId")
  REFERENCES "AdminOnboardingChecklist"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "AdminOnboardingChecklistAudit"
  ADD CONSTRAINT "AdminOnboardingChecklistAudit_checklistId_fkey"
  FOREIGN KEY ("checklistId")
  REFERENCES "AdminOnboardingChecklist"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "AdminOnboardingChecklistAudit"
  ADD CONSTRAINT "AdminOnboardingChecklistAudit_itemId_fkey"
  FOREIGN KEY ("itemId")
  REFERENCES "AdminOnboardingChecklistItem"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
