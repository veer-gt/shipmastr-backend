import type { CommunicationChannel, Prisma } from "@prisma/client";
import type { CommunicationTemplate } from "./communication-provider.types.js";

export type CommunicationTemplateDefinition = {
  template: CommunicationTemplate;
  channel: Extract<CommunicationChannel, "WHATSAPP" | "SMS">;
  requiredVariables: string[];
  critical: boolean;
  fallbackText: string;
};

export const communicationTemplateRegistry: Record<CommunicationTemplate, CommunicationTemplateDefinition> = {
  COD_OTP: {
    template: "COD_OTP",
    channel: "WHATSAPP",
    requiredVariables: ["orderId"],
    critical: true,
    fallbackText: "Please verify your COD order before shipment."
  },
  ADDRESS_CORRECTION: {
    template: "ADDRESS_CORRECTION",
    channel: "WHATSAPP",
    requiredVariables: ["orderId"],
    critical: false,
    fallbackText: "Please confirm or correct your delivery address."
  },
  PREPAID_LINK: {
    template: "PREPAID_LINK",
    channel: "SMS",
    requiredVariables: ["orderId"],
    critical: false,
    fallbackText: "A prepaid payment link is available for your order."
  },
  NDR_RECOVERY: {
    template: "NDR_RECOVERY",
    channel: "WHATSAPP",
    requiredVariables: ["orderId"],
    critical: false,
    fallbackText: "Please confirm if you want another delivery attempt."
  },
  ORDER_CONFIRMATION: {
    template: "ORDER_CONFIRMATION",
    channel: "SMS",
    requiredVariables: ["orderId"],
    critical: false,
    fallbackText: "Your order has been received."
  }
};

export function validateTemplateData(template: CommunicationTemplate, data: Prisma.InputJsonObject) {
  const definition = communicationTemplateRegistry[template];
  const missingVariables = definition.requiredVariables.filter((key) => {
    const value = data[key];
    return value === null || value === undefined || value === "";
  });

  return {
    ok: missingVariables.length === 0,
    missingVariables,
    definition
  };
}
