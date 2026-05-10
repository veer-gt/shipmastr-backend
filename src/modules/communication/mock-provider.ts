import type { CommunicationProvider, SendMessageInput, SendMessageResult } from "./communication-provider.types.js";

function shouldFail(metadata: SendMessageInput["metadata"]) {
  return metadata?.mockProviderFailure === true || metadata?.forceProviderFailure === true;
}

export class MockCommunicationProvider implements CommunicationProvider {
  readonly name = "mock";

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    if (shouldFail(input.metadata)) {
      throw new Error("MOCK_PROVIDER_FAILURE");
    }

    return {
      providerMessageId: `mock_${input.channel.toLowerCase()}_${input.communicationEventId}`,
      status: "SENT",
      rawResponse: {
        provider: this.name,
        idempotencyKey: input.idempotencyKey,
        channel: input.channel,
        template: input.template
      }
    };
  }
}
