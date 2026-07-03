CREATE TABLE "courier_audit_leads" (
  "id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "brand" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "whatsapp" TEXT NOT NULL,
  "monthly_shipments" INTEGER NOT NULL,
  "current_aggregator" TEXT,
  "estimated_leak" DOUBLE PRECISION,
  "bump_rate" DOUBLE PRECISION,
  "average_overcharge" DOUBLE PRECISION,
  "utm_source" TEXT,
  "utm_medium" TEXT,
  "utm_campaign" TEXT,
  "utm_term" TEXT,
  "utm_content" TEXT,
  "landing_path" TEXT,
  "referrer" TEXT,
  "status" TEXT NOT NULL DEFAULT 'new',
  "source" TEXT NOT NULL DEFAULT 'courier-audit',
  "n8n_notified_at" TIMESTAMP(3),
  "n8n_notification_status" TEXT,
  "notes" TEXT,

  CONSTRAINT "courier_audit_leads_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "courier_audit_leads_email_idx" ON "courier_audit_leads"("email");
CREATE INDEX "courier_audit_leads_whatsapp_idx" ON "courier_audit_leads"("whatsapp");
CREATE INDEX "courier_audit_leads_status_idx" ON "courier_audit_leads"("status");
CREATE INDEX "courier_audit_leads_created_at_idx" ON "courier_audit_leads"("created_at");
