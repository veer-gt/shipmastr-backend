export type NormalizedBigshipError = {
  code: string;
  message: string;
  retryable: boolean;
  statusCode?: number;
};

type ProviderErrorOptions = {
  code: string;
  message: string;
  statusCode?: number;
  retryable?: boolean;
};

export class BigshipConfigError extends Error {
  readonly code = "COURIER_PROVIDER_CONFIG_ERROR";
  readonly retryable = false;

  constructor(message = "Courier provider configuration is incomplete.") {
    super(message);
    this.name = "BigshipConfigError";
  }
}

export class BigshipValidationError extends Error {
  readonly code = "COURIER_PROVIDER_VALIDATION_ERROR";
  readonly retryable = false;

  constructor(message = "Courier provider request is invalid.") {
    super(message);
    this.name = "BigshipValidationError";
  }
}

export class BigshipProviderError extends Error {
  readonly code: string;
  readonly statusCode?: number;
  readonly retryable: boolean;

  constructor(options: ProviderErrorOptions) {
    super(options.message);
    this.name = "BigshipProviderError";
    this.code = options.code;
    if (options.statusCode !== undefined) this.statusCode = options.statusCode;
    this.retryable = options.retryable ?? false;
  }
}

function statusCodeFrom(error: unknown) {
  if (error && typeof error === "object" && "statusCode" in error) {
    const statusCode = Number((error as { statusCode?: unknown }).statusCode);
    if (Number.isInteger(statusCode)) return statusCode;
  }

  return undefined;
}

function retryableFromStatus(statusCode: number | undefined) {
  if (statusCode === undefined) return false;
  return statusCode === 408 || statusCode === 429 || statusCode >= 500;
}

export function normalizeBigshipError(error: unknown): NormalizedBigshipError {
  if (error instanceof BigshipConfigError) {
    return {
      code: error.code,
      message: "Courier provider configuration is incomplete.",
      retryable: false
    };
  }

  if (error instanceof BigshipValidationError) {
    return {
      code: error.code,
      message: "Courier provider request is invalid.",
      retryable: false
    };
  }

  if (error instanceof BigshipProviderError) {
    const normalized: NormalizedBigshipError = {
      code: error.code,
      message: "Courier provider request failed.",
      retryable: error.retryable
    };
    if (error.statusCode !== undefined) normalized.statusCode = error.statusCode;
    return normalized;
  }

  const statusCode = statusCodeFrom(error);
  const normalized: NormalizedBigshipError = {
    code: "COURIER_PROVIDER_ERROR",
    message: "Courier provider request failed.",
    retryable: retryableFromStatus(statusCode)
  };

  if (statusCode !== undefined) normalized.statusCode = statusCode;
  return normalized;
}
