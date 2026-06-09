import type { EmailDeliveryProvider } from "./email-delivery.types.js";

export type SandboxEmailInput = {
  provider: EmailDeliveryProvider;
  recipientSafe: string;
  subject: string;
  notificationId?: string | null;
};

export async function deliverSandboxEmail(input: SandboxEmailInput) {
  return {
    status: "SANDBOX_RECORDED" as const,
    sentAt: new Date(),
    safeMeta: {
      sandbox: true,
      provider_mode: input.provider,
      recipient_safe: input.recipientSafe,
      notification_id: input.notificationId ?? null,
      delivery_note: "Recorded by Shipmastr sandbox provider. No broad real email was sent."
    }
  };
}
