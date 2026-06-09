import { HttpError } from "../../lib/httpError.js";
import { LIVE_PILOT_CAPABILITIES, type LivePilotCapability } from "./live-pilot.types.js";

export function assertLivePilotCapability(value: string | null | undefined): LivePilotCapability {
  const normalized = String(value || "").trim().toUpperCase();
  if (!LIVE_PILOT_CAPABILITIES.includes(normalized as LivePilotCapability)) {
    throw new HttpError(400, "LIVE_PILOT_CAPABILITY_UNSUPPORTED");
  }
  return normalized as LivePilotCapability;
}

export function assertPilotMerchantCanEnableCapability(input: {
  merchantStatus?: string | null | undefined;
  capabilityStatus?: string | null | undefined;
  approvalId?: string | null | undefined;
}) {
  if (input.merchantStatus !== "ENABLED") {
    throw new HttpError(409, "LIVE_PILOT_MERCHANT_NOT_ALLOWLISTED");
  }
  if (!input.approvalId || !["APPROVED", "ENABLED"].includes(String(input.capabilityStatus || ""))) {
    throw new HttpError(409, "LIVE_PILOT_CAPABILITY_APPROVAL_REQUIRED");
  }
}

export function livePilotBlockers(input: {
  allowlisted: boolean;
  enabledCapabilities: string[];
  approvedCapabilities: string[];
}) {
  const blockers: string[] = [];
  if (!input.allowlisted) blockers.push("MISSING_PILOT_MERCHANT_ALLOWLIST");
  if (!input.approvedCapabilities.includes("LIVE_KMS")) blockers.push("LIVE_KMS_CAPABILITY_NOT_APPROVED");
  if (!input.enabledCapabilities.length) blockers.push("NO_LIVE_PILOT_CAPABILITIES_ENABLED");
  return blockers;
}
