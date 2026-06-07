import type { ShipmentStatus } from "@prisma/client";

export type TrackingTimelineEvent = {
  status: string;
  label: string;
  description: string;
  timestamp: Date | string;
};

type TimelineOrderSource = {
  status?: string | null;
  createdAt?: Date | string | null;
};

type TimelineShipmentSource = {
  status: ShipmentStatus | string;
  awbNumber?: string | null;
  metadata?: unknown;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

type TimelineRateSource = {
  createdAt?: Date | string | null;
};

type TimelineTrackingEventSource = {
  status: ShipmentStatus | string;
  eventLabel?: string | null;
  publicMessage?: string | null;
  occurredAt?: Date | string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function phase6Metadata(value: unknown) {
  if (!isRecord(value)) return {};
  const phase6 = value.phase6;
  return isRecord(phase6) ? phase6 : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isoLike(value: unknown) {
  if (value instanceof Date) return value;
  return typeof value === "string" && value.trim() ? value : null;
}

export function publicStatusForShipmentStatus(status: string | null | undefined) {
  const normalized = String(status || "").toLowerCase();
  const map: Record<string, { publicStatus: string; timelineLabel: string; timelineDescription: string }> = {
    needs_attention: {
      publicStatus: "Order needs seller review",
      timelineLabel: "Order needs review",
      timelineDescription: "The seller is reviewing order details before shipping."
    },
    ready_to_ship: {
      publicStatus: "Ready to ship",
      timelineLabel: "Ready to ship",
      timelineDescription: "The order is ready for shipment creation."
    },
    draft: {
      publicStatus: "Preparing shipment",
      timelineLabel: "Shipment draft created",
      timelineDescription: "The seller has started preparing this shipment."
    },
    pending_rating: {
      publicStatus: "Preparing shipment",
      timelineLabel: "Preparing shipment",
      timelineDescription: "Shipmastr is preparing the shipping path."
    },
    rates_fetched: {
      publicStatus: "Shipping option selected",
      timelineLabel: "Shipping option ready",
      timelineDescription: "A Shipmastr shipping option has been prepared."
    },
    rates_available: {
      publicStatus: "Shipping option selected",
      timelineLabel: "Shipping option ready",
      timelineDescription: "A Shipmastr shipping option has been prepared."
    },
    manifested: {
      publicStatus: "Shipment booked",
      timelineLabel: "Shipment booked",
      timelineDescription: "Your shipment has been booked."
    },
    awb_assigned: {
      publicStatus: "Shipment booked",
      timelineLabel: "Shipment booked",
      timelineDescription: "Your shipment has been booked."
    },
    label_generated: {
      publicStatus: "Shipment ready",
      timelineLabel: "Label ready",
      timelineDescription: "The shipping label has been generated."
    },
    pickup_scheduled: {
      publicStatus: "Pickup scheduled",
      timelineLabel: "Pickup scheduled",
      timelineDescription: "Pickup has been scheduled."
    },
    picked_up: {
      publicStatus: "Picked up",
      timelineLabel: "Picked up",
      timelineDescription: "The shipment has been picked up."
    },
    in_transit: {
      publicStatus: "In transit",
      timelineLabel: "In transit",
      timelineDescription: "Your shipment is moving through the network."
    },
    out_for_delivery: {
      publicStatus: "Out for delivery",
      timelineLabel: "Out for delivery",
      timelineDescription: "Your shipment is out for delivery."
    },
    delivered: {
      publicStatus: "Delivered",
      timelineLabel: "Delivered",
      timelineDescription: "Your shipment has been delivered."
    },
    rto_initiated: {
      publicStatus: "Returning to seller",
      timelineLabel: "Return started",
      timelineDescription: "The shipment is returning to the seller."
    },
    rto_in_transit: {
      publicStatus: "Returning to seller",
      timelineLabel: "Return in transit",
      timelineDescription: "The shipment is returning to the seller."
    },
    rto_delivered: {
      publicStatus: "Returned to seller",
      timelineLabel: "Returned to seller",
      timelineDescription: "The shipment has returned to the seller."
    },
    cancelled: {
      publicStatus: "Cancelled",
      timelineLabel: "Cancelled",
      timelineDescription: "This shipment has been cancelled."
    },
    provider_failed: {
      publicStatus: "Shipment delayed",
      timelineLabel: "Shipment delayed",
      timelineDescription: "The shipment needs seller support before it can move ahead."
    },
    delivery_failed: {
      publicStatus: "Delivery needs attention",
      timelineLabel: "Delivery needs attention",
      timelineDescription: "The delivery could not be completed and needs seller support."
    },
    exception: {
      publicStatus: "Shipment delayed",
      timelineLabel: "Shipment delayed",
      timelineDescription: "The shipment needs seller support before it can move ahead."
    }
  };

  return map[normalized] || {
    publicStatus: "Preparing shipment",
    timelineLabel: "Preparing shipment",
    timelineDescription: "The seller is preparing this shipment."
  };
}

function pushEvent(events: TrackingTimelineEvent[], event: TrackingTimelineEvent | null) {
  if (!event?.timestamp) return;
  const key = `${event.status}:${new Date(event.timestamp).toISOString()}`;
  if (events.some((item) => `${item.status}:${new Date(item.timestamp).toISOString()}` === key)) return;
  events.push(event);
}

export function buildTrackingTimeline(input: {
  order?: TimelineOrderSource | null;
  shipment: TimelineShipmentSource;
  rates?: TimelineRateSource[];
  trackingEvents?: TimelineTrackingEventSource[];
}) {
  const events: TrackingTimelineEvent[] = [];
  const phase6 = phase6Metadata(input.shipment.metadata);

  pushEvent(events, input.order?.createdAt ? {
    status: "order_created",
    label: "Order received",
    description: "Your order has been received by the seller.",
    timestamp: input.order.createdAt
  } : null);

  if (String(input.order?.status || "").toUpperCase() === "NEEDS_ATTENTION") {
    pushEvent(events, {
      status: "needs_attention",
      label: "Order under review",
      description: "The seller is reviewing order details before shipping.",
      timestamp: input.order?.createdAt || input.shipment.createdAt || new Date()
    });
  }

  if (input.shipment.createdAt) {
    pushEvent(events, {
      status: "shipment_created",
      label: "Shipment created",
      description: "Your shipment has been prepared.",
      timestamp: input.shipment.createdAt
    });
  }

  const firstRate = (input.rates || [])
    .filter((rate) => rate.createdAt)
    .sort((left, right) => new Date(left.createdAt!).getTime() - new Date(right.createdAt!).getTime())[0];

  if (firstRate?.createdAt) {
    pushEvent(events, {
      status: "rates_available",
      label: "Shipping option ready",
      description: "A Shipmastr shipping option has been prepared.",
      timestamp: firstRate.createdAt
    });
  }

  const awbAssignedAt = isoLike(phase6.awbAssignedAt);
  if (awbAssignedAt || input.shipment.awbNumber) {
    pushEvent(events, {
      status: "awb_assigned",
      label: "Shipment booked",
      description: "Your shipment has been booked.",
      timestamp: awbAssignedAt || input.shipment.updatedAt || input.shipment.createdAt || new Date()
    });
  }

  const labelGeneratedAt = isoLike(phase6.labelGeneratedAt);
  if (labelGeneratedAt || stringValue(phase6.labelUrl)) {
    pushEvent(events, {
      status: "label_generated",
      label: "Label ready",
      description: "The shipping label has been generated.",
      timestamp: labelGeneratedAt || input.shipment.updatedAt || input.shipment.createdAt || new Date()
    });
  }

  for (const event of input.trackingEvents || []) {
    const publicStatus = publicStatusForShipmentStatus(String(event.status));
    pushEvent(events, {
      status: String(event.status),
      label: event.eventLabel || publicStatus.timelineLabel,
      description: event.publicMessage || publicStatus.timelineDescription,
      timestamp: event.occurredAt || new Date()
    });
  }

  const finalPublicStatus = publicStatusForShipmentStatus(String(input.shipment.status));
  const finalStatus = String(input.shipment.status);
  if (!["draft", "rates_fetched", "manifested"].includes(finalStatus)) {
    pushEvent(events, {
      status: finalStatus,
      label: finalPublicStatus.timelineLabel,
      description: finalPublicStatus.timelineDescription,
      timestamp: input.shipment.updatedAt || input.shipment.createdAt || new Date()
    });
  }

  return events.sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime());
}
