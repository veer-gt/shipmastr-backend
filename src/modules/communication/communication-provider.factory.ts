import type { CommunicationChannel } from "@prisma/client";
import { env } from "../../config/env.js";
import type { CommunicationProvider, SmsProviderName, WhatsAppProviderName } from "./communication-provider.types.js";
import { MockCommunicationProvider } from "./mock-provider.js";
import { SmsCommunicationProvider } from "./sms-provider.js";
import { WhatsAppCommunicationProvider } from "./whatsapp-provider.js";

function whatsappProvider(provider: WhatsAppProviderName): CommunicationProvider {
  return provider === "mock"
    ? new MockCommunicationProvider()
    : new WhatsAppCommunicationProvider(provider);
}

function smsProvider(provider: SmsProviderName): CommunicationProvider {
  return provider === "mock"
    ? new MockCommunicationProvider()
    : new SmsCommunicationProvider(provider);
}

export function createCommunicationProvider(channel?: CommunicationChannel | undefined): CommunicationProvider {
  if (env.COMM_PROVIDER === "mock") return new MockCommunicationProvider();

  if (channel === "WHATSAPP") return whatsappProvider(env.WHATSAPP_PROVIDER);
  if (channel === "SMS") return smsProvider(env.SMS_PROVIDER);

  if (env.COMM_PROVIDER === "whatsapp") return whatsappProvider(env.WHATSAPP_PROVIDER);
  return smsProvider(env.SMS_PROVIDER);
}
