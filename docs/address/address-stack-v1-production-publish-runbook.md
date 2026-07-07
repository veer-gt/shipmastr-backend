# Address Stack v1 Production Publish Runbook

Address Stack v1 publish is guarded. The release may be staged and promoted only after the required backend secret bindings, migration approvals, rollback points, and smoke checks are complete.

## Guardrails

- OTP remains pilot/non-functional until real SMS, WhatsApp, or Truecaller APIs are added.
- `CHECKOUT_DEV_OTP_CODE` is shared-code smoke support only. It must not be marketed as real phone ownership verification.
- Secret values must be created, rotated, and versioned outside git. Do not print, commit, paste, or screenshot secret values.
- Places remains disabled by default:
  - `GOOGLE_ADDRESS_AUTOCOMPLETE_ENABLED=false`
  - `GOOGLE_PLACE_DETAILS_ENABLED=false`
- `ADDRESS_NETWORK_PREFILL_ENABLED=false`.
- Network prefill is shadow-only and hidden from buyers.
- The storefront-renderer deploy target is Cloud Run service `shipmastr-storefront-renderer`, not Hostinger.
- `seller-panel` and Hostinger are not part of this release.

## Required Secret Manager Secrets

Production and staging deploys must bind these secrets before Address Stack v1 publish:

- `ADDRESS_PHONE_PEPPER`
- `CHECKOUT_ADDRESS_SESSION_TOKEN_SECRET`

The backend deploy scripts bind them as:

```text
ADDRESS_PHONE_PEPPER=ADDRESS_PHONE_PEPPER:latest
CHECKOUT_ADDRESS_SESSION_TOKEN_SECRET=CHECKOUT_ADDRESS_SESSION_TOKEN_SECRET:latest
```

## Production Sequence

1. Check whether the two required Secret Manager secrets exist.

   ```bash
   gcloud secrets describe ADDRESS_PHONE_PEPPER --project shipmastr-core-prod
   gcloud secrets describe CHECKOUT_ADDRESS_SESSION_TOKEN_SECRET --project shipmastr-core-prod
   ```

2. Create the secrets or add new versions without printing values.

   Use the approved secret-management path for the environment. If using CLI input, pipe from a secure prompt or file descriptor and do not echo the value into shell history, logs, tickets, or docs.

3. Run a migration status-only check.

   ```bash
   cd backend
   npx prisma migrate status
   ```

4. Apply A1-A4 Address Stack migrations only after explicit approval.

   Use the existing approved backend migration flow. Do not apply migrations as part of the deploy-script secret-binding check.

5. Capture rollback points before deployment.

   Record the current backend Cloud Run revision and image digest. Record the current storefront-renderer Cloud Run revision and image digest before publishing the storefront renderer.

6. Deploy backend staging and smoke.

   Use the existing `scripts/deploy-staging.sh` flow after the two secret bindings are confirmed. Smoke `/v1/health`, `/api/health`, Address Stack checkout session creation, pincode lookup, guarded Places disabled behavior, and no payment-path regressions.

7. Deploy backend production by tested digest.

   Promote the already-smoked immutable image digest through the existing `scripts/deploy-prod.sh` flow. Do not build a different production artifact unless the approved production flow requires it.

8. Deploy storefront-renderer Cloud Run.

   Publish to Cloud Run service `shipmastr-storefront-renderer`. Do not publish Hostinger and do not touch `seller-panel`.

9. Smoke backend and storefront.

   Confirm checkout session creation no longer fails from missing secret bindings. Confirm manual checkout still works, Places remains disabled by default, network prefill is hidden, OTP remains pilot-only, and no checkout payment, wallet, settlement, payout, custody, Razorpay, Cashfree, or COD ledger paths regressed.

10. Commit the publish handoff doc after the actual publish.

    The handoff doc should include exact commands run, old and new revisions, image digests, smoke results, log-watch results, rollback commands, and final `GREEN` or `BLOCKED` status.
