# Cloud Run rate-limit header probe final fix report

Date: 2026-08-17
Starting head: `dce7e2b29156acc0437194937920d72393dfecff`
Final intentional commit: `c13fad47ad030da4f2b8320de31e9d7623d4aeaa`
Status: DONE_WITH_CONCERNS

## Scope and safety

This was the single final-review fix wave. No runner command was sourced or executed. No `gcloud`, Cloud Build, deploy, logging query, `curl`, `openssl`, GitHub, push, or other cloud action was executed. Production was not accessed or mutated. Active staging traffic was not accessed or mutated. No final rate-limit strategy was implemented, no warning was suppressed, and `src/server.ts` and Courier Audit Intake code were unchanged.

The dependency setup required by the brief completed with:

```text
npm ci --cache /tmp/shipmastr-rate-limit-proxy-probe-npm-cache
exit 0
```

It emitted only the existing npm proxy/deprecation notices. The Linux install/build changed tracked generated files; they were deliberately excluded from the commit and are listed under Concerns.

## Finding 1 — ordinary Pino request logs

### Root cause

`pino-http` serializes the full lower-case request-header object and derives its serialized `req.remoteAddress` from the request socket. The shared Pino configuration redacted the diagnostic token header but did not redact either forwarding header or any request-address representation. Therefore a successful controlled probe request could emit raw controlled inputs in an ordinary request-completion record even though the separate diagnostic evidence projection was structural.

### RED

Test added first: `removes controlled probe inputs from emitted request-completion JSON` in `src/lib/logger.test.ts`.

The test starts a subprocess using the real exported logger, passes a representative request through actual `pinoHttp({ logger })` auto-logging, captures the emitted JSON line, parses it, and checks the serialized output. It includes all controlled Forwarded/XFF marker classes plus distinct request and socket address sentinels, but this report intentionally does not reproduce those raw values.

```text
$ npm run build && node --test dist/lib/logger.test.js
exit 1
tests 2
pass 1
fail 1

FAIL removes controlled probe inputs from emitted request-completion JSON
AssertionError: controlled forwarding marker leaked in emitted request-completion JSON
```

The captured emitted line also contained the raw forwarding-header values and serialized remote address. The diagnostic token was already censored, confirming the regression exercised the actual existing redaction path rather than a synthetic array check.

### GREEN

The shared Pino redaction configuration now covers both dot and bracket paths for `Forwarded` and `X-Forwarded-For`, retains both existing probe-token paths, and censors `req.ip`, `req.ips`, serialized `req.remoteAddress`, and socket/connection/client remote-address aliases. Method, URL, response, timing, and non-sensitive header structure remain available.

```text
$ ./node_modules/.bin/tsc && node --test dist/lib/logger.test.js
exit 0
tests 2
pass 2
fail 0
```

The emitted JSON assertions verify the token, all controlled forwarding markers/values, request-IP sentinel, and socket/serialized-remote-address sentinel are absent, while each sensitive serialized field is exactly `[redacted]` where Pino retains it.

## Finding 2 — Bash 3.2 compatibility

All four `mapfile` process-substitution readers were replaced with command substitution plus indexed-array population through `while IFS= read -r`, syntax available in macOS Bash 3.2. The producer command's failure remains fail-closed under `set -e`; exact array-size checks still reject missing or extra fields.

The local static regression test reads the runner and rejects either `mapfile` or `readarray`.

```text
$ bash -n scripts/rate-limit-proxy-probe.sh
exit 0

$ ! rg -n '\b(mapfile|readarray)\b' scripts/rate-limit-proxy-probe.sh
exit 0

$ git diff --check -- scripts/rate-limit-proxy-probe.sh \
    scripts/rate-limit-proxy-probe-parsers.mjs \
    scripts/rate-limit-proxy-probe.test.mjs
exit 0
```

No Homebrew or newer Bash is required.

## Finding 3 — teardown tag ownership

Tag names now contain timestamp, source-head, and independent non-secret random nonce components. The probe secret is not part of the tag.

The extracted local parser has two fail-closed phases:

1. `tag-state` requires an unambiguous matching traffic entry and a non-empty revision name.
2. `owned-tag` requires that entry to target this run's recorded tagged revision, requires the described revision name to match, requires exactly one container, and requires its image to equal this run's immutable digest reference.

Cleanup removes the tag only after both phases succeed. A foreign, missing, ambiguous, or unverifiable target/image is left untouched and marks teardown failed. Probe-token removal retains the prior exact-value ownership check. The cleanup return logic still preserves the original nonzero, INT 130, or TERM 143 status; a teardown failure turns an otherwise successful status into nonzero.

### Fixture RED

Before the parser and Bash replacement existed:

```text
$ node --test scripts/rate-limit-proxy-probe.test.mjs
exit 1
tests 5
pass 3
fail 2

FAIL runner remains compatible with macOS Bash 3.2 array parsing
FAIL owned tag and immutable image pass cleanup ownership validation
```

### Fixture GREEN

```text
$ node --test scripts/rate-limit-proxy-probe.test.mjs
exit 0
tests 5
pass 5
fail 0
```

The five local cases cover:

- no `mapfile`/`readarray` dependency;
- owned tag plus immutable image succeeds;
- foreign revision target is rejected;
- missing and duplicate/ambiguous tag revisions are rejected;
- missing container image, zero/multiple containers, and missing expected image are rejected.

These tests invoke only the extracted Node parser with synthetic JSON fixtures. They do not source or execute the runner and do not invoke cloud commands.

## Finding 4 — topology/runtime parity and probe context

All new topology guards occur before probe-token generation, image build, or deployment:

- production runtime is resolved from its sole 100%-traffic revision, not merely `latestReadyRevisionName`;
- staging and production execution-environment annotations must both be present and equal;
- staging and production container-concurrency values must both be present and equal;
- any Cloud Run domain mapping whose route is the production service makes the runner exit nonzero; equivalent staging mapping no longer permits the run;
- the tagged diagnostic revision must retain the already-validated execution environment and concurrency.

The runner drafts `probe-context.json` to a per-run temporary file after the diagnostic image/revision are known. It contains only:

- project, region, staging service, and production-service names;
- source/tested heads;
- original staging revision;
- diagnostic image digest and tagged revision;
- staging/production/tagged runtime equality fields;
- production domain-mapping count `0`;
- active traffic unchanged `true`;
- feature disabled `true`;
- production mutated `false`.

The context generator rejects URL material and sensitive key categories. It receives no URL, address, header, token, credential, secret reference, environment list, or body input. Cleanup deletes the temporary context on every error/nonzero path. Only after owned tag removal, owned token removal, unchanged 100%-traffic verification, absent tag/token verification, and disabled-feature verification does cleanup atomically rename the context into place. The final context is parsed and its critical flags revalidated before the unchanged five completion lines are printed.

## Focused verification

Fresh final command:

```text
$ ./node_modules/.bin/tsc && node --test \
    dist/config/rate-limit-proxy-probe-env.test.js \
    dist/middleware/rate-limit-proxy-probe.test.js \
    dist/lib/logger.test.js \
    dist/server.middleware-order.test.js \
    dist/modules/courierAuditIntake/courier-audit-intake.routes.test.js \
    scripts/rate-limit-proxy-probe.test.mjs

exit 0
tests 31
suites 1
pass 31
fail 0
cancelled 0
skipped 0
todo 0
```

Coverage by area: environment guard 4; structural middleware 6; emitted logger/redaction 2; Courier Audit Intake route and limiter 13; middleware order 1; runner/parser 5.

Fresh shell/static verification:

```text
bash -n: PASS
mapfile/readarray static guard: PASS
ownership fixtures: 5/5 PASS
script-only diff check: PASS
no src/server.ts diff: PASS
no Prisma or Courier Audit Intake service diff: PASS
no ERR_ERL_FORWARDED_HEADER suppression: PASS
five completion lines unchanged: PASS
```

The full suite was intentionally not run, per the final-fix brief.

## Intentional files and commit

Commit `c13fad47ad030da4f2b8320de31e9d7623d4aeaa` (`fix: harden rate-limit proxy probe diagnostics`) contains only:

- `src/lib/logger.ts`
- `src/lib/logger.test.ts`
- `scripts/rate-limit-proxy-probe.sh`
- `scripts/rate-limit-proxy-probe-parsers.mjs`
- `scripts/rate-limit-proxy-probe.test.mjs`

No plan, progress ledger, task report, generated file, evidence result, or application middleware-order file was committed.

## Concerns

- The requested Linux `npm ci`/TypeScript compilation changed 724 tracked generated paths: 26 under `dist/` and 698 under `node_modules/`. They are unstaged and excluded from the intentional commit. The controller must restore the clean tracked Mac state as planned.
- Bash 3.2 compatibility is established by using only compatible constructs plus `bash -n` and the static no-`mapfile` regression. The container does not provide an actual Bash 3.2 binary, so no dynamic Bash-3.2 interpreter run was possible or attempted.
- Cloud behavior remains deliberately unexecuted. The local fixtures validate parser decisions and static guard placement; the controller's scoped review must still approve the runner before any separately authorized staging probe.

## Human-authorized second final-fix round

### Scope and finding

The human authorized one narrow follow-up for the residual runtime-parity finding. The runner previously read execution environment and concurrency from the staging service template, then overwrote those shell variables with values from the active staging revision. Its pre-mutation comparison therefore covered only active staging versus active production. A divergent service template—which the next deployment inherits—would not be rejected until the post-deployment tagged-revision check.

No code outside the runner, its extracted parser/helper test, and this report was changed.

### TDD RED

The real parser behavior test `runtime parity requires the staging template and both active revisions to match` was added before implementation. It exercises a matching three-way fixture and divergent template execution-environment/concurrency fixtures through the actual parser process.

```text
$ node --test scripts/rate-limit-proxy-probe.test.mjs
exit 1
tests 6
pass 5
fail 1

FAIL runtime parity requires the staging template and both active revisions to match
AssertionError: 64 !== 0
```

Exit 64 was the parser's unknown-command result, proving no three-way runtime-parity behavior existed.

### Minimum implementation

- `STAGING_TEMPLATE_EXECUTION_ENVIRONMENT` and `STAGING_TEMPLATE_CONTAINER_CONCURRENCY` retain the service-template values.
- `STAGING_ACTIVE_EXECUTION_ENVIRONMENT` and `STAGING_ACTIVE_CONTAINER_CONCURRENCY` retain the original 100%-traffic staging revision values.
- `PRODUCTION_ACTIVE_EXECUTION_ENVIRONMENT` and `PRODUCTION_ACTIVE_CONTAINER_CONCURRENCY` retain the 100%-traffic production revision values.
- The extracted `runtime-parity` parser command fails on missing values, the explicit absent sentinel, malformed concurrency, or any three-way mismatch.
- The runner requires the parser result `equal` before domain-mapping completion, probe-token generation, image build, or deployment.
- The post-deployment tagged-revision check uses the validated staging-template values because those are the values the deployment inherits.
- The structural context keeps template, active staging, active production, and tagged runtime fields distinct and asserts their equality.

### GREEN and static verification

```text
$ bash -n scripts/rate-limit-proxy-probe.sh
exit 0

$ node --test scripts/rate-limit-proxy-probe.test.mjs
exit 0
tests 6
pass 6
fail 0
skipped 0

$ ! rg -n '\b(mapfile|readarray)\b' scripts/rate-limit-proxy-probe.sh
exit 0

$ git diff --check -- scripts/rate-limit-proxy-probe.sh \
    scripts/rate-limit-proxy-probe-parsers.mjs \
    scripts/rate-limit-proxy-probe.test.mjs \
    .superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/final-fix-report.md
exit 0
```

A local source-order check also confirmed the `runtime-parity` parser invocation precedes `PROBE_TOKEN`, `gcloud builds submit`, and `gcloud run deploy`.

### Self-review

- Template fields are assigned once and are never overwritten by active-revision parsing.
- Active staging and active production values remain distinct through validation and context creation.
- All six values are required and compared before any mutation-capable command.
- Production operations remain read-only describes/listing; mutation commands still target staging only.
- No traffic behavior, deployment flags, cleanup ownership, token cleanup, completion output, logger redaction, evidence privacy, feature flag, or rate-limit behavior changed.
- Bash 3.2-compatible array parsing remains intact; no `mapfile` or `readarray` was introduced.

### Changed files

- `scripts/rate-limit-proxy-probe.sh`
- `scripts/rate-limit-proxy-probe-parsers.mjs`
- `scripts/rate-limit-proxy-probe.test.mjs`
- `.superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/final-fix-report.md`

No runner, `gcloud`, Cloud Build, deploy, logging, `curl`, `openssl`, GitHub, push, cloud, or network command was executed in this round.
