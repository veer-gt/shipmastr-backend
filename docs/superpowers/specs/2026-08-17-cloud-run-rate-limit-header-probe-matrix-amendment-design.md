# Cloud Run Rate-Limit Header Probe Matrix Amendment Design

## Status and scope

This document amends `2026-08-17-cloud-run-rate-limit-header-probe-design.md` only where the live preflight proved that runtime parity cannot be established from configuration alone. All original privacy, isolation, teardown, staging-only, no-load-balancer, no-production-mutation, feature-disabled, and stop-gate requirements remain binding.

The current diagnostic branch reached its runtime-parity gate and stopped before token generation, Cloud Build, or deployment. The observed configuration is:

- staging service template concurrency: `80`;
- active staging revision concurrency: `80`;
- active production revision concurrency: `40`;
- staging and production execution environment: unspecified.

Cloud Run documentation states that an unspecified service can run in either the first- or second-generation execution environment. A single staging result therefore cannot be transferred to the current unspecified production runtime solely by comparing configuration.

## Selected approach

Use the existing `shipmastr-api-staging` service to run a controlled two-revision matrix from one immutable image:

1. Gen1 with container concurrency `40`.
2. Gen2 with container concurrency `40`.

Both revisions are uniquely tagged, receive zero ordinary traffic, keep Courier Audit Intake disabled, and use the same ephemeral probe token. The same five controlled requests run against each tagged revision. Ten structural events are captured and compared case-by-case.

Matching concurrency isolates execution-environment generation as the only runtime variable under test. If all five structural results are identical across Gen1 and Gen2, the result can be transferred to a production service whose generation is unspecified. If any result differs, transfer and interpretation stop.

## Fixed constraints

- Project: `shipmastr-core-prod`.
- Region: `asia-south1`.
- Diagnostic service: `shipmastr-api-staging`.
- Production service: `shipmastr-api`; every production operation is read-only.
- No load balancer exists or may be assumed.
- Production direct Cloud Run domain-mapping count must remain zero.
- The production active revision must remain at concurrency `40`; any drift stops before token generation or build.
- The staging active revision may remain at concurrency `80`; it must keep exactly 100% of ordinary traffic throughout.
- Both diagnostic revisions use concurrency `40`.
- One revision explicitly uses `--execution-environment=gen1`; the other explicitly uses `--execution-environment=gen2`.
- Both deployments use `--no-traffic`, unique tags, the same immutable image digest, `COURIER_AUDIT_INTAKE_ENABLED=false`, and one exact ephemeral probe token.
- No migration, Secret Manager value, signing-secret reference, n8n workflow, production service, protected domain, notification, or outbound integration changes.
- No raw address, forwarding-header value, token, signature, authorization value, cookie, body, URL, credential, or environment list may enter diagnostic evidence.
- The diagnostic branch is never merged to `main`.
- No feature enablement, limiter hotfix, production deployment, or production probe occurs in this amendment.

## Preflight and control state

Before generating a token or building an image, the runner must verify:

- exact branch and approved source lineage;
- clean worktree and index;
- required local commands and parser are present;
- current `gcloud` project is exact;
- evidence outputs do not already exist;
- staging has exactly one 100%-traffic revision;
- Courier Audit Intake is absent or literal `false` on the active staging revision and service template;
- no probe token and no `rlp-` tag exists;
- production has exactly one 100%-traffic revision;
- production concurrency is exactly `40`;
- execution-environment configuration is recorded structurally as `gen1`, `gen2`, or `unspecified` without guessing the selected runtime;
- production has zero direct Cloud Run domain mappings.

The original staging revision name, traffic JSON, active image digest, template concurrency, active concurrency, and execution-environment state are retained separately. No variable may overwrite another configuration layer.

## Run identity and ownership

Each run creates one high-entropy run identifier from:

- UTC timestamp;
- exact source commit prefix;
- a fresh 12-hex random nonce.

The two tags share that run identifier and end in distinct `g1` and `g2` suffixes. Ownership is never inferred from the tag string alone. For each tag, cleanup must require all of:

- exactly one current tag entry;
- the tag points to the revision recorded by this run;
- the recorded revision exists;
- the revision has exactly one container;
- its image equals this run's immutable digest reference;
- its explicit generation and concurrency equal the expected matrix cell.

A missing, duplicated, ambiguous, retargeted, or foreign tag/revision/image prevents its deletion and makes the run fail closed.

## Deployment and measurement flow

The runner builds once, resolves one Artifact Registry digest, and then:

1. Deploys the Gen1/40 tagged revision with zero traffic.
2. Verifies its tag, revision, digest, explicit generation, concurrency, token ownership, disabled feature, and unchanged ordinary traffic.
3. Sends the five approved controlled requests to the Gen1 tagged URL.
4. Captures exactly five structural events from only that revision.
5. Deploys the Gen2/40 tagged revision with zero traffic using the same digest and token.
6. Performs the equivalent ownership and traffic checks.
7. Sends the same five requests to the Gen2 tagged URL.
8. Captures exactly five structural events from only that revision.

The original five cases remain unchanged: baseline, Forwarded-only IPv4, X-Forwarded-For-only IPv4, distinct both-header IPv4, and distinct both-header IPv6 using RFC documentation ranges.

The evidence assembler labels each event with only `gen1` or `gen2` outside the application log payload. It rejects any event count other than five per generation, duplicate/missing case identifiers, unexpected structural keys, or raw-value material.

## Matrix comparison

For each case identifier, compare the complete approved structural event after removing only the matrix label and revision identity supplied by the evidence assembler. Counts, presence flags, marker positions, parse classifications, socket/request match booleans, and limiter-visible structural fields must be identical.

- Exact five-of-five equality: matrix passes and the header result may be interpreted under the original design rules.
- Any difference: matrix fails, evidence is retained, cleanup still runs, and no header-trust interpretation is permitted.

Because production generation is unspecified, a mismatch cannot be resolved by querying a single configured generation. The feature remains disabled. A later step requires separate approval to either pin production to an explicit generation through the normal deployment process or design a new production-safe runtime fingerprint/probe. Neither action is part of this amendment.

## Cleanup and failure handling

The cleanup trap is installed before the first mutation-capable command and runs for success, command failure, `INT`, and `TERM`.

Cleanup must:

1. Re-read the staging service and both tagged revisions.
2. Ownership-check each tag independently against this run's recorded revision, digest, generation, and concurrency.
3. Remove only tags proven owned by this run.
4. Remove the probe token only when the service template contains exactly this run's token.
5. Verify both tags and the token are absent.
6. Verify the original staging revision still receives exactly 100% ordinary traffic.
7. Verify Courier Audit Intake remains absent or literal `false`.
8. Verify production was never mutated.

Per the approved cleanup choice, the runner does not attempt byte-identical restoration of staging service-template history. The active staging revision and traffic remain unchanged; the cleanup revision may remain the latest created zero-traffic revision.

Original nonzero status is preserved. Cleanup failure upgrades an otherwise successful result to nonzero but never hides the original failure.

## Bash 3.2 execution gate

Static avoidance of Bash 4-only syntax is insufficient. The actual runner must expose a `--bash32-self-test` path that exits before `gcloud`, networking, token generation, build, or deployment. It exercises the runner's Bash array-reading and two-cell matrix bookkeeping under the invoking interpreter.

Before any cloud action on the Mac, verification must run:

```bash
test "$(/bin/bash -c 'printf "%s.%s" "${BASH_VERSINFO[0]}" "${BASH_VERSINFO[1]}"')" = "3.2"
/bin/bash -n scripts/rate-limit-proxy-probe.sh
/bin/bash scripts/rate-limit-proxy-probe.sh --bash32-self-test
```

The self-test must print one fixed success line and exit `0`. Any other output/status blocks execution.

## Tests and review gates

TDD must cover:

- the former single-runtime parity parser rejecting the real live shape before the amendment;
- acceptance of explicit Gen1/40 and Gen2/40 matrix cells while recording unspecified live configuration;
- rejection of production concurrency other than `40`;
- exact ten-event, five-per-generation evidence assembly;
- case-by-case matrix equality and mismatch failure;
- run-specific two-tag ownership, including foreign/ambiguous targets and wrong generation/concurrency;
- cleanup status preservation for success, failure, `INT`, and `TERM`;
- source ordering: every preflight gate and Bash self-test path precedes token generation, build, and deployment;
- execution of the actual runner's self-test under real macOS `/bin/bash` 3.2 before cloud action;
- continued absence of `mapfile`, `readarray`, raw logging, limiter-warning suppression, production mutation, active-traffic changes, and feature enablement.

Run focused tests, the approved synthetic full-suite process, the privacy/boundary audit, and an independent review. Critical or Important findings block the matrix probe.

## Stop gate

Successful implementation and review authorize only the isolated matrix probe. After evidence capture and cleanup, stop. Interpret the evidence under the original rules and obtain approval for a separate limiter-hotfix design. Do not enable Courier Audit Intake or deploy a limiter correction from this branch.

## Rejected alternatives

- Temporary service: stronger resource isolation but weaker equivalence to the actual staging service and substantially more IAM/configuration setup.
- Single unspecified-generation revision: fewer operations but leaves the production-generation ambiguity unresolved.
- Configuration-only parity: repeats the unverified inference that caused this amendment.
- Mutating production to discover or pin generation during diagnosis: violates the read-only production boundary.
- Exact staging-template restoration: requires a broader restore mutation and additional revision; explicitly not selected.

## References

- Original design: `docs/superpowers/specs/2026-08-17-cloud-run-rate-limit-header-probe-design.md`
- Original implementation plan: `docs/superpowers/plans/2026-08-17-cloud-run-rate-limit-header-probe.md`
- Google Cloud execution environments: <https://docs.cloud.google.com/run/docs/configuring/execution-environments?hl=en>
- Google Cloud service configuration and concurrency: <https://docs.cloud.google.com/run/docs/configuring>
- `gcloud run deploy` flags: <https://docs.cloud.google.com/sdk/gcloud/reference/run/deploy>
