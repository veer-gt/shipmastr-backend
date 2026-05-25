import { env } from "../../../config/env.js";
import { HttpError } from "../../../lib/httpError.js";
import { resolveDomainProviderMode } from "../domain-provider-mode.js";

export type CloudflareCustomHostnameInput = {
  domain: string;
  merchantId: string;
  storefrontId?: string | null;
  merchantDomainId: string;
};

export type CloudflareCustomHostnameBody = {
  hostname: string;
  ssl: {
    method: "http";
    type: "dv";
    settings: {
      min_tls_version: "1.2";
    };
  };
  custom_metadata?: {
    merchant_id: string;
    storefront_id: string | null;
    merchant_domain_id: string;
    source: "shipmastr-domains";
  };
};

export type CloudflareAuthMode = "api_token" | "global_key";
export type CloudflareHeaderSource = {
  CLOUDFLARE_AUTH_MODE?: CloudflareAuthMode | string | undefined;
  CLOUDFLARE_AUTH_EMAIL?: string | undefined;
  CLOUDFLARE_GLOBAL_API_KEY?: string | undefined;
  CLOUDFLARE_API_TOKEN?: string | undefined;
};

export function resolveCloudflareAuthMode(source: CloudflareHeaderSource = env): CloudflareAuthMode {
  const authMode = String(source.CLOUDFLARE_AUTH_MODE || "api_token").trim().toLowerCase();
  if (authMode !== "api_token" && authMode !== "global_key") {
    throw new HttpError(503, "CLOUDFLARE_AUTH_MODE_UNSUPPORTED");
  }
  return authMode;
}

export function buildCloudflareHeaders(source: CloudflareHeaderSource = env): Record<string, string> {
  const authMode = resolveCloudflareAuthMode(source);

  if (authMode === "global_key") {
    const authEmail = String(source.CLOUDFLARE_AUTH_EMAIL || "").trim();
    const globalApiKey = String(source.CLOUDFLARE_GLOBAL_API_KEY || "").trim();
    if (!authEmail || !globalApiKey) {
      throw new HttpError(503, "CLOUDFLARE_GLOBAL_KEY_AUTH_NOT_CONFIGURED");
    }
    return {
      "X-Auth-Email": authEmail,
      "X-Auth-Key": globalApiKey,
      "Content-Type": "application/json"
    };
  }

  const apiToken = String(source.CLOUDFLARE_API_TOKEN || "").trim().replace(/^bearer\s+/i, "");
  if (!apiToken) {
    throw new HttpError(503, "CLOUDFLARE_API_TOKEN_AUTH_NOT_CONFIGURED");
  }
  return {
    "Authorization": `Bearer ${apiToken}`,
    "Content-Type": "application/json"
  };
}

export function assertCloudflareConfigured() {
  if (!env.CLOUDFLARE_ZONE_ID) {
    throw new HttpError(503, "DOMAIN_SSL_PROVIDER_NOT_CONFIGURED");
  }
  buildCloudflareHeaders(env);
}

export function buildCloudflareCustomHostnameBody(
  input: CloudflareCustomHostnameInput,
  options: { customMetadataEnabled?: boolean } = {}
): CloudflareCustomHostnameBody {
  const body: CloudflareCustomHostnameBody = {
    hostname: input.domain,
    ssl: {
      method: "http",
      type: "dv",
      settings: {
        min_tls_version: "1.2"
      }
    }
  };

  if (options.customMetadataEnabled === true) {
    body.custom_metadata = {
      merchant_id: input.merchantId,
      storefront_id: input.storefrontId || null,
      merchant_domain_id: input.merchantDomainId,
      source: "shipmastr-domains"
    };
  }

  return body;
}

export function buildCloudflareCustomHostnameSpec(input: CloudflareCustomHostnameInput) {
  if (resolveDomainProviderMode(env.SHIPMASTR_DOMAIN_PROVIDER_MODE) === "mock") {
    throw new HttpError(409, "DOMAIN_SSL_PROVIDER_MOCK_MODE");
  }

  assertCloudflareConfigured();

  return {
    method: "POST",
    endpoint: `https://api.cloudflare.com/client/v4/zones/${env.CLOUDFLARE_ZONE_ID}/custom_hostnames`,
    body: buildCloudflareCustomHostnameBody(input, {
      customMetadataEnabled: env.CLOUDFLARE_CUSTOM_METADATA_ENABLED
    })
  };
}

export function cloudflareCustomHostnameInternalStatus(error: { code?: number | string | null } | null | undefined) {
  if (Number(error?.code) === 1413) return "CUSTOM_METADATA_NOT_ENABLED";
  return "CLOUDFLARE_CUSTOM_HOSTNAME_ERROR";
}

export function cloudflareDuplicateHostnameSafeMessage() {
  return "This domain is already being connected. Shipmastr support can review the setup if it does not progress.";
}
