# Cloud Run Probe Tag-Budget Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the diagnostic Cloud Run traffic tags fit the observed `shipmastr-api-staging` target budget without weakening cleanup ownership checks or changing application behavior.

**Architecture:** Keep the full timestamp/SHA/nonce `RUN_ID` for image and artifact identity, but derive a compact 18-hex Cloud Run tag identity. Pass the actual service name into `create_run_identity` and reject any generated tag whose length plus that service name exceeds the target-specific observed ceiling of 46.

**Tech Stack:** macOS Bash 3.2, Node.js built-in test runner, Cloud Run diagnostic runner, Git.

## Global Constraints

- Work only on `hotfix/rate-limit-proxy-probe`; never merge this diagnostic branch to `main`.
- Required merge base remains `a965f4314d7af02dc45c05733efaea322acb87eb`.
- The observed `46` ceiling comes from the literal failed `gcloud run deploy` response for `shipmastr-api-staging`; do not describe it as a portable Cloud Run constant.
- Preserve the full `RUN_ID` and full source/tested heads in image/artifact/context identity.
- Preserve exact tag-to-revision-to-digest-to-generation-to-concurrency ownership validation.
- Preserve macOS Bash 3.2 compatibility: no `mapfile`, `readarray`, associative arrays, namerefs, or Bash 4 syntax.
- No limiter, logger, evidence schema, Prisma, Courier Audit Intake, production service, feature flag, traffic, migration, secret, n8n, Gmail, notification, or outbound-communication change.
- No cloud retry, push, deployment, feature enablement, production mutation, PR, or merge until a new exact head passes verification/review and the user separately approves that SHA.

---

### Task 1: Compact and bound the run-owned traffic tags

**Files:**
- Modify: `scripts/rate-limit-proxy-probe.test.mjs`
- Modify: `scripts/rate-limit-proxy-probe.sh:179-190, 293-320, 619-626`

**Interfaces:**
- Consumes: full `timestamp` (`14` decimal digits), `commit_prefix` (`12` lowercase hex), `nonce` (`12` lowercase hex), and the real service name.
- Produces: unchanged full `RUN_ID`; `TAG_G1` and `TAG_G2` matching `^rlp-[0-9a-f]{18}-g[12]$`, distinct by generation, and satisfying `service_name.length + tag.length <= 46`.

- [ ] **Step 1: Add the real-function failing boundary test**

Add this helper and test near the existing timestamp test in `scripts/rate-limit-proxy-probe.test.mjs`:

```js
function extractedRunIdentityFunction(source) {
  const start = source.indexOf("create_run_identity() {");
  const end = source.indexOf("\n\nacquire_operator_lock()", start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

test("run-owned tags fit the observed staging service budget", () => {
  const source = readFileSync(runnerPath, "utf8");
  const service = source.match(/^SERVICE="([^"]+)"$/mu)?.[1];
  assert.equal(service, "shipmastr-api-staging");
  const script = `${extractedRunIdentityFunction(source)}
create_run_identity 20260818051610 13123c4ebf2a 5004c74d6a49 ${JSON.stringify(service)}
printf '%s\\n%s\\n%s\\n' "$RUN_ID" "$TAG_G1" "$TAG_G2"
`;
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const [runId, tagG1, tagG2] = result.stdout.trim().split("\n");
  assert.equal(runId, "20260818051610-13123c4ebf2a-5004c74d6a49");
  assert.equal(tagG1, "rlp-18051613125004c74d-g1");
  assert.equal(tagG2, "rlp-18051613125004c74d-g2");
  assert.match(tagG1, /^rlp-[0-9a-f]{18}-g1$/u);
  assert.match(tagG2, /^rlp-[0-9a-f]{18}-g2$/u);
  assert.notEqual(tagG1, tagG2);
  assert.equal(service.length + tagG1.length <= 46, true);
  assert.equal(service.length + tagG2.length <= 46, true);
});
```

The expected compact component is `180516` (last six timestamp digits) + `1312` (first four source-SHA digits) + `5004c74d` (first eight nonce digits).

- [ ] **Step 2: Run the test and confirm genuine RED**

Run:

```bash
node --test --test-name-pattern='run-owned tags fit the observed staging service budget' \
  scripts/rate-limit-proxy-probe.test.mjs
```

Expected: exit 1. The real current function either rejects the required fourth argument or returns the existing 47-character tag, so the exact compact tag and combined-budget assertions fail. Do not edit `scripts/rate-limit-proxy-probe.sh` before recording this output.

- [ ] **Step 3: Implement the minimum Bash 3.2-safe correction**

Replace `create_run_identity` with:

```bash
create_run_identity() {
  local timestamp="$1"
  local commit_prefix="$2"
  local nonce="$3"
  local service_name="$4"
  local compact_identity=""
  [[ "$timestamp" =~ ^[0-9]{14}$ ]]
  [[ "$commit_prefix" =~ ^[0-9a-f]{12}$ ]]
  [[ "$nonce" =~ ^[0-9a-f]{12}$ ]]
  test -n "$service_name"
  RUN_ID="$timestamp-$commit_prefix-$nonce"
  compact_identity="${timestamp:8:6}${commit_prefix:0:4}${nonce:0:8}"
  TAG_G1="rlp-$compact_identity-g1"
  TAG_G2="rlp-$compact_identity-g2"
  [[ "$RUN_ID" =~ ^[0-9]{14}-[0-9a-f]{12}-[0-9a-f]{12}$ ]]
  [[ "$TAG_G1" =~ ^rlp-[0-9a-f]{18}-g1$ ]]
  [[ "$TAG_G2" =~ ^rlp-[0-9a-f]{18}-g2$ ]]
  test "$(( ${#service_name} + ${#TAG_G1} ))" -le 46
  test "$(( ${#service_name} + ${#TAG_G2} ))" -le 46
  test "$TAG_G1" != "$TAG_G2"
}
```

In `bash32_self_test`, pass the literal staging service as the fourth argument:

```bash
create_run_identity \
  "$(date -u +%Y%m%d%H%M%S)" \
  "$(git rev-parse --short=12 HEAD)" \
  "001122334455" \
  "shipmastr-api-staging"
test "$(( ${#TAG_G1} + ${#TAG_G2} ))" -eq 50
```

In normal execution, pass the already-defined service constant:

```bash
create_run_identity \
  "$RUN_TIMESTAMP" \
  "$(git rev-parse --short=12 HEAD)" \
  "$RUN_NONCE" \
  "$SERVICE"
```

Do not shorten `RUN_ID`, `SOURCE_HEAD`, `TESTED_HEAD`, the image digest, or any context field.

- [ ] **Step 4: Run focused GREEN verification**

Run:

```bash
bash -n scripts/rate-limit-proxy-probe.sh
/bin/bash scripts/rate-limit-proxy-probe.sh --bash32-self-test
node --test --test-name-pattern='run-owned tags|lowercase-safe numeric UTC timestamp|actual runner self-test|ownership|cleanup' \
  scripts/rate-limit-proxy-probe.test.mjs
```

Expected: Bash syntax exit 0; self-test prints exactly `RATE_LIMIT_PROXY_PROBE_BASH32_SELF_TEST_OK`; every selected test passes with no failures.

- [ ] **Step 5: Run the complete diagnostic test gate**

Run:

```bash
node --test \
  scripts/rate-limit-proxy-probe-evidence-schema.test.mjs \
  scripts/rate-limit-proxy-probe-evidence.test.mjs \
  scripts/rate-limit-proxy-probe.test.mjs
git diff --check
```

Expected: all diagnostic tests pass; `git diff --check` has no output. Verify the source diff is limited to the runner and its test.

- [ ] **Step 6: Commit the behavior correction**

```bash
git add scripts/rate-limit-proxy-probe.sh scripts/rate-limit-proxy-probe.test.mjs
git diff --cached --check
git commit -m "fix: fit probe tags within Cloud Run budget"
```

Expected: one focused two-file implementation commit.

### Task 2: Exact-head verification, review, and retry gate

**Files:**
- Create locally/ignored: `.superpowers/sdd/2026-08-18-cloud-run-probe-tag-budget-fix/final-report.md`
- Create locally/ignored: `.superpowers/sdd/2026-08-18-cloud-run-probe-tag-budget-fix/progress.md`

**Interfaces:**
- Consumes: Task 1 commit and the approved design/plan commits.
- Produces: exact tested head, verification/review verdict, read-only residue command, and explicit approval string; it performs no push or cloud action.

- [ ] **Step 1: Re-run the exact-head focused package gate**

Run:

```bash
npm run build
bash -n scripts/rate-limit-proxy-probe.sh
/bin/bash scripts/rate-limit-proxy-probe.sh --bash32-self-test
node --test \
  scripts/rate-limit-proxy-probe-evidence-schema.test.mjs \
  scripts/rate-limit-proxy-probe-evidence.test.mjs \
  scripts/rate-limit-proxy-probe.test.mjs \
  dist/config/rate-limit-proxy-probe-env.test.js \
  dist/lib/logger.test.js \
  dist/middleware/rate-limit-proxy-probe.test.js \
  dist/modules/courierAuditIntake/courier-audit-intake.routes.test.js \
  dist/server.middleware-order.test.js
```

Expected: build/syntax/self-test exit 0 and all focused tests pass. Record exact totals. Restore only generated tracked `dist/` and `node_modules/` paths after verifying no other path changed.

- [ ] **Step 2: Run the synthetic full suite and apply the reconciled baseline**

Run with the established synthetic values:

```bash
env \
  NODE_ENV=test \
  APP_ENV=test \
  DATABASE_URL='postgresql://synthetic:synthetic@127.0.0.1:1/shipmastr_synthetic' \
  JWT_SECRET='synthetic-test-only-jwt-secret-000000000000000000000000000001' \
  APP_SECRET_PEPPER='synthetic-test-only-app-pepper-0000000000000000000000000001' \
  WEBHOOK_SECRET='synthetic-test-only-webhook-secret-00000000000000000000000001' \
  npm test
```

Expected accepted result: 2,125 tests; 2,120 passed; exactly the two established missing-sibling ENOENT failures; 3 established skips. Any other count, name, path, failure class, or skip blocks retry approval. Restore only generated tracked outputs afterward.

- [ ] **Step 3: Perform containment and exact-head review**

Verify:

```bash
git diff --check
git diff a965f4314d7af02dc45c05733efaea322acb87eb...HEAD -- \
  prisma src/modules/courierAuditIntake
! rg -n 'ERR_ERL_FORWARDED_HEADER|forwardedHeader:\s*false' src scripts
! rg -n 'gcloud run (deploy|services update|services update-traffic).*shipmastr-api(?:[[:space:]]|$)' \
  scripts/rate-limit-proxy-probe.sh
```

Expected: no Prisma/Courier Audit Intake implementation diff from this fix, no warning suppression, no production mutation command, and a clean worktree after generated restoration. Review the design/plan and `badf96f..HEAD` diff; classify Critical/Important/Minor. Any Critical or Important finding requires a new RED→GREEN cycle and review.

- [ ] **Step 4: Prepare the read-only Mac residue gate**

Before a second probe, the operator must run read-only staging inspection and confirm:

```bash
gcloud run services describe shipmastr-api-staging \
  --project=shipmastr-core-prod \
  --region=asia-south1 \
  --format=export
```

Interpret without printing secret values in the report: no `rlp-` traffic tag, no `RATE_LIMIT_PROXY_PROBE_TOKEN`, one ordinary revision at 100% traffic, and Courier Audit Intake absent or `false`. The failed attempt created no revision, but retry remains blocked until this live-state check is supplied.

- [ ] **Step 5: Record the stop gate and request exact-head approval**

Write the exact commands, totals, RED/GREEN evidence, review verdict, and the failed-attempt build ID/image digest to the ignored local report/ledger. Then print:

```bash
TESTED_HEAD="$(git rev-parse HEAD)"
printf 'APPROVE PUSH AND STAGING-ONLY PROBE RETRY at %s\n' "$TESTED_HEAD"
```

Stop. Do not push or retry the cloud probe until the user approves that exact SHA.
