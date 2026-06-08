import { HttpError } from "../../../lib/httpError.js";

const writeOperationPattern = /create|update|delete|mutate|import|fulfill|fulfillment|tracking|sync|register|webhook\.create|order\.import/i;

export function assertPlatformReadOnlyOperation(operation: string, method = "GET") {
  const normalizedMethod = method.toUpperCase();
  if (!["GET", "HEAD"].includes(normalizedMethod) || writeOperationPattern.test(operation)) {
    throw new HttpError(405, "PLATFORM_CLIENT_MUTATION_BLOCKED", {
      operation,
      method: normalizedMethod,
      message: "Platform client health checks may only perform read-only operations."
    });
  }
}

export function unsupportedRealReadResult(platform: string) {
  return {
    status: "SKIPPED" as const,
    message: `${platform} real read checks are not enabled for this foundation environment.`,
    safeDetails: {
      mockMode: true,
      realReadsEnabled: false
    }
  };
}
