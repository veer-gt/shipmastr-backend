-- Phase 41A: Courier readiness safety audit relation hardening.
-- Adds the probe-to-credential relation without changing existing rows.

ALTER TABLE "courier_provider_readiness_probes"
  ADD CONSTRAINT "courier_provider_readiness_probes_credential_id_fkey"
  FOREIGN KEY ("credential_id") REFERENCES "courier_provider_credentials"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
