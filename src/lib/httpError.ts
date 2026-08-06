import { isProxy } from "node:util/types";

export class HttpError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export type PublicErrorPrimitive = string | number | boolean | null;
export type PublicErrorDetails = Record<string, PublicErrorPrimitive | PublicErrorPrimitive[]>;

const publicDetailsByError = new WeakMap<object, PublicErrorDetails>();

export function getPublicHttpErrorDetails(value: unknown): PublicErrorDetails | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  return publicDetailsByError.get(value);
}

function isPrimitive(value: unknown): value is PublicErrorPrimitive {
  return value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

function snapshotPrimitiveArray(value: unknown): PublicErrorPrimitive[] | undefined {
  if (!value || typeof value !== "object" || isProxy(value) || !Array.isArray(value)) return undefined;
  if (Object.getPrototypeOf(value) !== Array.prototype) return undefined;

  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !lengthDescriptor
    || !("value" in lengthDescriptor)
    || lengthDescriptor.enumerable
    || lengthDescriptor.configurable
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
  ) return undefined;

  const length = lengthDescriptor.value as number;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== length + 1) return undefined;

  const snapshot: PublicErrorPrimitive[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable || !isPrimitive(descriptor.value)) {
      return undefined;
    }
    snapshot.push(descriptor.value);
  }

  Object.freeze(snapshot);
  return snapshot;
}

function snapshotPublicErrorDetails(value: unknown): PublicErrorDetails | undefined {
  try {
    if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value)) return undefined;
    if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;

    const snapshot: PublicErrorDetails = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;

      const entry = descriptor.value;
      const publicEntry = isPrimitive(entry) ? entry : snapshotPrimitiveArray(entry);
      if (publicEntry === undefined) return undefined;
      Object.defineProperty(snapshot, key, {
        value: publicEntry,
        writable: true,
        enumerable: true,
        configurable: true
      });
    }

    Object.freeze(snapshot);
    return snapshot;
  } catch {
    return undefined;
  }
}

export function isPublicErrorDetails(value: unknown): value is PublicErrorDetails {
  return snapshotPublicErrorDetails(value) !== undefined;
}

export class PublicHttpError extends HttpError {
  readonly publicDetails?: PublicErrorDetails;

  constructor(status: number, message: string, details: PublicErrorDetails) {
    super(status, message, details);
    const publicDetails = snapshotPublicErrorDetails(details);
    if (publicDetails) {
      Object.defineProperty(this, "publicDetails", {
        value: publicDetails,
        writable: false,
        enumerable: true,
        configurable: false
      });
      publicDetailsByError.set(this, publicDetails);
    }
  }
}
