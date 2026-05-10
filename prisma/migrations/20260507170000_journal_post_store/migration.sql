-- Store generated Shipmastr Journal posts in Postgres so daily autopublish is durable on Cloud Run.
CREATE TYPE "JournalPostStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'HELD', 'SENT');

CREATE TABLE "JournalPost" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "seoTitle" TEXT NOT NULL,
  "metaDescription" TEXT NOT NULL,
  "excerpt" TEXT NOT NULL,
  "bodyHtml" TEXT NOT NULL,
  "bodyText" TEXT NOT NULL,
  "sourceNotes" JSONB NOT NULL,
  "homepageTeaser" TEXT NOT NULL,
  "emailSubject" TEXT NOT NULL,
  "emailPreview" TEXT NOT NULL,
  "emailHtml" TEXT NOT NULL,
  "emailText" TEXT NOT NULL,
  "status" "JournalPostStatus" NOT NULL DEFAULT 'DRAFT',
  "guardrailStatus" TEXT NOT NULL,
  "guardrailFailures" JSONB NOT NULL,
  "metadata" JSONB,
  "publishedAt" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "JournalPost_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "JournalPost_slug_key" ON "JournalPost"("slug");
CREATE INDEX "JournalPost_status_idx" ON "JournalPost"("status");
CREATE INDEX "JournalPost_publishedAt_idx" ON "JournalPost"("publishedAt");
CREATE INDEX "JournalPost_createdAt_idx" ON "JournalPost"("createdAt");
CREATE INDEX "JournalPost_category_idx" ON "JournalPost"("category");
