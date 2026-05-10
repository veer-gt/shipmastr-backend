-- Cloud Run becomes the source of truth for Shipmastr Journal newsletter subscribers.
CREATE TYPE "NewsletterSubscriberStatus" AS ENUM ('SUBSCRIBED', 'UNSUBSCRIBED');

CREATE TABLE "NewsletterSubscriber" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "status" "NewsletterSubscriberStatus" NOT NULL DEFAULT 'SUBSCRIBED',
  "source" TEXT,
  "subscribedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "unsubscribedAt" TIMESTAMP(3),
  "unsubscribeToken" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "NewsletterSubscriber_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NewsletterSubscriber_email_key" ON "NewsletterSubscriber"("email");
CREATE UNIQUE INDEX "NewsletterSubscriber_unsubscribeToken_key" ON "NewsletterSubscriber"("unsubscribeToken");
CREATE INDEX "NewsletterSubscriber_email_idx" ON "NewsletterSubscriber"("email");
CREATE INDEX "NewsletterSubscriber_status_idx" ON "NewsletterSubscriber"("status");
CREATE INDEX "NewsletterSubscriber_source_idx" ON "NewsletterSubscriber"("source");
CREATE INDEX "NewsletterSubscriber_subscribedAt_idx" ON "NewsletterSubscriber"("subscribedAt");
CREATE INDEX "NewsletterSubscriber_unsubscribeToken_idx" ON "NewsletterSubscriber"("unsubscribeToken");
