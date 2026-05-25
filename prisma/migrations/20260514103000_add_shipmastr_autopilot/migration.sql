CREATE TYPE "public"."AutomationEventStatus" AS ENUM ('QUEUED', 'PROCESSING', 'DISPATCHED', 'PROCESSED', 'FAILED', 'CANCELLED');
CREATE TYPE "public"."AutomationWorkflowStatus" AS ENUM ('ACTIVE', 'PAUSED');
CREATE TYPE "public"."AutomationCampaignStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED');
CREATE TYPE "public"."AutomationAlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');
CREATE TYPE "public"."AutomationUsageType" AS ENUM ('N8N_EXECUTION', 'MESSAGE_ATTEMPT', 'MESSAGE_SENT', 'MESSAGE_FAILED');

CREATE TABLE "public"."AutomationEvent" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "status" "public"."AutomationEventStatus" NOT NULL DEFAULT 'QUEUED',
  "source" TEXT NOT NULL DEFAULT 'shipmastr',
  "sourceId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "contextSnapshot" JSONB,
  "dispatchResult" JSONB,
  "error" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3),
  "processedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AutomationEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."AutomationPreference" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "autopilotEnabled" BOOLEAN NOT NULL DEFAULT true,
  "notificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
  "codShieldEnabled" BOOLEAN NOT NULL DEFAULT true,
  "ndrRescueEnabled" BOOLEAN NOT NULL DEFAULT true,
  "marketingEnabled" BOOLEAN NOT NULL DEFAULT false,
  "courierControlEnabled" BOOLEAN NOT NULL DEFAULT true,
  "financeControlEnabled" BOOLEAN NOT NULL DEFAULT true,
  "buyerIntelligenceEnabled" BOOLEAN NOT NULL DEFAULT true,
  "whatsappEnabled" BOOLEAN NOT NULL DEFAULT true,
  "smsEnabled" BOOLEAN NOT NULL DEFAULT true,
  "emailEnabled" BOOLEAN NOT NULL DEFAULT true,
  "quietHoursStart" TEXT NOT NULL DEFAULT '21:00',
  "quietHoursEnd" TEXT NOT NULL DEFAULT '09:00',
  "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  "dailyBuyerMessageCap" INTEGER NOT NULL DEFAULT 3,
  "weeklyBuyerMessageCap" INTEGER NOT NULL DEFAULT 8,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AutomationPreference_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."AutomationWorkflowSetting" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "status" "public"."AutomationWorkflowStatus" NOT NULL DEFAULT 'ACTIVE',
  "channelOrder" TEXT[] NOT NULL DEFAULT ARRAY['WHATSAPP', 'SMS', 'EMAIL']::TEXT[],
  "frequencyCap" INTEGER,
  "retryLimit" INTEGER NOT NULL DEFAULT 3,
  "quietHoursMode" TEXT NOT NULL DEFAULT 'respect',
  "settings" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AutomationWorkflowSetting_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."AutomationTemplate" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT,
  "key" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "subject" TEXT,
  "body" TEXT NOT NULL,
  "variables" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "locale" TEXT NOT NULL DEFAULT 'en-IN',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "systemTemplate" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AutomationTemplate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."AutomationOptOut" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "reason" TEXT,
  "optedOutAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3),
  "metadata" JSONB NOT NULL DEFAULT '{}',

  CONSTRAINT "AutomationOptOut_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."AutomationFrequencyLedger" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "windowKey" TEXT NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "resetAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AutomationFrequencyLedger_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."CommunicationLog" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "eventId" TEXT,
  "campaignId" TEXT,
  "channel" TEXT NOT NULL,
  "recipient" TEXT NOT NULL,
  "templateKey" TEXT,
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "provider" TEXT,
  "providerMessageId" TEXT,
  "renderedMessage" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "sentAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "readAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CommunicationLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."MarketingCampaign" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "campaignType" TEXT NOT NULL,
  "status" "public"."AutomationCampaignStatus" NOT NULL DEFAULT 'DRAFT',
  "audienceId" TEXT,
  "channelOrder" TEXT[] NOT NULL DEFAULT ARRAY['WHATSAPP', 'SMS', 'EMAIL']::TEXT[],
  "templateKey" TEXT,
  "scheduleAt" TIMESTAMP(3),
  "budgetLimitPaise" INTEGER,
  "sentCount" INTEGER NOT NULL DEFAULT 0,
  "clickedCount" INTEGER NOT NULL DEFAULT 0,
  "convertedCount" INTEGER NOT NULL DEFAULT 0,
  "recoveredRevenuePaise" INTEGER NOT NULL DEFAULT 0,
  "settings" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MarketingCampaign_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."MarketingAudienceSegment" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "rules" JSONB NOT NULL DEFAULT '{}',
  "buyerCount" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MarketingAudienceSegment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."MerchantChannelCredential" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "credentialRef" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "lastVerifiedAt" TIMESTAMP(3),
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MerchantChannelCredential_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."BuyerIntelligenceEvent" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "buyerKey" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "orderId" TEXT,
  "riskTier" TEXT,
  "score" INTEGER,
  "reasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BuyerIntelligenceEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."CourierOpsAlert" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "alertKey" TEXT NOT NULL,
  "courierId" TEXT,
  "awb" TEXT,
  "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
  "status" "public"."AutomationAlertStatus" NOT NULL DEFAULT 'OPEN',
  "summary" TEXT NOT NULL,
  "actionHint" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CourierOpsAlert_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."FinanceAutomationAlert" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "alertKey" TEXT NOT NULL,
  "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
  "status" "public"."AutomationAlertStatus" NOT NULL DEFAULT 'OPEN',
  "amountPaise" INTEGER,
  "dueAt" TIMESTAMP(3),
  "summary" TEXT NOT NULL,
  "actionHint" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "FinanceAutomationAlert_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."AutomationUsageMeter" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "monthKey" TEXT NOT NULL,
  "usageType" "public"."AutomationUsageType" NOT NULL,
  "eventKey" TEXT NOT NULL DEFAULT 'ALL',
  "workflowKey" TEXT NOT NULL DEFAULT 'ALL',
  "channel" TEXT NOT NULL DEFAULT 'ALL',
  "count" INTEGER NOT NULL DEFAULT 0,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AutomationUsageMeter_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AutomationEvent_merchantId_idempotencyKey_key" ON "public"."AutomationEvent"("merchantId", "idempotencyKey");
CREATE INDEX "AutomationEvent_merchantId_idx" ON "public"."AutomationEvent"("merchantId");
CREATE INDEX "AutomationEvent_eventKey_idx" ON "public"."AutomationEvent"("eventKey");
CREATE INDEX "AutomationEvent_status_idx" ON "public"."AutomationEvent"("status");
CREATE INDEX "AutomationEvent_idempotencyKey_idx" ON "public"."AutomationEvent"("idempotencyKey");
CREATE INDEX "AutomationEvent_merchantId_eventKey_createdAt_idx" ON "public"."AutomationEvent"("merchantId", "eventKey", "createdAt");
CREATE INDEX "AutomationEvent_merchantId_status_createdAt_idx" ON "public"."AutomationEvent"("merchantId", "status", "createdAt");
CREATE INDEX "AutomationEvent_nextAttemptAt_idx" ON "public"."AutomationEvent"("nextAttemptAt");
CREATE INDEX "AutomationEvent_createdAt_idx" ON "public"."AutomationEvent"("createdAt");

CREATE UNIQUE INDEX "AutomationPreference_merchantId_key" ON "public"."AutomationPreference"("merchantId");
CREATE INDEX "AutomationPreference_merchantId_idx" ON "public"."AutomationPreference"("merchantId");
CREATE INDEX "AutomationPreference_createdAt_idx" ON "public"."AutomationPreference"("createdAt");

CREATE UNIQUE INDEX "AutomationWorkflowSetting_merchantId_key_key" ON "public"."AutomationWorkflowSetting"("merchantId", "key");
CREATE INDEX "AutomationWorkflowSetting_merchantId_idx" ON "public"."AutomationWorkflowSetting"("merchantId");
CREATE INDEX "AutomationWorkflowSetting_key_idx" ON "public"."AutomationWorkflowSetting"("key");
CREATE INDEX "AutomationWorkflowSetting_status_idx" ON "public"."AutomationWorkflowSetting"("status");
CREATE INDEX "AutomationWorkflowSetting_createdAt_idx" ON "public"."AutomationWorkflowSetting"("createdAt");

CREATE UNIQUE INDEX "AutomationTemplate_merchantId_key_channel_key" ON "public"."AutomationTemplate"("merchantId", "key", "channel");
CREATE INDEX "AutomationTemplate_merchantId_idx" ON "public"."AutomationTemplate"("merchantId");
CREATE INDEX "AutomationTemplate_key_idx" ON "public"."AutomationTemplate"("key");
CREATE INDEX "AutomationTemplate_channel_idx" ON "public"."AutomationTemplate"("channel");
CREATE INDEX "AutomationTemplate_active_idx" ON "public"."AutomationTemplate"("active");
CREATE INDEX "AutomationTemplate_createdAt_idx" ON "public"."AutomationTemplate"("createdAt");

CREATE UNIQUE INDEX "AutomationOptOut_merchantId_channel_subject_key" ON "public"."AutomationOptOut"("merchantId", "channel", "subject");
CREATE INDEX "AutomationOptOut_merchantId_idx" ON "public"."AutomationOptOut"("merchantId");
CREATE INDEX "AutomationOptOut_channel_idx" ON "public"."AutomationOptOut"("channel");
CREATE INDEX "AutomationOptOut_subject_idx" ON "public"."AutomationOptOut"("subject");
CREATE INDEX "AutomationOptOut_optedOutAt_idx" ON "public"."AutomationOptOut"("optedOutAt");

CREATE UNIQUE INDEX "AutomationFrequencyLedger_merchantId_subject_channel_windowKey_key" ON "public"."AutomationFrequencyLedger"("merchantId", "subject", "channel", "windowKey");
CREATE INDEX "AutomationFrequencyLedger_merchantId_idx" ON "public"."AutomationFrequencyLedger"("merchantId");
CREATE INDEX "AutomationFrequencyLedger_subject_idx" ON "public"."AutomationFrequencyLedger"("subject");
CREATE INDEX "AutomationFrequencyLedger_channel_idx" ON "public"."AutomationFrequencyLedger"("channel");
CREATE INDEX "AutomationFrequencyLedger_resetAt_idx" ON "public"."AutomationFrequencyLedger"("resetAt");
CREATE INDEX "AutomationFrequencyLedger_createdAt_idx" ON "public"."AutomationFrequencyLedger"("createdAt");

CREATE INDEX "CommunicationLog_merchantId_idx" ON "public"."CommunicationLog"("merchantId");
CREATE INDEX "CommunicationLog_eventId_idx" ON "public"."CommunicationLog"("eventId");
CREATE INDEX "CommunicationLog_campaignId_idx" ON "public"."CommunicationLog"("campaignId");
CREATE INDEX "CommunicationLog_channel_idx" ON "public"."CommunicationLog"("channel");
CREATE INDEX "CommunicationLog_status_idx" ON "public"."CommunicationLog"("status");
CREATE INDEX "CommunicationLog_providerMessageId_idx" ON "public"."CommunicationLog"("providerMessageId");
CREATE INDEX "CommunicationLog_createdAt_idx" ON "public"."CommunicationLog"("createdAt");

CREATE UNIQUE INDEX "MarketingCampaign_merchantId_key_key" ON "public"."MarketingCampaign"("merchantId", "key");
CREATE INDEX "MarketingCampaign_merchantId_idx" ON "public"."MarketingCampaign"("merchantId");
CREATE INDEX "MarketingCampaign_campaignType_idx" ON "public"."MarketingCampaign"("campaignType");
CREATE INDEX "MarketingCampaign_status_idx" ON "public"."MarketingCampaign"("status");
CREATE INDEX "MarketingCampaign_scheduleAt_idx" ON "public"."MarketingCampaign"("scheduleAt");
CREATE INDEX "MarketingCampaign_createdAt_idx" ON "public"."MarketingCampaign"("createdAt");

CREATE UNIQUE INDEX "MarketingAudienceSegment_merchantId_key_key" ON "public"."MarketingAudienceSegment"("merchantId", "key");
CREATE INDEX "MarketingAudienceSegment_merchantId_idx" ON "public"."MarketingAudienceSegment"("merchantId");
CREATE INDEX "MarketingAudienceSegment_active_idx" ON "public"."MarketingAudienceSegment"("active");
CREATE INDEX "MarketingAudienceSegment_createdAt_idx" ON "public"."MarketingAudienceSegment"("createdAt");

CREATE UNIQUE INDEX "MerchantChannelCredential_merchantId_channel_provider_label_key" ON "public"."MerchantChannelCredential"("merchantId", "channel", "provider", "label");
CREATE INDEX "MerchantChannelCredential_merchantId_idx" ON "public"."MerchantChannelCredential"("merchantId");
CREATE INDEX "MerchantChannelCredential_channel_idx" ON "public"."MerchantChannelCredential"("channel");
CREATE INDEX "MerchantChannelCredential_status_idx" ON "public"."MerchantChannelCredential"("status");
CREATE INDEX "MerchantChannelCredential_createdAt_idx" ON "public"."MerchantChannelCredential"("createdAt");

CREATE INDEX "BuyerIntelligenceEvent_merchantId_idx" ON "public"."BuyerIntelligenceEvent"("merchantId");
CREATE INDEX "BuyerIntelligenceEvent_buyerKey_idx" ON "public"."BuyerIntelligenceEvent"("buyerKey");
CREATE INDEX "BuyerIntelligenceEvent_eventKey_idx" ON "public"."BuyerIntelligenceEvent"("eventKey");
CREATE INDEX "BuyerIntelligenceEvent_riskTier_idx" ON "public"."BuyerIntelligenceEvent"("riskTier");
CREATE INDEX "BuyerIntelligenceEvent_createdAt_idx" ON "public"."BuyerIntelligenceEvent"("createdAt");

CREATE INDEX "CourierOpsAlert_merchantId_idx" ON "public"."CourierOpsAlert"("merchantId");
CREATE INDEX "CourierOpsAlert_alertKey_idx" ON "public"."CourierOpsAlert"("alertKey");
CREATE INDEX "CourierOpsAlert_courierId_idx" ON "public"."CourierOpsAlert"("courierId");
CREATE INDEX "CourierOpsAlert_awb_idx" ON "public"."CourierOpsAlert"("awb");
CREATE INDEX "CourierOpsAlert_status_idx" ON "public"."CourierOpsAlert"("status");
CREATE INDEX "CourierOpsAlert_createdAt_idx" ON "public"."CourierOpsAlert"("createdAt");

CREATE INDEX "FinanceAutomationAlert_merchantId_idx" ON "public"."FinanceAutomationAlert"("merchantId");
CREATE INDEX "FinanceAutomationAlert_alertKey_idx" ON "public"."FinanceAutomationAlert"("alertKey");
CREATE INDEX "FinanceAutomationAlert_status_idx" ON "public"."FinanceAutomationAlert"("status");
CREATE INDEX "FinanceAutomationAlert_dueAt_idx" ON "public"."FinanceAutomationAlert"("dueAt");
CREATE INDEX "FinanceAutomationAlert_createdAt_idx" ON "public"."FinanceAutomationAlert"("createdAt");

CREATE UNIQUE INDEX "AutomationUsageMeter_merchantId_monthKey_usageType_eventKey_workflowKey_channel_key" ON "public"."AutomationUsageMeter"("merchantId", "monthKey", "usageType", "eventKey", "workflowKey", "channel");
CREATE INDEX "AutomationUsageMeter_merchantId_idx" ON "public"."AutomationUsageMeter"("merchantId");
CREATE INDEX "AutomationUsageMeter_monthKey_idx" ON "public"."AutomationUsageMeter"("monthKey");
CREATE INDEX "AutomationUsageMeter_usageType_idx" ON "public"."AutomationUsageMeter"("usageType");
CREATE INDEX "AutomationUsageMeter_eventKey_idx" ON "public"."AutomationUsageMeter"("eventKey");
CREATE INDEX "AutomationUsageMeter_workflowKey_idx" ON "public"."AutomationUsageMeter"("workflowKey");
CREATE INDEX "AutomationUsageMeter_channel_idx" ON "public"."AutomationUsageMeter"("channel");
CREATE INDEX "AutomationUsageMeter_createdAt_idx" ON "public"."AutomationUsageMeter"("createdAt");
