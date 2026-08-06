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

function isPrimitive(value: unknown): value is PublicErrorPrimitive {
  return value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

export function isPublicErrorDetails(value: unknown): value is PublicErrorDetails {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
    return Object.values(value).every((entry) =>
      isPrimitive(entry) || (Array.isArray(entry) && entry.every(isPrimitive))
    );
  } catch {
    return false;
  }
}

export class PublicHttpError extends HttpError {
  readonly publicDetails?: PublicErrorDetails;

  constructor(status: number, message: string, details: PublicErrorDetails) {
    super(status, message, details);
    if (isPublicErrorDetails(details)) this.publicDetails = details;
  }
}
