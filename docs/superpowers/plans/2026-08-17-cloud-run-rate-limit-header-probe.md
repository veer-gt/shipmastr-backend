# Cloud Run Rate-Limit Header Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure the exact `Forwarded`, `X-Forwarded-For`, `req.ip`, and socket-address behavior at Shipmastr's pre-rate-limit Express boundary through direct Cloud Run ingress, without changing active staging traffic or production.

**Architecture:** A temporary branch anchored directly at approved commit `a965f4314d7af02dc45c05733efaea322acb87eb` adds a staging-only, token-gated structural probe immediately before the global limiter. A tagged Cloud Run revision receives zero normal traffic; five controlled health requests reach only its tag URL, after which the tag and token are removed. The diagnostic code and evidence remain isolated and are never merged as the production fix.

**Tech Stack:** Node.js 24, TypeScript 6, Express 5, Pino 10, Node's built-in test runner, Google Cloud Build, Artifact Registry, Cloud Run, Cloud Logging, Bash 3.2-compatible shell.

## Global Constraints

- Repository: `veer-gt/shipmastr-backend`.
- Exact branch base: `a965f4314d7af02dc45c05733efaea322acb87eb`.
- Branch: `hotfix/rate-limit-proxy-probe`.
- Worktree: `/Users/mac/shipmastr-backend-rate-limit-proxy-probe`.
- GCP project: `shipmastr-core-prod`; region: `asia-south1`.
- Probe service: `shipmastr-api-staging`; production is read-only.
- Shipmastr has no external load balancer in this path.
- Courier Audit Intake stays disabled everywhere.
- No migrations, database writes, Gmail calls, external-AI calls, n8n execution, notifications, or outbound communications.
- n8n is not exempted from either limiter.
- No raw IP address, forwarding-header value, token, signature, credential, or body may be logged.
- The ephemeral probe token is a 64-character random hexadecimal value passed as a temporary Cloud Run environment variable. It is not an application credential, grants no API access, and is removed immediately after evidence capture. Do not add Secret Manager or IAM mutations for it.
- The diagnostic image is deployed only with `--no-traffic` and a unique tag.
- The active staging revision and its 100% traffic allocation must not change.
- No diagnostic commit is merged to `main`.
- Do not suppress `ERR_ERL_FORWARDED_HEADER` or implement the final rate-limit fix in this plan.

---

## File Map

- Create `docs/superpowers/specs/2026-08-17-cloud-run-rate-limit-header-probe-design.md`: approved design copied verbatim from the reviewed artifact.
- Create `docs/superpowers/plans/2026-08-17-cloud-run-rate-limit-header-probe.md`: this implementation plan.
- Create `.superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/progress.md`: append-only execution ledger containing commands, commit SHAs, image digest, revision, structural findings, and teardown proof.
- Modify `src/config/env.ts`: declare the ephemeral token and fail startup if it is configured outside staging.
- Create `src/config/rate-limit-proxy-probe-env.test.ts`: subprocess tests for unset, valid staging, invalid production, and malformed token behavior.
- Create `src/middleware/rate-limit-proxy-probe.ts`: token gate, quote-aware structural parsing, privacy-preserving event creation, and Express middleware factory.
- Create `src/middleware/rate-limit-proxy-probe.test.ts`: tests for token gating, IPv4/IPv6 marker attribution, malformed input, and absence of raw data.
- Modify `src/lib/logger.ts`: redact the diagnostic token header in both dot and bracket notation.
- Modify `src/lib/logger.test.ts`: enforce both new redaction paths.
- Modify `src/server.ts`: install the probe immediately before the global limiter.
- Create `src/server.middleware-order.test.ts`: enforce probe-before-global-limiter and global-limiter-before-`/api` ordering.
- Create `scripts/rate-limit-proxy-probe.sh`: guarded one-command build, no-traffic deploy, five requests, evidence capture, and teardown.
- Create `.superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/probe-results.json`: five structural Cloud Logging events only.
- Create `.superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/probe-report.md`: evidence-backed interpretation and the next design gate.

### Task 1: Create the isolated worktree and pin lineage

**Files:**
- Create: `docs/superpowers/specs/2026-08-17-cloud-run-rate-limit-header-probe-design.md`
- Create: `docs/superpowers/plans/2026-08-17-cloud-run-rate-limit-header-probe.md`
- Create: `.superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/progress.md`

**Interfaces:**
- Consumes: merged backend commit `a965f4314d7af02dc45c05733efaea322acb87eb`.
- Produces: clean branch `hotfix/rate-limit-proxy-probe` at that exact base and an append-only evidence ledger.

- [ ] **Step 1: Verify the source repository and fetch the approved base**

```bash
cd /Users/mac/shipmastr-backend-courier-audit-intake-v1
git fetch origin main
test "$(git rev-parse origin/main)" = "a965f4314d7af02dc45c05733efaea322acb87eb"
git cat-file -e a965f4314d7af02dc45c05733efaea322acb87eb^{commit}
```

Expected: every command exits `0`; `origin/main` is still the approved squash commit.

- [ ] **Step 2: Create the isolated worktree**

```bash
test ! -e /Users/mac/shipmastr-backend-rate-limit-proxy-probe
git show-ref --verify --quiet refs/heads/hotfix/rate-limit-proxy-probe && exit 1 || true
git worktree add -b hotfix/rate-limit-proxy-probe \
  /Users/mac/shipmastr-backend-rate-limit-proxy-probe \
  a965f4314d7af02dc45c05733efaea322acb87eb
cd /Users/mac/shipmastr-backend-rate-limit-proxy-probe
test "$(git rev-parse HEAD)" = "a965f4314d7af02dc45c05733efaea322acb87eb"
test "$(git branch --show-current)" = "hotfix/rate-limit-proxy-probe"
test -z "$(git status --porcelain)"
```

Expected: a clean worktree at the exact approved base.

- [ ] **Step 3: Copy the reviewed design and plan into their canonical paths**

Copy the two downloaded review artifacts without editing their contents:

```bash
mkdir -p docs/superpowers/specs docs/superpowers/plans
cp "$HOME/Downloads/2026-08-17-cloud-run-rate-limit-header-probe-design.md" \
  docs/superpowers/specs/2026-08-17-cloud-run-rate-limit-header-probe-design.md
cp "$HOME/Downloads/2026-08-17-cloud-run-rate-limit-header-probe.md" \
  docs/superpowers/plans/2026-08-17-cloud-run-rate-limit-header-probe.md
mkdir -p .superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe
```

Create `.superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/progress.md` with:

```markdown
# Cloud Run Rate-Limit Header Probe Progress

- Repository: veer-gt/shipmastr-backend
- Branch: hotfix/rate-limit-proxy-probe
- Required base: a965f4314d7af02dc45c05733efaea322acb87eb
- Production mutation: forbidden
- Active staging traffic mutation: forbidden
- Courier Audit Intake: disabled
- Status: implementation not started
```

- [ ] **Step 4: Verify the documents and commit the lineage anchor**

```bash
test "$(git merge-base HEAD a965f4314d7af02dc45c05733efaea322acb87eb)" = \
  "a965f4314d7af02dc45c05733efaea322acb87eb"
rg -n 'no external load balancer|all five controlled requests|2001:db8|a965f4314d7af02dc45c05733efaea322acb87eb' \
  docs/superpowers/specs/2026-08-17-cloud-run-rate-limit-header-probe-design.md
git diff --check
git add docs/superpowers .superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/progress.md
git commit -m "docs: plan Cloud Run rate-limit header probe"
```

Expected: the commit contains documentation and the initial ledger only.

### Task 2: Add the staging-only environment guard with TDD

**Files:**
- Modify: `src/config/env.ts`
- Create: `src/config/rate-limit-proxy-probe-env.test.ts`

**Interfaces:**
- Consumes: `APP_ENV` from the existing Zod configuration.
- Produces: `env.RATE_LIMIT_PROXY_PROBE_TOKEN?: string`, constrained to exactly 64 hexadecimal characters and forbidden outside staging.

- [ ] **Step 1: Write the failing subprocess tests**

Create `src/config/rate-limit-proxy-probe-env.test.ts`:

```typescript
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const VALID_TOKEN = "a".repeat(64);

function runEnv(overrides: Record<string, string | undefined>) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    APP_ENV: "staging",
    DATABASE_URL: "postgresql://x:x@127.0.0.1:5432/x",
    JWT_SECRET: "j".repeat(32),
    APP_SECRET_PEPPER: "p".repeat(16),
    WEBHOOK_SECRET: "w".repeat(32),
    COURIER_AUDIT_INTAKE_ENABLED: "false",
    ...overrides
  };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    "import('./dist/config/env.js').then(({env}) => console.log(JSON.stringify({configured: Boolean(env.RATE_LIMIT_PROXY_PROBE_TOKEN)})))"
  ], { env, encoding: "utf8" });
}

test("rate-limit proxy probe token is optional", () => {
  const result = runEnv({ RATE_LIMIT_PROXY_PROBE_TOKEN: undefined });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /"configured":false/);
});

test("staging accepts an exact 64-character hexadecimal probe token", () => {
  const result = runEnv({ RATE_LIMIT_PROXY_PROBE_TOKEN: VALID_TOKEN });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /"configured":true/);
});

test("production fails closed when the probe token is configured", () => {
  const result = runEnv({ APP_ENV: "production", RATE_LIMIT_PROXY_PROBE_TOKEN: VALID_TOKEN });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RATE_LIMIT_PROXY_PROBE_TOKEN_STAGING_ONLY/);
});

test("probe tokens must contain exactly 64 hexadecimal characters", () => {
  for (const token of ["a".repeat(63), "a".repeat(65), "g".repeat(64)]) {
    const result = runEnv({ RATE_LIMIT_PROXY_PROBE_TOKEN: token });
    assert.notEqual(result.status, 0);
  }
});
```

- [ ] **Step 2: Run the test and confirm RED**

```bash
npm run build
node --test dist/config/rate-limit-proxy-probe-env.test.js
```

Expected: the production fail-closed and malformed-token assertions fail because the variable is not yet parsed or guarded.

- [ ] **Step 3: Add the minimal environment implementation**

Add this field beside the other operational flags in `src/config/env.ts`:

```typescript
RATE_LIMIT_PROXY_PROBE_TOKEN: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
```

Immediately after `const parsedEnv = schema.parse(process.env);`, add:

```typescript
if (parsedEnv.RATE_LIMIT_PROXY_PROBE_TOKEN && parsedEnv.APP_ENV !== "staging") {
  throw new Error("RATE_LIMIT_PROXY_PROBE_TOKEN_STAGING_ONLY");
}
```

- [ ] **Step 4: Run the focused test and confirm GREEN**

```bash
npm run build
node --test dist/config/rate-limit-proxy-probe-env.test.js
```

Expected: 4 tests pass, 0 fail.

- [ ] **Step 5: Commit the environment guard**

```bash
git add src/config/env.ts src/config/rate-limit-proxy-probe-env.test.ts
git commit -m "test: guard staging proxy probe token"
```

### Task 3: Implement privacy-preserving structural classification with TDD

**Files:**
- Create: `src/middleware/rate-limit-proxy-probe.ts`
- Create: `src/middleware/rate-limit-proxy-probe.test.ts`

**Interfaces:**
- Consumes: Express `Request`, a configured token, and a synchronous structured-event logger.
- Produces: `createRateLimitProxyProbe(options): RequestHandler` and `buildRateLimitProxyProbeEvent(req, probeCase): RateLimitProxyProbeEvent`.

The five accepted probe-case names and markers are:

```typescript
export const rateLimitProxyProbeCases = {
  baseline: {},
  "forwarded-ipv4": { forwardedMarker: "for=192.0.2.10" },
  "xff-ipv4": { xForwardedForMarker: "198.51.100.20" },
  "both-ipv4": {
    forwardedMarker: "for=192.0.2.30",
    xForwardedForMarker: "198.51.100.40"
  },
  "both-ipv6": {
    forwardedMarker: "for=\"[2001:db8::1]\"",
    xForwardedForMarker: "2001:db8::2"
  }
} as const;
```

All positions in emitted events are one-based; `null` means absent or unmatched.

- [ ] **Step 1: Write failing pure-function and middleware tests**

Create `src/middleware/rate-limit-proxy-probe.test.ts` using `node:test` and `node:assert/strict`. Cover these exact assertions:

```typescript
test("baseline reports structure without raw address values", () => {
  const event = buildRateLimitProxyProbeEvent(fakeRequest({
    headers: {},
    ip: "10.0.0.1",
    socketAddress: "10.0.0.1"
  }), "baseline");
  assert.deepEqual(event, {
    eventName: "rate_limit_proxy_probe",
    probeCase: "baseline",
    path: "/api/health",
    forwardedPresent: false,
    forwardedParseStatus: "absent",
    forwardedElementCount: 0,
    forwardedMarkerPosition: null,
    xForwardedForPresent: false,
    xForwardedForElementCount: 0,
    xForwardedForMarkerPosition: null,
    reqIpEqualsSocket: true,
    reqIpXForwardedForPosition: null,
    socketXForwardedForPosition: null
  });
  assert.equal(JSON.stringify(event).includes("10.0.0.1"), false);
});

test("distinct IPv4 markers retain independent one-based positions", () => {
  const event = buildRateLimitProxyProbeEvent(fakeRequest({
    headers: {
      forwarded: "for=203.0.113.9, for=192.0.2.30",
      "x-forwarded-for": "203.0.113.8, 198.51.100.40"
    },
    ip: "203.0.113.8",
    socketAddress: "10.0.0.2"
  }), "both-ipv4");
  assert.equal(event.forwardedMarkerPosition, 2);
  assert.equal(event.xForwardedForMarkerPosition, 2);
  assert.equal(event.reqIpXForwardedForPosition, 1);
});

test("quoted bracketed IPv6 remains attributable", () => {
  const event = buildRateLimitProxyProbeEvent(fakeRequest({
    headers: {
      forwarded: "for=unknown;proto=https, for=\"[2001:db8::1]\"",
      "x-forwarded-for": "2001:db8::2"
    },
    ip: "::ffff:10.0.0.3",
    socketAddress: "10.0.0.3"
  }), "both-ipv6");
  assert.equal(event.forwardedParseStatus, "quoted");
  assert.equal(event.forwardedMarkerPosition, 2);
  assert.equal(event.xForwardedForMarkerPosition, 1);
  assert.equal(event.reqIpEqualsSocket, true);
});

test("malformed quoted Forwarded input is classified without throwing", () => {
  const event = buildRateLimitProxyProbeEvent(fakeRequest({
    headers: { forwarded: "for=\"[2001:db8::1]" },
    ip: "10.0.0.4",
    socketAddress: "10.0.0.4"
  }), "both-ipv6");
  assert.equal(event.forwardedParseStatus, "malformed");
  assert.equal(event.forwardedElementCount, null);
  assert.equal(event.forwardedMarkerPosition, null);
});

test("middleware logs only for an exact token and recognized case", () => {
  const events: RateLimitProxyProbeEvent[] = [];
  const middleware = createRateLimitProxyProbe({ token: "a".repeat(64), log: (event) => events.push(event) });
  invokeMiddleware(middleware, { token: undefined, probeCase: "baseline" });
  invokeMiddleware(middleware, { token: "b".repeat(64), probeCase: "baseline" });
  invokeMiddleware(middleware, { token: "a".repeat(64), probeCase: "unknown" });
  invokeMiddleware(middleware, { token: "a".repeat(64), probeCase: "baseline" });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.probeCase, "baseline");
});
```

Implement `fakeRequest` and `invokeMiddleware` inside the test using narrow type casts to `Request` and `RequestHandler`; each invocation must assert that `next()` is called exactly once and that no response method is called.

- [ ] **Step 2: Run the tests and confirm RED**

```bash
npm run build
```

Expected: TypeScript reports that `./rate-limit-proxy-probe.js` does not exist.

- [ ] **Step 3: Implement the minimal structural probe**

Create `src/middleware/rate-limit-proxy-probe.ts` with:

- the exact `rateLimitProxyProbeCases` constant above;
- a quote-aware comma splitter that returns `absent`, `simple`, `quoted`, or `malformed` and never returns raw values in an event;
- constant-time token comparison using `timingSafeEqual` after checking equal byte lengths;
- address normalization limited to trimming whitespace, removing surrounding brackets, and collapsing an IPv4-mapped `::ffff:` prefix for equality checks;
- exact marker matching after whitespace normalization;
- one-based positions;
- no logging side effect inside the pure builder;
- a middleware factory with this signature:

```typescript
export type RateLimitProxyProbeEvent = {
  eventName: "rate_limit_proxy_probe";
  probeCase: keyof typeof rateLimitProxyProbeCases;
  path: string;
  forwardedPresent: boolean;
  forwardedParseStatus: "absent" | "simple" | "quoted" | "malformed";
  forwardedElementCount: number | null;
  forwardedMarkerPosition: number | null;
  xForwardedForPresent: boolean;
  xForwardedForElementCount: number;
  xForwardedForMarkerPosition: number | null;
  reqIpEqualsSocket: boolean;
  reqIpXForwardedForPosition: number | null;
  socketXForwardedForPosition: number | null;
};

export function buildRateLimitProxyProbeEvent(
  req: Request,
  probeCase: keyof typeof rateLimitProxyProbeCases
): RateLimitProxyProbeEvent;

export function createRateLimitProxyProbe(options: {
  token?: string;
  log: (event: RateLimitProxyProbeEvent) => void;
}): RequestHandler;
```

Read the gate inputs only through `req.get("x-shipmastr-rate-limit-probe-token")` and `req.get("x-shipmastr-rate-limit-probe-case")`. If the token is absent/wrong or the case is unrecognized, call `next()` without building or logging an event.

- [ ] **Step 4: Run the focused tests and confirm GREEN**

```bash
npm run build
node --test dist/middleware/rate-limit-proxy-probe.test.js
```

Expected: 5 tests pass, 0 fail.

- [ ] **Step 5: Commit the probe classifier**

```bash
git add src/middleware/rate-limit-proxy-probe.ts src/middleware/rate-limit-proxy-probe.test.ts
git commit -m "test: add structural proxy header probe"
```

### Task 4: Wire the probe before the global limiter and protect its token

**Files:**
- Modify: `src/lib/logger.ts`
- Modify: `src/lib/logger.test.ts`
- Modify: `src/server.ts`
- Create: `src/server.middleware-order.test.ts`

**Interfaces:**
- Consumes: `env.RATE_LIMIT_PROXY_PROBE_TOKEN` and `createRateLimitProxyProbe` from Task 3.
- Produces: one Pino event named `rate limit proxy probe` before the global limiter for matching diagnostic requests only.

- [ ] **Step 1: Add failing redaction assertions**

Extend the expected paths in `src/lib/logger.test.ts` with:

```typescript
"req.headers.x-shipmastr-rate-limit-probe-token",
"req.headers['x-shipmastr-rate-limit-probe-token']"
```

Run:

```bash
npm run build
node --test dist/lib/logger.test.js
```

Expected: the new assertions fail.

- [ ] **Step 2: Add both logger redaction paths and confirm GREEN**

Add the same dot and bracket paths to `loggerRedactPaths` in `src/lib/logger.ts`, then run:

```bash
npm run build
node --test dist/lib/logger.test.js
```

Expected: logger redaction tests pass.

- [ ] **Step 3: Write the failing middleware-order test**

Create `src/server.middleware-order.test.ts`:

```typescript
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

test("proxy probe executes before the global limiter and health router", () => {
  const source = readFileSync(resolve(process.cwd(), "src/server.ts"), "utf8");
  const probe = source.indexOf("app.use(createRateLimitProxyProbe(");
  const limiter = source.indexOf("rateLimit({");
  const apiRouter = source.indexOf('app.use("/api", apiRouter)');
  assert.ok(probe >= 0, "probe middleware must be mounted");
  assert.ok(limiter > probe, "global limiter must run after the probe");
  assert.ok(apiRouter > limiter, "/api/health must remain behind the global limiter");
});
```

Run:

```bash
npm run build
node --test dist/server.middleware-order.test.js
```

Expected: FAIL because the probe is not mounted.

- [ ] **Step 4: Mount the probe before the global limiter**

Import the factory in `src/server.ts`:

```typescript
import { createRateLimitProxyProbe } from "./middleware/rate-limit-proxy-probe.js";
```

Immediately before the existing global `app.use(rateLimit(...))`, add:

```typescript
app.use(createRateLimitProxyProbe({
  token: env.RATE_LIMIT_PROXY_PROBE_TOKEN,
  log: (event) => logger.info(event, "rate limit proxy probe")
}));
```

Do not move, remove, or change the global limiter, `pinoHttp`, JSON parser, health route, or Courier Audit Intake router.

- [ ] **Step 5: Run all focused tests**

```bash
npm run build
node --test \
  dist/config/rate-limit-proxy-probe-env.test.js \
  dist/middleware/rate-limit-proxy-probe.test.js \
  dist/lib/logger.test.js \
  dist/server.middleware-order.test.js \
  dist/modules/courierAuditIntake/courier-audit-intake.routes.test.js
```

Expected: all focused tests pass; the intake route limiter test remains green and no auth ordering changes.

- [ ] **Step 6: Commit the wiring**

```bash
git add src/server.ts src/server.middleware-order.test.ts src/lib/logger.ts src/lib/logger.test.ts
git commit -m "chore: wire staging-only proxy probe"
```

### Task 5: Create the guarded one-command runner

**Files:**
- Create: `scripts/rate-limit-proxy-probe.sh`

**Interfaces:**
- Consumes: clean diagnostic branch, configured `gcloud`, and the production code/tests from Tasks 2–4.
- Produces: immutable image digest, zero-traffic tagged staging revision, five controlled requests, structural JSON evidence, and automatic teardown.

- [ ] **Step 1: Create a fail-closed Bash runner**

Create `scripts/rate-limit-proxy-probe.sh` with `#!/usr/bin/env bash` and `set -Eeuo pipefail`. It must hard-code only these non-secret constants:

```bash
PROJECT="shipmastr-core-prod"
REGION="asia-south1"
SERVICE="shipmastr-api-staging"
PRODUCTION_SERVICE="shipmastr-api"
EXPECTED_BASE="a965f4314d7af02dc45c05733efaea322acb87eb"
BRANCH="hotfix/rate-limit-proxy-probe"
IMAGE_URI="asia-south1-docker.pkg.dev/shipmastr-core-prod/shipmastr/shipmastr-api"
EVIDENCE_DIR=".superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe"
```

Implement these guards before any Cloud mutation:

```bash
test "$(git branch --show-current)" = "$BRANCH"
test "$(git merge-base HEAD "$EXPECTED_BASE")" = "$EXPECTED_BASE"
git diff --quiet
git diff --cached --quiet
test -z "$(git status --porcelain --untracked-files=normal)"
test "$(gcloud config get-value project 2>/dev/null)" = "$PROJECT"
```

Resolve and save the original staging service URL, 100%-traffic revision, active image digest, execution-environment annotation, container concurrency, and traffic JSON. Resolve production's execution environment and concurrency read-only. Run:

```bash
gcloud beta run domain-mappings list \
  --project="$PROJECT" --region="$REGION" \
  --format='table(metadata.name,spec.routeName,status.conditions[0].status)'
```

Save the output. If any production mapping has `spec.routeName=shipmastr-api`, exit before mutation unless an equivalent staging mapping for `shipmastr-api-staging` exists.

Abort unless the active staging Courier Audit Intake env value is either absent or exactly `false`. Abort if `RATE_LIMIT_PROXY_PROBE_TOKEN` already exists or any traffic tag begins with `rlp-`.

Generate runtime-only values without printing them:

```bash
PROBE_TOKEN="$(openssl rand -hex 32)"
test "${#PROBE_TOKEN}" -eq 64
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short=12 HEAD)"
TAG="rlp-$(date -u +%m%d%H%M%S)"
IMAGE_TAG="rate-limit-proxy-probe-$RUN_ID"
```

Install an `EXIT`, `INT`, and `TERM` trap. The cleanup function must:

1. remove `$TAG` with `gcloud run services update-traffic "$SERVICE" --remove-tags="$TAG"` if present;
2. read the current service-template value of `RATE_LIMIT_PROXY_PROBE_TOKEN`;
3. remove that variable with `gcloud run services update "$SERVICE" --remove-env-vars=RATE_LIMIT_PROXY_PROBE_TOKEN --no-traffic` only when it equals this run's `$PROBE_TOKEN`;
4. unset `PROBE_TOKEN`;
5. verify the original staging revision still receives 100% traffic;
6. set a nonzero final exit status if any teardown verification fails.

Never use `set -x`, `echo "$PROBE_TOKEN"`, or include the token in an output filename.

- [ ] **Step 2: Add build and immutable-image resolution**

The runner must build and resolve an immutable image from the already verified clean head:

```bash
gcloud builds submit . \
  --project="$PROJECT" \
  --region="$REGION" \
  --tag="$IMAGE_URI:$IMAGE_TAG" \
  --quiet
DIGEST="$(gcloud artifacts docker images describe "$IMAGE_URI:$IMAGE_TAG" \
  --project="$PROJECT" --format='value(image_summary.digest)')"
[[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]
IMAGE_REF="$IMAGE_URI@$DIGEST"
```

Do not rerun tests inside the cloud-action runner. Task 6 owns test verification and must finish before this script is authorized to run.

- [ ] **Step 3: Add no-traffic deployment and isolation checks**

The runner must deploy only staging:

```bash
gcloud run deploy "$SERVICE" \
  --project="$PROJECT" \
  --region="$REGION" \
  --image="$IMAGE_REF" \
  --update-env-vars="COURIER_AUDIT_INTAKE_ENABLED=false,RATE_LIMIT_PROXY_PROBE_TOKEN=$PROBE_TOKEN" \
  --no-traffic \
  --tag="$TAG" \
  --quiet
```

Resolve the tag URL and tagged revision from `gcloud run services describe "$SERVICE" --format=json` using Node's JSON parser. Abort unless:

- the tagged revision uses `$IMAGE_REF`;
- the tag exists and has a URL;
- the original revision still receives 100% traffic;
- the tagged revision receives 0% normal traffic;
- the normal staging URL returns `200` for `/api/health` and `404` for the disabled intake route;
- the tagged URL returns `200` for `/api/health` and `404` for the disabled intake route.

- [ ] **Step 4: Add five distinct probe requests**

Send these exact requests to `$TAG_URL/api/health`; each must return `200`:

```bash
curl -sS -o /dev/null -w 'baseline=%{http_code}\n' \
  -H "x-shipmastr-rate-limit-probe-token: $PROBE_TOKEN" \
  -H 'x-shipmastr-rate-limit-probe-case: baseline' \
  "$TAG_URL/api/health"

curl -sS -o /dev/null -w 'forwarded_ipv4=%{http_code}\n' \
  -H "x-shipmastr-rate-limit-probe-token: $PROBE_TOKEN" \
  -H 'x-shipmastr-rate-limit-probe-case: forwarded-ipv4' \
  -H 'Forwarded: for=192.0.2.10' \
  "$TAG_URL/api/health"

curl -sS -o /dev/null -w 'xff_ipv4=%{http_code}\n' \
  -H "x-shipmastr-rate-limit-probe-token: $PROBE_TOKEN" \
  -H 'x-shipmastr-rate-limit-probe-case: xff-ipv4' \
  -H 'X-Forwarded-For: 198.51.100.20' \
  "$TAG_URL/api/health"

curl -sS -o /dev/null -w 'both_ipv4=%{http_code}\n' \
  -H "x-shipmastr-rate-limit-probe-token: $PROBE_TOKEN" \
  -H 'x-shipmastr-rate-limit-probe-case: both-ipv4' \
  -H 'Forwarded: for=192.0.2.30' \
  -H 'X-Forwarded-For: 198.51.100.40' \
  "$TAG_URL/api/health"

curl -sS -o /dev/null -w 'both_ipv6=%{http_code}\n' \
  -H "x-shipmastr-rate-limit-probe-token: $PROBE_TOKEN" \
  -H 'x-shipmastr-rate-limit-probe-case: both-ipv6' \
  -H 'Forwarded: for="[2001:db8::1]"' \
  -H 'X-Forwarded-For: 2001:db8::2' \
  "$TAG_URL/api/health"
```

- [ ] **Step 5: Add evidence capture and privacy checks**

Read only the tagged revision's application events:

```bash
gcloud logging read \
  "resource.type=\"cloud_run_revision\" AND resource.labels.revision_name=\"$TAG_REVISION\" AND jsonPayload.eventName=\"rate_limit_proxy_probe\"" \
  --project="$PROJECT" \
  --freshness=30m \
  --order=asc \
  --limit=20 \
  --format=json > "$EVIDENCE_DIR/probe-results.json"
```

Use `node --input-type=module -e` to parse the file and fail unless:

- it contains exactly five entries;
- the ordered `probeCase` values are `baseline`, `forwarded-ipv4`, `xff-ipv4`, `both-ipv4`, `both-ipv6`;
- every event has exactly the approved structural keys from `RateLimitProxyProbeEvent` plus ordinary Cloud Logging envelope fields;
- no serialized event contains the probe token, `192.0.2.`, `198.51.100.`, `2001:db8`, `for=`, or a raw forwarding-header value.

The script must finish by running its cleanup function and printing only:

```text
PROBE_COMPLETE
evidence=.superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/probe-results.json
active_staging_revision_unchanged=true
production_mutated=false
feature_enabled=false
```

- [ ] **Step 6: Syntax-check and commit the runner**

```bash
bash -n scripts/rate-limit-proxy-probe.sh
git diff --check
git add scripts/rate-limit-proxy-probe.sh
git commit -m "chore: automate isolated Cloud Run header probe"
```

### Task 6: Verify the complete diagnostic branch before any cloud action

**Files:**
- Modify: `.superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/progress.md`

**Interfaces:**
- Consumes: all diagnostic commits.
- Produces: reviewed, pushed diagnostic branch with an exact tested head.

- [ ] **Step 1: Run formatting, build, focused tests, and the full synthetic suite**

```bash
git diff --check
npm ci
FULL_REPORT="/tmp/shipmastr-rate-limit-proxy-probe-full-suite-$(date -u +%Y%m%dT%H%M%SZ).log"
set -o pipefail
env \
  NODE_ENV=test \
  APP_ENV=test \
  DATABASE_URL='postgresql://synthetic:synthetic@127.0.0.1:1/shipmastr_synthetic' \
  JWT_SECRET='synthetic-test-only-jwt-secret-000000000000000000000000000001' \
  APP_SECRET_PEPPER='synthetic-test-only-app-pepper-0000000000000000000000000001' \
  WEBHOOK_SECRET='synthetic-test-only-webhook-secret-00000000000000000000000001' \
  npm test 2>&1 | tee "$FULL_REPORT"
FULL_STATUS=$?
set +o pipefail
echo "full_suite_exit=$FULL_STATUS"
echo "full_suite_report=$FULL_REPORT"
grep -n -E '^ℹ tests |^ℹ suites |^ℹ pass |^ℹ fail |^ℹ skipped ' "$FULL_REPORT"
```

Expected: all new focused tests pass. Exit `0` is accepted. A nonzero exit is accepted only when exactly two failures and three skips are reported and both failure names plus error signatures are byte-for-byte equivalent to the missing-sibling-fixture failures recorded in `/Users/mac/shipmastr-backend-courier-audit-intake-v1/.superpowers/sdd/2026-08-07-courier-audit-intake-v1-backend/task-12-report.md`. Compare the current failure blocks against that file and record the comparison in `progress.md`; any missing baseline report, changed signature, or additional failure blocks deployment.

- [ ] **Step 2: Audit the diagnostic boundary**

```bash
rg -n 'RATE_LIMIT_PROXY_PROBE_TOKEN|x-shipmastr-rate-limit-probe' src scripts
! rg -n 'console\.(log|error)|req\.headers\b|rawHeaders|authorization|cookie|x-shipmastr-intake-signature' \
  src/middleware/rate-limit-proxy-probe.ts
rg -n 'COURIER_AUDIT_INTAKE_ENABLED=false|--no-traffic|--tag|production_mutated=false' \
  scripts/rate-limit-proxy-probe.sh
git diff a965f4314d7af02dc45c05733efaea322acb87eb...HEAD -- \
  prisma src/modules/courierAuditIntake/courier-audit-intake.service.ts
```

Expected: no Prisma/service diff; no direct header-object or sensitive-header logging; deployment is staging-only and no-traffic.

- [ ] **Step 3: Obtain an independent review**

Reviewer must verify:

- exact base and diff scope;
- probe is before the global limiter;
- `/api/health` remains behind the limiter;
- token gate is constant-time and staging-only;
- no event includes raw values;
- IPv4 and RFC 3849 IPv6 cases are distinct;
- cleanup is safe under success, command failure, `INT`, and `TERM`;
- no production command mutates state;
- feature remains disabled;
- no diagnostic code is intended for merge.

Critical or Important findings block deployment. Resolve findings with RED→GREEN tests and repeat review.

- [ ] **Step 4: Record the tested head and push the branch**

Append the test result, review verdict, and exact head to `progress.md`, then:

```bash
git add .superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/progress.md
git commit -m "docs: record proxy probe verification"
TESTED_HEAD="$(git rev-parse HEAD)"
test -n "$TESTED_HEAD"
git push --set-upstream origin hotfix/rate-limit-proxy-probe
git ls-remote --heads origin refs/heads/hotfix/rate-limit-proxy-probe
```

Do not open a mergeable PR.

### Task 7: Execute the isolated staging probe

**Files:**
- Create: `.superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/probe-results.json`
- Modify: `.superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/progress.md`

**Interfaces:**
- Consumes: independently reviewed tested head and configured GCP operator identity.
- Produces: five privacy-preserving structural events and verified teardown.

- [ ] **Step 1: Run the one-command probe with an immutable terminal log**

```bash
cd /Users/mac/shipmastr-backend-rate-limit-proxy-probe
REPORT="/tmp/shipmastr-rate-limit-proxy-probe-$(date -u +%Y%m%dT%H%M%SZ).log"
set -o pipefail
bash scripts/rate-limit-proxy-probe.sh 2>&1 | tee "$REPORT"
STATUS=$?
echo "probe_exit=$STATUS"
echo "report=$REPORT"
test "$STATUS" -eq 0
```

Expected: `PROBE_COMPLETE`, five HTTP `200` results, teardown success, unchanged active staging revision, no production mutation, and feature disabled.

- [ ] **Step 2: Independently verify teardown and containment**

```bash
PROJECT="shipmastr-core-prod"
REGION="asia-south1"
SERVICE="shipmastr-api-staging"
gcloud run services describe "$SERVICE" \
  --project="$PROJECT" --region="$REGION" \
  --format='yaml(status.latestReadyRevisionName,status.traffic,spec.template.spec.containers[0].env)'
```

Verify all of the following from the output:

- exactly one revision receives 100% normal traffic and it is the pre-probe active revision;
- no tag begins with `rlp-`;
- `RATE_LIMIT_PROXY_PROBE_TOKEN` is absent;
- `COURIER_AUDIT_INTAKE_ENABLED` is absent or `false`.

Then POST an empty JSON object to the normal staging intake route and require HTTP `404`.

- [ ] **Step 3: Record immutable deployment evidence**

Append to `progress.md`:

- tested commit SHA;
- Artifact Registry image digest;
- tagged diagnostic revision name;
- original active staging revision;
- staging and production execution-environment generation;
- staging and production concurrency;
- Cloud Run domain-mapping inventory result;
- five HTTP results;
- evidence-file SHA-256;
- teardown verification;
- statement that production was read-only and the feature stayed disabled.

Commit and push evidence:

```bash
shasum -a 256 .superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/probe-results.json
git add .superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe
git commit -m "docs: record Cloud Run proxy probe evidence"
git push
```

### Task 8: Interpret results and stop at the hotfix design gate

**Files:**
- Create: `.superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/probe-report.md`

**Interfaces:**
- Consumes: exactly five structural events plus environment-parity evidence.
- Produces: one evidence-backed header-trust classification; no code fix.

- [ ] **Step 1: Classify `Forwarded`**

Use these rules verbatim:

- Baseline absent plus preserved spoof marker means caller-controlled: ignore for keying.
- Stable trusted suffix plus preserved prefix means only the measured suffix may be considered.
- Consistent overwrite means record the observation but require repeatability across IPv4 and IPv6 before considering trust.
- Inconsistent behavior means ignore for keying.

- [ ] **Step 2: Classify `X-Forwarded-For`**

Use these rules verbatim:

- Spoof marker absent means Cloud Run overwrote caller input; identify the resulting caller position structurally.
- Spoof marker retained with stable trailing elements means supplied prefixes are untrusted and only the fixed measured trailing position may be used.
- No stable suffix means XFF cannot safely provide the rate-limit key.
- `TRUSTED_PROXY_HOPS` may change only if one fixed path and hop count are proven.

- [ ] **Step 3: Classify the current limiter**

If all events report `reqIpEqualsSocket=true` and that value never matches the measured internet-caller XFF position, report that the current limiter is proxy-keyed and susceptible to shared buckets.

- [ ] **Step 4: Write and independently review the report**

`probe-report.md` must contain:

- exact tested head, image digest, revision, and evidence SHA-256;
- one row per probe case with structural fields only;
- `Forwarded` classification;
- `X-Forwarded-For` classification;
- current limiter classification;
- staging/production parity result;
- teardown proof;
- one recommended hotfix approach and rejected alternatives;
- explicit statement that no fix was implemented and the feature remains disabled.

Obtain independent review with Critical/Important/Minor findings. Any ambiguity keeps the feature disabled and triggers another narrowly designed probe rather than a guessed fix.

- [ ] **Step 5: Commit the report and stop**

```bash
git add .superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/probe-report.md
git commit -m "docs: classify Cloud Run proxy trust boundary"
git push
```

Stop. Do not create the final hotfix PR, deploy a corrected limiter, or enable Courier Audit Intake until the report and next hotfix design are explicitly approved.

## Self-Review Result

- Spec coverage: all fixed constraints, five probes, IPv6 syntax, domain mapping, execution-generation/concurrency parity, privacy, no-traffic isolation, teardown, and stop gate are mapped to tasks.
- Placeholder scan: no placeholder marker, deferred implementation phrase, or unspecified error-handling instruction remains.
- Type consistency: `RateLimitProxyProbeEvent`, `rateLimitProxyProbeCases`, `buildRateLimitProxyProbeEvent`, and `createRateLimitProxyProbe` names and fields are identical across Tasks 3–5.
- Scope: diagnostic instrumentation and evidence only; the production rate-limit correction is intentionally a separate post-evidence design.
