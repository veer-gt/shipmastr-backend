# Address Stack A1: Pincode Service

Address Stack A1 adds a self-hosted pincode lookup foundation for checkout address auto-fill. Given a 6-digit Indian pincode, the backend can return city, district, state, and localities so a later checkout UI slice can prefill editable address fields.

## Scope

- A1 is static, self-hosted pincode to city/state/district/localities lookup.
- A1 uses the default Prisma/Postgres schema and maps the model to `address_pincodes`.
- A1 does not enable Prisma `multiSchema` and does not use `@@schema("address")`.
- A1 does not call external APIs in the checkout hot path.
- A1 adds `GET /api/pincode/:pin` and `GET /v1/pincode/:pin`.
- Frontend auto-fill wiring is intentionally a later slice.

## Not Included

A1 does not implement OTP, Truecaller, phone hashing, shopper identities, cross-merchant prefill, consent records, Places Autocomplete, Google geocoding, or Address Graph tables.

## Relationship To Existing Geocoding

The existing `addressGeocoding` module handles live Google geocoding for merchant pickup and warehouse address verification. It manages Google Geocoding calls, quota counters, address fingerprints, geocode statuses, and map pin confirmation metadata.

A1 is separate from that system. It must not replace, modify, or feed `addressGeocoding`, and it must not add Google/API calls. Pincode lookup responses are convenience hints for checkout address entry only; they do not verify or lock a buyer address.

## Seed/Import

Use the local script:

```bash
node scripts/address/seed-pincodes.mjs --file ./path/to/pincodes.csv
```

CSV and JSON inputs are supported. Duplicate pincode rows are aggregated into a single `localities` array. If no file path is provided, the script loads a tiny local/dev fixture for a few known test pincodes only.
