import { AddressGeocodeStatus } from "@prisma/client";
import { env } from "../../config/env.js";
import { createAddressGeocodeCloudTask } from "../../lib/cloudTasks.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { addressFingerprint } from "./address-fingerprint.js";
import {
  ADDRESS_GEOCODE_PROVIDER_GOOGLE,
  type AddressFields,
  type AddressGeocodeEntityType,
  type AddressGeocodeTaskRecord,
  type GoogleGeocodeResult
} from "./address-geocoding.types.js";
import { geocodeAddressWithGoogle } from "./google-geocoding.client.js";
import { reserveGoogleGeocodeQuota } from "./google-maps-quota.service.js";

type DbClient = typeof prisma | Record<string, any>;

type AddressGeocodeLogger = {
  info(payload: unknown, message: string): void;
  warn(payload: unknown, message: string): void;
};

type AddressGeocodeDispatchResult = {
  ok: boolean;
  status: "created" | "already_exists" | "enqueue_failed";
};

export type MarkAddressForGeocodingInput = {
  entityType: AddressGeocodeEntityType;
  entityId: string;
  merchantId: string;
  address: AddressFields;
  previousAddressFingerprint?: string | null | undefined;
};

type MarkAddressForGeocodingDeps = {
  enqueueAddressGeocodeTask?: (taskId: string) => Promise<unknown>;
  log?: AddressGeocodeLogger;
};

function envBoolean(name: string, fallback: boolean) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off", ""].includes(normalized)) return false;
  return fallback;
}

function geocodingEnabled() {
  return envBoolean("GOOGLE_PICKUP_GEOCODING_ENABLED", env.GOOGLE_PICKUP_GEOCODING_ENABLED);
}

function geocodingApiKey() {
  return process.env.GOOGLE_GEOCODING_API_KEY?.trim() || env.GOOGLE_GEOCODING_API_KEY?.trim() || "";
}

function safeErrorMessage(err: unknown) {
  return err instanceof Error ? err.message.slice(0, 160) : "UNKNOWN_ADDRESS_GEOCODE_DISPATCH_ERROR";
}

export async function enqueueAddressGeocodeTask(taskId: string) {
  return createAddressGeocodeCloudTask({
    taskId: `address-geocode-${taskId}`,
    payload: { taskId }
  });
}

function taskStatusFromEnqueueResult(result: unknown) {
  if (typeof result === "object" && result && "status" in result) {
    return String((result as { status?: unknown }).status);
  }
  return "created";
}

function geocodePatch(input: {
  status: AddressGeocodeStatus | string;
  addressFingerprint?: string | undefined;
  result?: GoogleGeocodeResult | undefined;
  errorCode?: string | null | undefined;
}) {
  return {
    ...(input.addressFingerprint ? { addressFingerprint: input.addressFingerprint } : {}),
    geocodeStatus: input.status,
    latitude: input.result?.latitude ?? null,
    longitude: input.result?.longitude ?? null,
    googleGeocodePlaceId: input.result?.googleGeocodePlaceId ?? null,
    googleFormattedAddress: input.result?.googleFormattedAddress ?? null,
    geocodeProvider: input.result?.latitude !== undefined ? ADDRESS_GEOCODE_PROVIDER_GOOGLE : null,
    geocodeLocationType: input.result?.geocodeLocationType ?? null,
    geocodePartialMatch: input.result?.geocodePartialMatch ?? null,
    geocodeErrorCode: input.result?.geocodeErrorCode ?? input.errorCode ?? null,
    geocodedAt: input.result?.latitude !== undefined ? new Date() : null
  };
}

async function updateEntityGeocode(entityType: string, entityId: string, data: Record<string, unknown>, client: DbClient) {
  if (entityType === "MERCHANT_PICKUP_POINT") {
    return (client as any).merchantPickupPoint.update({ where: { id: entityId }, data });
  }
  if (entityType === "MERCHANT_WAREHOUSE") {
    return (client as any).merchantWarehouse.update({ where: { id: entityId }, data });
  }
  return null;
}

async function findEntity(entityType: string, entityId: string, client: DbClient) {
  if (entityType === "MERCHANT_PICKUP_POINT") {
    return (client as any).merchantPickupPoint.findFirst({ where: { id: entityId } });
  }
  if (entityType === "MERCHANT_WAREHOUSE") {
    return (client as any).merchantWarehouse.findFirst({ where: { id: entityId } });
  }
  return null;
}

function addressFromEntity(entity: Record<string, unknown>): AddressFields {
  return {
    addressLine1: String(entity.addressLine1 ?? ""),
    addressLine2: entity.addressLine2 as string | null | undefined,
    city: String(entity.city ?? ""),
    state: String(entity.state ?? ""),
    pincode: String(entity.pincode ?? ""),
    country: entity.country as string | null | undefined,
    googlePlaceId: entity.googleGeocodePlaceId as string | null | undefined
  };
}

export async function markAddressForGeocoding(
  input: MarkAddressForGeocodingInput,
  client: DbClient = prisma,
  deps: MarkAddressForGeocodingDeps = {}
) {
  const fingerprint = addressFingerprint(input.address);
  if (input.previousAddressFingerprint === fingerprint) {
    return {
      status: AddressGeocodeStatus.SKIPPED,
      addressFingerprint: fingerprint,
      taskId: null
    };
  }

  if (!geocodingEnabled()) {
    await updateEntityGeocode(input.entityType, input.entityId, {
      geocodeStatus: AddressGeocodeStatus.SKIPPED,
      addressFingerprint: fingerprint,
      geocodeErrorCode: "GOOGLE_GEOCODING_DISABLED"
    }, client);
    return {
      status: AddressGeocodeStatus.SKIPPED,
      addressFingerprint: fingerprint,
      taskId: null
    };
  }

  await updateEntityGeocode(input.entityType, input.entityId, {
    geocodeStatus: AddressGeocodeStatus.PENDING,
    addressFingerprint: fingerprint,
    geocodeErrorCode: null
  }, client);

  const task = await (client as any).addressGeocodeTask.upsert({
    where: {
      entityType_entityId_addressFingerprint: {
        entityType: input.entityType,
        entityId: input.entityId,
        addressFingerprint: fingerprint
      }
    },
    create: {
      entityType: input.entityType,
      entityId: input.entityId,
      merchantId: input.merchantId,
      addressFingerprint: fingerprint,
      status: AddressGeocodeStatus.PENDING
    },
    update: {
      status: AddressGeocodeStatus.PENDING,
      lastErrorCode: null,
      runAfter: new Date()
    }
  }) as AddressGeocodeTaskRecord;

  const log = deps.log ?? logger;
  const dispatch = deps.enqueueAddressGeocodeTask ?? enqueueAddressGeocodeTask;
  let dispatchResult: AddressGeocodeDispatchResult = {
    ok: true,
    status: "created"
  };

  log.info({
    message: "address_geocode_task_enqueue_attempted",
    addressGeocode: {
      taskId: task.id,
      entityType: input.entityType,
      entityId: input.entityId
    }
  }, "address_geocode_task_enqueue_attempted");

  try {
    const result = await dispatch(task.id);
    dispatchResult = {
      ok: true,
      status: taskStatusFromEnqueueResult(result) === "already_exists" ? "already_exists" : "created"
    };
    log.info({
      message: "address_geocode_task_enqueued",
      addressGeocode: {
        taskId: task.id,
        entityType: input.entityType,
        entityId: input.entityId,
        status: dispatchResult.status
      }
    }, "address_geocode_task_enqueued");
  } catch (err) {
    dispatchResult = {
      ok: false,
      status: "enqueue_failed"
    };
    log.warn({
      message: "address_geocode_task_enqueue_failed",
      addressGeocode: {
        taskId: task.id,
        entityType: input.entityType,
        entityId: input.entityId,
        status: dispatchResult.status,
        error: safeErrorMessage(err)
      }
    }, "address_geocode_task_enqueue_failed");
  }

  return {
    status: AddressGeocodeStatus.PENDING,
    addressFingerprint: fingerprint,
    taskId: task.id,
    dispatch: dispatchResult
  };
}

export async function processAddressGeocodeTask(taskId: string, client: DbClient = prisma, deps: {
  geocode?: (input: { address: AddressFields; apiKey: string }) => Promise<GoogleGeocodeResult>;
} = {}) {
  const task = await (client as any).addressGeocodeTask.findUnique({ where: { id: taskId } }) as AddressGeocodeTaskRecord | null;
  if (!task) return { status: "not_found" as const };

  if (task.status && task.status !== AddressGeocodeStatus.PENDING) {
    return {
      status: "already_processed" as const,
      taskStatus: task.status
    };
  }

  if (!geocodingEnabled()) {
    await (client as any).addressGeocodeTask.update({
      where: { id: task.id },
      data: { status: AddressGeocodeStatus.SKIPPED, lastErrorCode: "GOOGLE_GEOCODING_DISABLED", completedAt: new Date() }
    });
    await updateEntityGeocode(task.entityType, task.entityId, { geocodeStatus: AddressGeocodeStatus.SKIPPED, geocodeErrorCode: "GOOGLE_GEOCODING_DISABLED" }, client);
    return { status: AddressGeocodeStatus.SKIPPED, errorCode: "GOOGLE_GEOCODING_DISABLED" };
  }

  const apiKey = geocodingApiKey();
  if (!apiKey) {
    await (client as any).addressGeocodeTask.update({
      where: { id: task.id },
      data: { status: AddressGeocodeStatus.SKIPPED, lastErrorCode: "GOOGLE_GEOCODING_KEY_MISSING", completedAt: new Date() }
    });
    await updateEntityGeocode(task.entityType, task.entityId, { geocodeStatus: AddressGeocodeStatus.SKIPPED, geocodeErrorCode: "GOOGLE_GEOCODING_KEY_MISSING" }, client);
    return { status: AddressGeocodeStatus.SKIPPED, errorCode: "GOOGLE_GEOCODING_KEY_MISSING" };
  }

  const quota = await reserveGoogleGeocodeQuota(client);
  if (!quota.allowed) {
    await (client as any).addressGeocodeTask.update({
      where: { id: task.id },
      data: { status: AddressGeocodeStatus.SKIPPED, lastErrorCode: quota.errorCode, completedAt: new Date() }
    });
    await updateEntityGeocode(task.entityType, task.entityId, { geocodeStatus: AddressGeocodeStatus.SKIPPED, geocodeErrorCode: quota.errorCode }, client);
    return { status: AddressGeocodeStatus.SKIPPED, errorCode: quota.errorCode };
  }

  const entity = await findEntity(task.entityType, task.entityId, client);
  if (!entity) {
    await (client as any).addressGeocodeTask.update({
      where: { id: task.id },
      data: { status: AddressGeocodeStatus.FAILED, lastErrorCode: "ADDRESS_ENTITY_NOT_FOUND", completedAt: new Date() }
    });
    return { status: AddressGeocodeStatus.FAILED, errorCode: "ADDRESS_ENTITY_NOT_FOUND" };
  }

  const geocode = deps.geocode ?? ((request) => geocodeAddressWithGoogle({ ...request }));
  const result = await geocode({ address: addressFromEntity(entity), apiKey });
  const status = result.status === "LOW_CONFIDENCE" ? AddressGeocodeStatus.LOW_CONFIDENCE
    : result.status === "GEOCODED" ? AddressGeocodeStatus.GEOCODED
      : AddressGeocodeStatus.FAILED;
  const finalErrorCode = quota.warning && !result.geocodeErrorCode ? quota.errorCode : result.geocodeErrorCode;

  const resultWithSafeError = finalErrorCode === undefined
    ? result
    : { ...result, geocodeErrorCode: finalErrorCode };
  await updateEntityGeocode(task.entityType, task.entityId, geocodePatch({
    status,
    result: resultWithSafeError
  }), client);
  await (client as any).addressGeocodeTask.update({
    where: { id: task.id },
    data: {
      status,
      attempts: { increment: 1 },
      lastErrorCode: finalErrorCode,
      completedAt: new Date()
    }
  });

  return {
    status,
    errorCode: finalErrorCode
  };
}
