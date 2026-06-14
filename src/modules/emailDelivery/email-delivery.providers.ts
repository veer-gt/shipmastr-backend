import { env } from "../../config/env.js";
import type { EmailDeliveryMode, EmailDeliveryProvider, EmailDeliveryRuntime } from "./email-delivery.types.js";

type EmailDeliverySource = Record<string, string | boolean | number | undefined | null>;

function boolValue(source: EmailDeliverySource, key: string, fallback = false) {
  const value = source[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on", "enabled"].includes(normalized)) return true;
    if (["false", "0", "no", "off", "disabled", ""].includes(normalized)) return false;
  }
  return fallback;
}

function stringValue(source: EmailDeliverySource, key: string, fallback = "") {
  const value = source[key];
  if (value === undefined || value === null) return fallback;
  return String(value).trim() || fallback;
}

function providerConfigured(source: EmailDeliverySource, provider: EmailDeliveryProvider) {
  if (provider === "LOCAL_LOG" || provider === "MOCK") return true;
  return Boolean(stringValue(source, "SMTP_HOST"))
    && Boolean(stringValue(source, "SMTP_FROM") || stringValue(source, "EMAIL_FROM"));
}

export function getEmailDeliveryRuntime(source: EmailDeliverySource = env): EmailDeliveryRuntime {
  const provider = stringValue(source, "SHIPMASTR_EMAIL_PROVIDER", "LOCAL_LOG").toUpperCase() as EmailDeliveryProvider;
  const mode = stringValue(source, "SHIPMASTR_EMAIL_MODE", "SANDBOX").toUpperCase() as EmailDeliveryMode;
  const normalizedProvider = ["LOCAL_LOG", "SMTP_SANDBOX", "MOCK"].includes(provider) ? provider : "LOCAL_LOG";
  const normalizedMode = mode === "LIVE" ? "LIVE" : "SANDBOX";
  return {
    enabled: boolValue(source, "SHIPMASTR_EMAIL_ENABLED", false),
    mode: normalizedMode,
    provider: normalizedProvider,
    pilotOnly: boolValue(source, "SHIPMASTR_EMAIL_PILOT_ONLY", true),
    providerConfigured: providerConfigured(source, normalizedProvider),
    liveDeliveryEnabled: boolValue(source, "SHIPMASTR_EMAIL_LIVE_SEND", false)
      || boolValue(source, "MERCHANT_EMAIL_LIVE_SEND", false)
  };
}
