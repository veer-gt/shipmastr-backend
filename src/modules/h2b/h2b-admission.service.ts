import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  H2BAdmissionStatus,
  H2BOutboxStatus,
  Prisma,
  StorePlatform
} from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { HttpError } from "../../lib/httpError.js";
import { resolvePlatformWebhookCredentialCandidates } from "../credentialVault/platform-webhook-credential.service.js";
import { PLATFORM_WEBHOOK_SIGNATURE_PURPOSE } from "../credentialVault/platform-webhook-credential.crypto.js";
import { extractH2BSafeEnvelope } from "./h2b-safe-envelope.js";
import { deliveryIdForProvider, H2B_INITIAL_TOPICS, providerFromPlatform, signatureForProvider, topicForProvider, type H2BProvider } from "./h2b.types.js";
import { resolveH2BEndpoint } from "./h2b-endpoint.service.js";

type Db = Prisma.TransactionClient | typeof prisma;

function bodyHash(rawBody: Buffer) {
  return createHash("sha256").update(rawBody).digest("hex");
}

function headerValue(headers: Record<string, unknown>, name: string) {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  const value = key ? headers[key] : undefined;
  return Array.isArray(value) ? String(value[0] ?? "").trim() : String(value ?? "").trim();
}

function requiredHeaders(provider: H2BProvider, headers: Record<string, unknown>, topic: string, deliveryId: string) {
  if (!topic || !deliveryId || !signatureForProvider(provider, headers)) return false;
  if (provider === "SHOPIFY") return Boolean(headerValue(headers, "x-shopify-shop-domain"));
  if (provider === "WOOCOMMERCE") return Boolean(
    headerValue(headers, "x-wc-webhook-source") || headerValue(headers, "x-wc-webhook-topic")
  );
  return Boolean(headerValue(headers, "x-magento-event"));
}

function compareBase64(left: string, right: string) {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function verifySignature(provider: H2BProvider, headers: Record<string, unknown>, rawBody: Buffer, secrets: string[]) {
  const signature = signatureForProvider(provider, headers);
  if (!signature || !secrets.length) return false;
  return secrets.some((secret) => compareBase64(signature, createHmac("sha256", secret).update(rawBody).digest("base64")));
}

function parseJson(rawBody: Buffer): unknown {
  try {
    return JSON.parse(rawBody.toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "H2B_JSON_INVALID");
  }
}

async function serializable<T>(client: Db, callback: (tx: Prisma.TransactionClient) => Promise<T>) {
  if ("$transaction" in client && typeof (client as typeof prisma).$transaction === "function") {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await (client as typeof prisma).$transaction(callback, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable
        });
      } catch (error) {
        if (attempt === 0 && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") continue;
        throw error;
      }
    }
  }
  return callback(client as Prisma.TransactionClient);
}

function isUnique(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

export type H2BAdmissionResult = {
  provider: H2BProvider;
  topic: string;
  status: "ACCEPTED" | "DUPLICATE" | "IGNORED";
  duplicate: boolean;
  safeEndpointFingerprint: string;
};

export async function admitH2BWebhook(input: {
  endpointToken: string;
  headers: Record<string, unknown>;
  rawBody: Buffer;
  client?: Db;
}): Promise<H2BAdmissionResult> {
  const client = input.client ?? prisma;
  const endpoint = await resolveH2BEndpoint(input.endpointToken, client);
  const provider = providerFromPlatform(endpoint.platform);
  const topic = topicForProvider(provider, input.headers);
  const deliveryId = deliveryIdForProvider(provider, input.headers);
  if (!requiredHeaders(provider, input.headers, topic, deliveryId)) throw new HttpError(400, "H2B_REQUIRED_HEADER_MISSING");
  const credentials = await resolvePlatformWebhookCredentialCandidates({
    merchantId: endpoint.merchantId,
    connectionId: endpoint.connectionId,
    platform: provider,
    purpose: PLATFORM_WEBHOOK_SIGNATURE_PURPOSE
  }, client);
  if (!verifySignature(provider, input.headers, input.rawBody, [credentials.current, credentials.previous].filter((value): value is string => Boolean(value)))) {
    throw new HttpError(401, "H2B_SIGNATURE_INVALID");
  }
  if (!H2B_INITIAL_TOPICS[provider].includes(topic)) {
    return {
      provider,
      topic,
      status: "IGNORED",
      duplicate: false,
      safeEndpointFingerprint: endpoint.safeFingerprint
    };
  }
  const payload = parseJson(input.rawBody);
  const safeEnvelope = extractH2BSafeEnvelope(provider, topic, payload);
  const payloadSha256 = bodyHash(input.rawBody);
  try {
    await serializable(client, async (tx) => {
      const admission = await tx.h2BWebhookAdmission.create({
        data: {
          merchantId: endpoint.merchantId,
          connectionId: endpoint.connectionId,
          platform: endpoint.platform as StorePlatform,
          topic,
          deliveryId,
          payloadSha256,
          safeEnvelope: safeEnvelope as Prisma.InputJsonValue,
          status: H2BAdmissionStatus.PENDING,
          duplicate: false
        }
      });
      await tx.h2BWebhookOutbox.create({
        data: {
          admissionId: admission.id,
          merchantId: endpoint.merchantId,
          connectionId: endpoint.connectionId,
          platform: endpoint.platform as StorePlatform,
          topic,
          envelope: safeEnvelope as Prisma.InputJsonValue,
          status: H2BOutboxStatus.PENDING
        }
      });
      await tx.h2BWebhookAdmission.update({
        where: { id: admission.id },
        data: { status: H2BAdmissionStatus.ACCEPTED, acceptedAt: new Date() }
      });
    });
  } catch (error) {
    if (!isUnique(error)) throw new HttpError(500, "H2B_ADMISSION_PERSISTENCE_FAILED");
    const existing = await client.h2BWebhookAdmission.findUnique({
      where: {
        platform_connectionId_deliveryId: {
          platform: endpoint.platform as StorePlatform,
          connectionId: endpoint.connectionId,
          deliveryId
        }
      }
    });
    if (!existing) throw new HttpError(500, "H2B_ADMISSION_PERSISTENCE_FAILED");
    return {
      provider,
      topic,
      status: "DUPLICATE",
      duplicate: true,
      safeEndpointFingerprint: endpoint.safeFingerprint
    };
  }
  return {
    provider,
    topic,
    status: "ACCEPTED",
    duplicate: false,
    safeEndpointFingerprint: endpoint.safeFingerprint
  };
}
