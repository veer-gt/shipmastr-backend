CREATE TABLE "auth_abuse_states" (
    "id" TEXT NOT NULL,
    "scope_key" TEXT NOT NULL,
    "route_class" TEXT NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lock_until" TIMESTAMP(3),
    "notification_sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_abuse_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "auth_abuse_states_scope_key_key" ON "auth_abuse_states"("scope_key");
CREATE INDEX "auth_abuse_states_route_class_window_start_idx" ON "auth_abuse_states"("route_class", "window_start");
CREATE INDEX "auth_abuse_states_lock_until_idx" ON "auth_abuse_states"("lock_until");
