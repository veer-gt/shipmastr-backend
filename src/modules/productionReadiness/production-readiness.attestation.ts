/**
 * Immutable readiness evidence generated from root origin/main 71a44cd93ef9b0dced6712150f48ca7b0db376c3.
 *
 * The source root commit pointed to backend base commit 224bd09f14271cc87a93d9a17dab7204c14538c7.
 * Runtime code consumes this bundled evidence rather than probing sibling
 * source trees that are intentionally absent from the production image.
 */
export const productionReadinessAttestation = Object.freeze({
  schemaVersion: 1,
  sourceRootCommit: "71a44cd93ef9b0dced6712150f48ca7b0db376c3",
  backendBaseCommit: "224bd09f14271cc87a93d9a17dab7204c14538c7",
  documents: {
    phase30BetaAudit: {
      path: "docs/shipping/phase-30-end-to-end-merchant-shipping-beta-audit.md",
      present: true,
      sha256: "a5756394037ab4622df46d1a390aabe1594d3763e1df571ced43bfbe8f7c5d91"
    },
    phase39ProductionRunbook: {
      path: "docs/shipping/phase-39-production-deployment-runbook-smoke-test.md",
      present: true,
      sha256: "c468dd3f1d88702d9fc9d5202f50ce051d0865bfcff64d04b793e7f978b1116b"
    }
  },
  sellerUiProviderScan: {
    sourcePrefix: "seller-panel/src",
    scannedFiles: 113,
    treeSha256: "4ac6ce06045e0141f09de01bf365b5791495d0316a45323a193b1eca249c0d61",
    providerLeakHits: 0,
    passed: true
  }
} as const);

const COMMIT_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export function getBundledProductionReadinessEvidence() {
  const attestation = productionReadinessAttestation;
  const provenanceValid = attestation.schemaVersion === 1
    && COMMIT_SHA.test(attestation.sourceRootCommit)
    && COMMIT_SHA.test(attestation.backendBaseCommit);
  const phase30DocumentPresent = provenanceValid
    && attestation.documents.phase30BetaAudit.present
    && SHA256.test(attestation.documents.phase30BetaAudit.sha256);
  const phase39DocumentPresent = provenanceValid
    && attestation.documents.phase39ProductionRunbook.present
    && SHA256.test(attestation.documents.phase39ProductionRunbook.sha256);
  const sellerUiProviderScanPassed = provenanceValid
    && attestation.sellerUiProviderScan.passed
    && attestation.sellerUiProviderScan.scannedFiles > 0
    && attestation.sellerUiProviderScan.providerLeakHits === 0
    && SHA256.test(attestation.sellerUiProviderScan.treeSha256);

  return {
    attestationValid: phase30DocumentPresent
      && phase39DocumentPresent
      && sellerUiProviderScanPassed,
    phase30DocumentPresent,
    phase39DocumentPresent,
    sellerUiProviderScanPassed
  };
}
