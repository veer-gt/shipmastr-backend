CREATE TABLE "address_events" (
  "id" TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "shopper_id" TEXT,
  "merchant_id" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "meta" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "address_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "address_events_event_chk"
    CHECK ("event" IN (
      'phone_verified',
      'graph_hit_merchant',
      'graph_hit_network',
      'graph_miss',
      'prefill_offered',
      'prefill_accepted',
      'prefill_edited',
      'pincode_resolved',
      'places_selected',
      'manual_completed',
      'abandoned_at_address'
    ))
);

CREATE INDEX "address_events_event_created_at_idx"
  ON "address_events"("event", "created_at");
CREATE INDEX "address_events_session_id_idx"
  ON "address_events"("session_id");
CREATE INDEX "address_events_shopper_id_idx"
  ON "address_events"("shopper_id");
CREATE INDEX "address_events_merchant_id_idx"
  ON "address_events"("merchant_id");
