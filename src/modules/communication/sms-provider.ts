import type {
  CommunicationProvider,
  SendMessageInput,
  SendMessageResult,
  SmsProviderName
} from "./communication-provider.types.js";

export class SmsCommunicationProvider implements CommunicationProvider {
  readonly name: string;

  constructor(private readonly provider: Exclude<SmsProviderName, "mock">) {
    this.name = `sms:${provider}`;
  }

  async sendMessage(_input: SendMessageInput): Promise<SendMessageResult> {
    throw new Error(`SMS_PROVIDER_NOT_CONFIGURED:${this.provider}`);
  }
}
