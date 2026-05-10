import { env } from "../../config/env.js";
import type { CarrierAdapter } from "./carrier-adapter.types.js";
import { manualCarrierAdapter, mockQaCarrierAdapter } from "./manual-carrier.adapter.js";

export type CarrierProviderName = "manual" | "mock";

export function getCarrierAdapter(input: {
  provider?: CarrierProviderName;
  appEnv?: string;
  nodeEnv?: string;
} = {}): CarrierAdapter {
  const provider = input.provider ?? env.CARRIER_PROVIDER;

  if (provider === "manual") return manualCarrierAdapter;

  if (provider === "mock") {
    const appEnv = input.appEnv ?? env.APP_ENV;
    const nodeEnv = input.nodeEnv ?? env.NODE_ENV;

    if (appEnv === "production" && nodeEnv !== "test") {
      throw new Error("CARRIER_MOCK_PROVIDER_NOT_ALLOWED_IN_PRODUCTION");
    }

    return mockQaCarrierAdapter;
  }

  return manualCarrierAdapter;
}
