export const LIVE_PILOT_CAPABILITIES = [
  "LIVE_KMS",
  "LIVE_EMAIL_SANDBOX",
  "LIVE_WEBHOOK_REGISTRATION",
  "LIVE_PLATFORM_TRACKING_SYNC",
  "LIVE_COURIER_RATES",
  "LIVE_AWB_LABEL",
  "LIVE_WORKER_RUN_ONCE",
  "LIVE_SCHEDULED_POLLING",
  "PRODUCTION_DEPLOY"
] as const;

export const LIVE_PILOT_STATUSES = [
  "DISABLED",
  "PENDING_APPROVAL",
  "APPROVED",
  "ENABLED",
  "REVOKED",
  "BLOCKED"
] as const;

export type LivePilotCapability = typeof LIVE_PILOT_CAPABILITIES[number];
export type LivePilotStatus = typeof LIVE_PILOT_STATUSES[number];

export type LivePilotMerchantSummary = {
  merchant_id: string;
  status: LivePilotStatus;
  notes?: string | null;
  enabled_at?: Date | string | null;
  disabled_at?: Date | string | null;
  created_at?: Date | string | null;
  updated_at?: Date | string | null;
};

export type LivePilotCapabilitySummary = {
  capability: LivePilotCapability;
  status: LivePilotStatus;
  approval_id?: string | null;
  notes?: string | null;
  enabled_at?: Date | string | null;
  disabled_at?: Date | string | null;
  created_at?: Date | string | null;
  updated_at?: Date | string | null;
};

export type LivePilotReadinessSnapshot = {
  merchantId: string;
  allowlisted: boolean;
  merchantStatus: LivePilotStatus;
  enabledCapabilities: LivePilotCapability[];
  approvedCapabilities: LivePilotCapability[];
  pendingCapabilities: LivePilotCapability[];
  disabledCapabilities: LivePilotCapability[];
  rollbackReady: boolean;
  blockers: string[];
};
