import { env } from "../../../../config/env.js";

export type ShiprocketLiveCredentials = {
  email: string;
  password: string;
};

export class ShiprocketCredentialResolutionError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("Shiprocket credential resolution failed.");
    this.name = "ShiprocketCredentialResolutionError";
    this.code = code;
  }
}

type Source = Record<string, unknown>;

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseCredentials(raw: unknown): Record<string, unknown> {
  if (!raw) throw new ShiprocketCredentialResolutionError("LIVE_SHIPROCKET_CREDENTIAL_REF_UNRESOLVED");
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string") throw new ShiprocketCredentialResolutionError("LIVE_SHIPROCKET_CREDENTIAL_REF_UNRESOLVED");
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    throw new ShiprocketCredentialResolutionError("LIVE_SHIPROCKET_CREDENTIAL_REF_UNRESOLVED");
  }
  throw new ShiprocketCredentialResolutionError("LIVE_SHIPROCKET_CREDENTIAL_REF_UNRESOLVED");
}

export function resolveShiprocketLiveCredentials(
  credentialRef: string | null | undefined,
  source: Source = env
): ShiprocketLiveCredentials {
  if (credentialRef !== "env:SHIPROCKET_LIVE_CREDENTIALS") {
    throw new ShiprocketCredentialResolutionError("LIVE_SHIPROCKET_CREDENTIAL_REF_UNRESOLVED");
  }

  const parsed = parseCredentials(source.SHIPROCKET_LIVE_CREDENTIALS);
  const email = stringValue(parsed.email);
  const password = stringValue(parsed.password);
  if (!email || !password) {
    throw new ShiprocketCredentialResolutionError("LIVE_SHIPROCKET_CREDENTIAL_REF_UNRESOLVED");
  }

  return { email, password };
}

export function canResolveShiprocketLiveCredentials(
  credentialRef: string | null | undefined,
  source: Source = env
) {
  try {
    resolveShiprocketLiveCredentials(credentialRef, source);
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      code: error instanceof ShiprocketCredentialResolutionError
        ? error.code
        : "LIVE_SHIPROCKET_CREDENTIAL_REF_UNRESOLVED"
    };
  }
}
