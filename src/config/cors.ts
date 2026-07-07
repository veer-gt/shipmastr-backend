export const corsAllowedHeaders = [
  "Content-Type",
  "Authorization",
  "X-Auth-Token",
  "X-Journal-Secret",
  "X-Shipmastr-Courier-Key",
  "X-Shipmastr-Signature",
  "X-Shipmastr-Timestamp",
  "Idempotency-Key",
  "x-checkout-session-token"
] as const;
