import { Prisma, type CourierProviderCredential } from "@prisma/client";
import { HttpError } from "../../../lib/httpError.js";
import { prisma } from "../../../lib/prisma.js";
import { getLivePilotReadinessSnapshot } from "../../livePilot/live-pilot.service.js";
import {
  assertRequiredFieldsSchema,
  getCourierLiveProviderDefinition,
  providerSupportsProbe,
  requiredFieldNames
} from "./courier-live-readiness.providers.js";
import {
  isCourierCredentialLiveReady,
  readinessBlockers,
  serializeCourierCredential,
  serializeCourierLiveProvider,
  serializeCourierProbe
} from "./courier-live-readiness.serializer.js";
import type {
  CourierLiveProbeResult,
  CourierLiveProbeType,
  CourierLiveProviderKey,
  CourierLiveReadinessSnapshot
} from "./courier-live-readiness.types.js";
import type {
  CourierCredentialInput,
  CourierCredentialQuery,
  CourierProbeInput
} from "./courier-live-readiness.validation.js";
import { isAllowedProbeType } from "./courier-live-readiness.validation.js";

type Db = Prisma.TransactionClient | typeof prisma;

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
}

function fieldList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()))]
    : [];
}

function requiredFieldsPresent(input: CourierCredentialInput, definition = getCourierLiveProviderDefinition("BIGSHIP")) {
  assertRequiredFieldsSchema(definition.requiredFields);
  const requiredFields = requiredFieldNames(definition.requiredFields);
  const explicit = fieldList(input.required_fields_present);
  const safeMetaPresent = fieldList(input.safe_meta?.required_fields_present);
  return [...new Set([...explicit, ...safeMetaPresent])].filter((field) => requiredFields.includes(field));
}

function credentialStatus(input: {
  credentialRef?: string | null;
  missingFields: string[];
  mode: string;
}) {
  if (!input.credentialRef) return "MISSING_CREDENTIALS";
  if (input.missingFields.length) return "CONFIGURED";
  return "CONFIGURED";
}

async function assertLiveModeGate(merchantId: string | null, mode: string, client: Db) {
  if (mode !== "LIVE") return;
  if (!merchantId) throw new HttpError(409, "LIVE_PROVIDER_NOT_PILOT_GATED");
  const pilot = await getLivePilotReadinessSnapshot(merchantId, client);
  if (!pilot.allowlisted) throw new HttpError(409, "LIVE_PILOT_MERCHANT_NOT_ALLOWLISTED");
  if (!pilot.enabledCapabilities.includes("LIVE_COURIER_RATES")) {
    throw new HttpError(409, "LIVE_COURIER_RATES_CAPABILITY_REQUIRED");
  }
}

async function getCredentialRecord(
  merchantId: string,
  providerKey: CourierLiveProviderKey,
  credentialId: string,
  client: Db
) {
  const record = await client.courierProviderCredential.findFirst({
    where: { id: credentialId, providerKey, merchantId }
  });
  if (!record) throw new HttpError(404, "COURIER_PROVIDER_CREDENTIAL_NOT_FOUND");
  return record;
}

function safeProbeSummary(input: {
  providerKey: CourierLiveProviderKey;
  probeType: CourierLiveProbeType;
  mode: string;
  passed: boolean;
  status: "PASS" | "FAIL" | "TIMEOUT" | "BLOCKED";
  testedAt: string;
  warnings?: string[];
}) {
  const definition = getCourierLiveProviderDefinition(input.providerKey);
  return {
    probeType: input.probeType,
    status: input.status,
    testedAt: input.testedAt,
    latencyMs: 0,
    safeMessage: input.passed
      ? "Non-destructive readiness probe passed without storing provider output."
      : "Non-destructive readiness probe did not pass; no provider output was stored.",
    warnings: [
      `Mode ${input.mode} remained non-destructive.`,
      `AWB/label readiness support recorded: ${definition.supportsAwbLabelReadiness ? "yes" : "no"}.`,
      ...(input.warnings ?? [])
    ].map((warning) => warning.slice(0, 160))
  };
}

export async function listCourierLiveProviders() {
  return {
    providers: (["BIGSHIP", "SHIPMOZO", "SHIPROCKET"] as CourierLiveProviderKey[]).map(serializeCourierLiveProvider)
  };
}

export async function getCourierLiveProvider(providerKey: CourierLiveProviderKey) {
  return {
    provider: serializeCourierLiveProvider(providerKey)
  };
}

export async function listCourierProviderCredentials(
  merchantId: string,
  providerKey: CourierLiveProviderKey,
  query: CourierCredentialQuery = {},
  client: Db = prisma
) {
  const records = await client.courierProviderCredential.findMany({
    where: {
      providerKey,
      merchantId,
      ...(query.mode ? { mode: query.mode } : {})
    },
    orderBy: { updatedAt: "desc" },
    take: 50
  });
  return {
    provider: serializeCourierLiveProvider(providerKey),
    credentials: records.map(serializeCourierCredential)
  };
}

export async function createCourierProviderCredential(
  merchantId: string,
  providerKey: CourierLiveProviderKey,
  input: CourierCredentialInput,
  client: Db = prisma
) {
  const definition = getCourierLiveProviderDefinition(providerKey);
  assertRequiredFieldsSchema(definition.requiredFields);
  const scopedMerchantId = input.merchant_id ?? merchantId;
  if (scopedMerchantId !== merchantId) throw new HttpError(403, "COURIER_PROVIDER_CREDENTIAL_SCOPE_MISMATCH");
  await assertLiveModeGate(scopedMerchantId, input.mode, client);
  const presentFields = requiredFieldsPresent(input, definition);
  const missingFields = requiredFieldNames(definition.requiredFields).filter((field) => !presentFields.includes(field));
  const safeMeta = {
    ...(input.safe_meta ?? {}),
    required_fields_present: presentFields,
    missing_fields: missingFields,
    credential_values_stored: false,
    credential_ref_only: true,
    notes: input.notes ?? null
  };
  const record = await client.courierProviderCredential.create({
    data: {
      merchantId: scopedMerchantId,
      providerKey,
      mode: input.mode,
      status: credentialStatus({ credentialRef: input.credential_ref ?? null, missingFields, mode: input.mode }),
      credentialRef: input.credential_ref ?? null,
      requiredFields: toJson(definition.requiredFields),
      safeMeta: toJson(safeMeta)
    }
  });
  return {
    provider: serializeCourierLiveProvider(providerKey),
    credential: serializeCourierCredential(record)
  };
}

export async function getCourierProviderCredential(
  merchantId: string,
  providerKey: CourierLiveProviderKey,
  credentialId: string,
  client: Db = prisma
) {
  const credential = await getCredentialRecord(merchantId, providerKey, credentialId, client);
  const probes = await client.courierProviderReadinessProbe.findMany({
    where: { credentialId: credential.id },
    orderBy: { testedAt: "desc" },
    take: 10
  });
  return {
    provider: serializeCourierLiveProvider(providerKey),
    credential: serializeCourierCredential(credential),
    probes: probes.map(serializeCourierProbe)
  };
}

export async function revokeCourierProviderCredential(
  merchantId: string,
  providerKey: CourierLiveProviderKey,
  credentialId: string,
  client: Db = prisma
) {
  await getCredentialRecord(merchantId, providerKey, credentialId, client);
  const record = await client.courierProviderCredential.update({
    where: { id: credentialId },
    data: {
      status: "REVOKED",
      lastTestStatus: "REVOKED",
      lastTestSummary: toJson({
        revoked: true,
        credential_values_exposed: false,
        raw_response_stored: false
      })
    }
  });
  return {
    provider: serializeCourierLiveProvider(providerKey),
    credential: serializeCourierCredential(record)
  };
}

export async function testCourierProviderCredential(
  merchantId: string,
  providerKey: CourierLiveProviderKey,
  credentialId: string,
  input: CourierProbeInput,
  client: Db = prisma
): Promise<{ credential: ReturnType<typeof serializeCourierCredential>; probe: CourierLiveProbeResult }> {
  if (!isAllowedProbeType(input.probe_type)) {
    throw new HttpError(400, "COURIER_PROVIDER_DESTRUCTIVE_PROBE_REJECTED");
  }
  const probeType = input.probe_type;
  if (!providerSupportsProbe(providerKey, probeType)) {
    throw new HttpError(400, "COURIER_PROVIDER_PROBE_UNSUPPORTED");
  }
  const credential = await getCredentialRecord(merchantId, providerKey, credentialId, client);
  if (credential.status === "REVOKED") throw new HttpError(409, "COURIER_PROVIDER_CREDENTIAL_REVOKED");
  await assertLiveModeGate(credential.merchantId ?? merchantId, input.mode ?? credential.mode, client);
  const missingCredential = !credential.credentialRef;
  const missingFields = serializeCourierCredential(credential).missing_fields;
  const forcedFailure = Boolean(input.safe_context?.force_fail);
  const passed = !missingCredential && !missingFields.length && !forcedFailure;
  const errors = [
    ...(missingCredential ? ["LIVE_PROVIDER_CREDENTIALS_MISSING"] : []),
    ...(missingFields.length ? ["LIVE_PROVIDER_CREDENTIALS_INCOMPLETE"] : []),
    ...(forcedFailure ? ["LIVE_PROVIDER_TEST_FAILED"] : [])
  ];
  const warnings = [
    "No live provider call was made by this foundation probe.",
    ...((input.mode ?? credential.mode) === "LIVE" ? ["LIVE mode remained pilot-gated and non-destructive."] : [])
  ];
  const status = passed ? "PASS" : "FAIL";
  const testedAt = new Date().toISOString();
  const safeSummary = safeProbeSummary({
    providerKey,
    probeType,
    mode: input.mode ?? credential.mode,
    passed,
    status,
    testedAt,
    warnings
  });
  const probe = await client.courierProviderReadinessProbe.create({
    data: {
      credentialId: credential.id,
      merchantId: credential.merchantId,
      providerKey,
      probeType,
      mode: input.mode ?? credential.mode,
      status,
      safeSummary: toJson(safeSummary),
      warnings: toJson(warnings),
      errors: toJson(errors)
    }
  });
  const updated = await client.courierProviderCredential.update({
    where: { id: credential.id },
    data: {
      status: passed ? "ACTIVE" : "FAILED",
      lastTestedAt: probe.testedAt,
      lastTestStatus: status,
      lastTestSummary: toJson(safeSummary)
    }
  });
  return {
    credential: serializeCourierCredential(updated),
    probe: serializeCourierProbe(probe)
  };
}

export async function getCourierLiveReadinessSnapshot(
  merchantId: string,
  client: Db = prisma
): Promise<CourierLiveReadinessSnapshot> {
  const model = (client as Db & { courierProviderCredential?: Db["courierProviderCredential"] }).courierProviderCredential;
  const records = model ? await model.findMany({
    where: {
      merchantId
    },
    orderBy: { updatedAt: "desc" }
  }) : [];
  const providers = (["BIGSHIP", "SHIPMOZO", "SHIPROCKET"] as CourierLiveProviderKey[]).map((providerKey) => {
    const record = records.find((item) => item.providerKey === providerKey && item.mode === "LIVE")
      ?? records.find((item) => item.providerKey === providerKey)
      ?? null;
    return {
      provider_key: providerKey,
      label: getCourierLiveProviderDefinition(providerKey).label,
      credential: record ? serializeCourierCredential(record) : null,
      live_ready: isCourierCredentialLiveReady(record),
      blockers: readinessBlockers(record)
    };
  });
  const activeProviderCount = providers.filter((item) => item.live_ready).length;
  return {
    merchant_id: merchantId,
    checked_at: new Date().toISOString(),
    providers,
    active_provider_count: activeProviderCount,
    has_active_provider: activeProviderCount > 0,
    blockers: activeProviderCount ? [] : ["LIVE_PROVIDER_CREDENTIALS_MISSING"]
  };
}

export async function listPlatformLevelCourierProviderCredentialsForAdmin(
  providerKey: CourierLiveProviderKey,
  query: CourierCredentialQuery = {},
  client: Db = prisma
) {
  const records = await client.courierProviderCredential.findMany({
    where: {
      providerKey,
      merchantId: null,
      ...(query.mode ? { mode: query.mode } : {})
    },
    orderBy: { updatedAt: "desc" },
    take: 50
  });
  return {
    provider: serializeCourierLiveProvider(providerKey),
    credentials: records.map(serializeCourierCredential)
  };
}

export async function getActiveLiveCourierProvider(
  merchantId: string,
  client: Db = prisma
): Promise<CourierProviderCredential | null> {
  const records = await client.courierProviderCredential.findMany({
    where: {
      merchantId,
      mode: "LIVE",
      status: "ACTIVE",
      credentialRef: { not: null },
      lastTestStatus: "PASS",
      lastTestedAt: { not: null }
    },
    orderBy: { lastTestedAt: "desc" },
    take: 1
  });
  return records[0] ?? null;
}
