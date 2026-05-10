import type {
  CommunicationProvider,
  SendMessageInput,
  SendMessageResult,
  WhatsAppProviderName
} from "./communication-provider.types.js";

export class WhatsAppCommunicationProvider implements CommunicationProvider {
  readonly name: string;

  constructor(private readonly provider: Exclude<WhatsAppProviderName, "mock">) {
    this.name = `whatsapp:${provider}`;
  }

  async sendMessage(_input: SendMessageInput): Promise<SendMessageResult> {
    throw new Error(`WHATSAPP_PROVIDER_NOT_CONFIGURED:${this.provider}`);
  }
}
