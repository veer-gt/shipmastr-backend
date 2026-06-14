export const EMAIL_DELIVERY_PROVIDERS = ["LOCAL_LOG", "SMTP_SANDBOX", "MOCK"] as const;
export const EMAIL_DELIVERY_MODES = ["SANDBOX", "LIVE"] as const;
export const EMAIL_DELIVERY_STATUSES = ["BLOCKED", "SANDBOX_RECORDED", "FAILED", "SKIPPED"] as const;

export type EmailDeliveryProvider = typeof EMAIL_DELIVERY_PROVIDERS[number];
export type EmailDeliveryMode = typeof EMAIL_DELIVERY_MODES[number];
export type EmailDeliveryStatus = typeof EMAIL_DELIVERY_STATUSES[number];

export type EmailDeliveryRuntime = {
  enabled: boolean;
  mode: EmailDeliveryMode;
  provider: EmailDeliveryProvider;
  pilotOnly: boolean;
  providerConfigured: boolean;
  liveDeliveryEnabled: boolean;
};

export type EmailDeliveryReadiness = {
  status: "READY" | "DISABLED" | "BLOCKED";
  ready: boolean;
  message: string;
  runtime: EmailDeliveryRuntime;
  preferenceEmailEnabled: boolean;
  pilot: {
    allowlisted: boolean;
    capabilityEnabled: boolean;
  };
  blockers: string[];
  warnings: string[];
};

export type EmailDeliveryAttemptSummary = {
  attempt_id: string;
  merchant_id?: string | null;
  notification_id?: string | null;
  recipient_safe?: string | null;
  provider: EmailDeliveryProvider | string;
  mode: EmailDeliveryMode | string;
  status: EmailDeliveryStatus | string;
  subject?: string | null;
  safe_meta?: unknown;
  sent_at?: Date | string | null;
  created_at?: Date | string | null;
  updated_at?: Date | string | null;
};
