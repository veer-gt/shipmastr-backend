import type { CommunicationChannel, CommunicationStatus, Prisma } from "@prisma/client";

export const communicationTemplates = [
  "COD_OTP",
  "ADDRESS_CORRECTION",
  "PREPAID_LINK",
  "NDR_RECOVERY",
  "ORDER_CONFIRMATION"
] as const;

export type CommunicationTemplate = typeof communicationTemplates[number];
export type CommunicationProviderName = "mock" | "whatsapp" | "sms";
export type WhatsAppProviderName = "mock" | "gupshup" | "interakt" | "wati" | "aisensy";
export type SmsProviderName = "mock" | "msg91" | "twilio";

export type SendMessageInput = {
  communicationEventId: string;
  idempotencyKey: string;
  orderId: string;
  merchantId: string;
  phoneHash: string | null;
  recipientPhone: string;
  channel: CommunicationChannel;
  template: CommunicationTemplate;
  templateData: Prisma.InputJsonObject;
  metadata?: Prisma.InputJsonObject | undefined;
};

export type SendMessageResult = {
  providerMessageId: string;
  status: Extract<CommunicationStatus, "SENT" | "FAILED">;
  rawResponse?: Prisma.InputJsonValue | undefined;
};

export interface CommunicationProvider {
  readonly name: string;
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;
}
