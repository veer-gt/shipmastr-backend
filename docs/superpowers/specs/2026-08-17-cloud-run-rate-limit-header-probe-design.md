# Cloud Run Rate-Limit Header Probe Design

Date: 2026-08-17  
Repository: `veer-gt/shipmastr-backend`  
Approved base: `a965f4314d7af02dc45c05733efaea322acb87eb`  
Status: Approved for diagnostic-spec review; implementation not started

## Purpose

Determine which requester identity inputs are trustworthy at the Express rate-limit boundary when Shipmastr receives requests directly through Google-managed Cloud Run ingress.

The investigation was triggered by `express-rate-limit` reporting `ERR_ERL_FORWARDED_HEADER` in both staging and production. The finding is security-relevant because the application currently configures `TRUSTED_PROXY_HOPS=0`, so the default limiter uses `req.socket.remoteAddress`. Behind Cloud Run, that may group many internet callers under a small set of proxy addresses.

No rate-limit fix will be selected until the probe identifies the actual header behavior.

## Fixed Constraints

- Shipmastr has no external load balancer in this request path.
- The relevant topology is `client or n8n -> Google-managed Cloud Run ingress -> Express container`.
- Cloud Load Balancing behavior and multi-load-balancer hop counts are out of scope.
- Courier Audit Intake remains disabled in staging and production during the investigation.
- Production is not modified by the probe.
- Existing migrations and `shipmastr-courier-audit-intake-signing-secret` remain unchanged.
- Gmail, external AI, n8n execution, notifications, and outbound processing remain inactive.
- n8n receives no rate-limit exemption. Its HMAC verification occurs after the route limiter, so a pre-limiter exemption would rely on unverified and spoofable input.
- No raw client address, forwarding header, authentication value, signature, token, or request body may be logged.

## Verified Middleware Order

`src/server.ts` installs middleware in this relevant order:

1. Helmet and compression.
2. CORS.
3. Global `express-rate-limit` middleware.
4. `pinoHttp` request logging.
5. JSON parsing.
6. `/api` router, including `/api/health`.

Therefore `/api/health` is behind the same global limiter as application routes. Existing `pinoHttp` logging cannot observe the request before the global limiter, so temporary instrumentation must be inserted before that limiter.

The Courier Audit Intake route installs its route-specific limiter before raw-body capture and HMAC verification. That ordering must not be weakened for this investigation.

## Considered Approaches

### A. Tagged, no-traffic staging revision with guarded in-app instrumentation — selected

Cut the dedicated diagnostic branch directly from the approved base SHA `a965f4314d7af02dc45c05733efaea322acb87eb`, with no unrelated commits or changes layered in. Build its temporary diagnostic image and deploy it as a staging revision using `--no-traffic` plus a unique revision tag. Send controlled requests only to the tag URL.

This observes the exact Express boundary and Cloud Run ingress path without changing active staging traffic.

### B. Separate header-echo Cloud Run service — rejected

This would avoid touching the application image but would not prove that the real service, middleware order, runtime, or environment sees the same values.

### C. Raw header logging on active staging — rejected

This would produce unnecessary personal data, affect unrelated traffic, and provide a larger blast radius than required.

## Diagnostic Revision Design

The temporary build adds a probe middleware immediately before the global limiter.

The middleware is inert unless all conditions hold:

- `APP_ENV` is exactly `staging`.
- An ephemeral high-entropy probe token is configured.
- The request supplies the exact token in a dedicated diagnostic header.

Startup must fail if the probe token is configured outside staging. The token must never be logged, returned, committed, or reused as an application credential.

The middleware does not change the request, response, `req.ip`, Express `trust proxy` setting, limiter options, route registration, or feature flags. It emits one structured diagnostic event and calls `next()`.

## Structural Evidence Only

For a matching probe request, record only:

- probe case label;
- request path;
- whether `Forwarded` is present;
- `Forwarded` element count or parse-status category;
- position of the expected `Forwarded` TEST-NET marker, or `absent`;
- whether `X-Forwarded-For` is present;
- `X-Forwarded-For` element count;
- position of the expected `X-Forwarded-For` TEST-NET marker, or `absent`;
- whether `req.ip` equals `req.socket.remoteAddress`;
- whether `req.ip` matches an `X-Forwarded-For` element and, if so, its position;
- whether `req.socket.remoteAddress` matches an `X-Forwarded-For` element and, if so, its position.

Do not record any header value or IP address. Diagnostic parsing exists only to classify this controlled probe; it must not be reused as a trust decision.

## Probe Matrix

All requests target `/api/health` on the tagged no-traffic staging revision.

1. Baseline: no caller-supplied `Forwarded` or `X-Forwarded-For`.
2. IPv4 Forwarded-only: `Forwarded` contains `for=192.0.2.10`.
3. IPv4 XFF-only: `X-Forwarded-For` contains `198.51.100.20`.
4. IPv4 both: `Forwarded` contains `for=192.0.2.30`, while `X-Forwarded-For` contains the distinct marker `198.51.100.40`.
5. IPv6 both: `Forwarded` contains `for="[2001:db8::1]"`, while `X-Forwarded-For` contains the distinct marker `2001:db8::2`.

The distinct RFC 5737 IPv4 TEST-NET ranges and RFC 3849 IPv6 documentation prefix ensure any cross-header derivation or preservation can be attributed to the correct input header. The IPv6 case also measures whether Cloud Run preserves RFC 7239 quoting and bracket syntax differently from IPv4-shaped values.

Before interpreting results, record whether production has a direct Cloud Run domain mapping. No load-balancer inventory or load-balancer assumption is permitted. If a direct domain mapping exists and is the real production entry hostname, run the same structural probe through an equivalent staging mapping before transferring the result to production.

Also record the staging diagnostic revision's and production service's Cloud Run execution-environment generation and configured container concurrency. A staging result transfers to production only if the ingress paths are equivalent and these runtime settings are identical or any difference is shown not to affect the request boundary. This is a parity check, not evidence that generation or concurrency changes header behavior.

## Interpretation Rules

### `Forwarded`

- If it is absent in baseline and the supplied marker reaches the container unchanged, treat it as caller-controlled and never use it for rate-limit identity.
- If Cloud Run adds a stable suffix while preserving a supplied marker, only the measured trusted suffix may be considered; no leftmost entry may be trusted.
- If Cloud Run overwrites the marker with a stable value, document that observation but still avoid trusting it without repeatable evidence across probe cases.
- If behavior is inconsistent, ignore `Forwarded` for keying.

With no external load balancer or other deliberate proxy, caller control is the expected outcome unless the probe proves otherwise.

### `X-Forwarded-For`

- If Cloud Run overwrites supplied values, determine which resulting position represents the internet caller.
- If it preserves supplied prefixes and appends a stable controlled suffix, only a fixed measured position relative to that suffix may be considered.
- If no stable controlled suffix exists, the header is unsuitable for rate-limit identity.
- `TRUSTED_PROXY_HOPS` may be changed only if the probe proves a single fixed path and hop count.

### Current limiter behavior

If `req.ip === req.socket.remoteAddress` and neither corresponds to the measured internet-caller position, the current limiter is proxy-keyed rather than client-keyed. This confirms the broader shared-bucket defect independently of `Forwarded` handling.

## Fix Selection After Evidence

The probe branch does not implement the production fix.

After results are reviewed, choose exactly one client-key strategy supported by the measured topology:

- Express `trust proxy` with an exact fixed hop count and `req.ip`, if the single path and sanitized `X-Forwarded-For` behavior make that safe; or
- a shared custom key generator selecting only a proven trusted position and passing the result through `express-rate-limit`'s `ipKeyGenerator`.

If `Forwarded` is proven caller-controlled and intentionally ignored, its express-rate-limit validation may be disabled only as part of the verified `X-Forwarded-For` solution. Disabling the warning alone is not a fix.

The final helper must be shared by both the global limiter and Courier Audit Intake limiter, with regression tests for spoofed prefixes, IPv4, IPv6, missing headers, malformed headers, and the measured Cloud Run chain.

## Isolation, Teardown, and Rollback

- Deploy the diagnostic image to staging with zero normal traffic and a unique tag.
- Do not enable Courier Audit Intake on the diagnostic revision.
- Do not deploy the diagnostic image to production.
- After evidence capture, remove the revision tag and ephemeral probe environment value.
- Leave the existing active staging revision and its 100% traffic allocation unchanged.
- Do not merge the diagnostic instrumentation.
- Preserve the probe output in the hotfix evidence record without raw headers or addresses.

## Acceptance Criteria

The probe is complete only when:

- all five controlled requests return the expected health response;
- one structural event is captured for each probe case;
- no raw address, header value, token, signature, or body appears in diagnostic logs;
- the source and position behavior of both forwarding headers is unambiguous;
- current `req.ip` behavior is classified;
- any direct Cloud Run domain mapping used by production has been accounted for;
- Cloud Run execution-environment generation and container concurrency parity are recorded;
- active staging and all production configuration remain unchanged;
- Courier Audit Intake remains disabled;
- the diagnostic tag and token are removed.

Only then may the rate-limit hotfix design be finalized, reviewed, implemented with failing tests first, and deployed through staging before production.

## References

- Express behind proxies: https://expressjs.com/en/5x/guide/behind-proxies
- express-rate-limit error codes: https://express-rate-limit.mintlify.app/reference/error-codes
- RFC 3849 IPv6 documentation prefix: https://www.rfc-editor.org/rfc/rfc3849
- Shipmastr server middleware: https://github.com/veer-gt/shipmastr-backend/blob/a965f4314d7af02dc45c05733efaea322acb87eb/src/server.ts
- Courier Audit Intake route: https://github.com/veer-gt/shipmastr-backend/blob/a965f4314d7af02dc45c05733efaea322acb87eb/src/modules/courierAuditIntake/courier-audit-intake.routes.ts
