# Synthetic webhook fixture output

This directory is intentionally limited to documentation. Generate deterministic, in-memory PII-free payloads with:

```bash
node scripts/security-fixtures/platform-webhooks.mjs SHOPIFY
```

The generator computes HMAC-SHA256 signatures at test time using `SHOPIFY_WEBHOOK_SECRET`, `WOOCOMMERCE_WEBHOOK_SECRET`, or `MAGENTO_WEBHOOK_SECRET` when supplied. If a test-only value is not supplied, a random value is generated in memory and is never written to source, fixtures, logs, or documentation.
