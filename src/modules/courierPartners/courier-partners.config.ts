import { ShipmentSegment } from "@prisma/client";

export const DEFAULT_SYSTEM_COURIER_PARTNER = {
  code: "bigship",
  name: "Bigship",
  status: "active",
  isSystemManaged: true,
  defaultForNewSellers: true,
  credentialsRequiredFromSeller: false,
  country: "IN",
  supportedSegments: [
    ShipmentSegment.domestic_b2c,
    ShipmentSegment.domestic_b2b,
    ShipmentSegment.hyperlocal
  ]
} as const;

export const SHIPMASTR_PUBLIC_COURIER_NETWORK = {
  partnerCode: "shipmastr_courier_network",
  partnerName: "Shipmastr Courier Network"
} as const;

export const SHIPMASTR_PUBLIC_SERVICE_LEVELS = [
  "Shipmastr Smart",
  "Shipmastr Economy",
  "Shipmastr Express"
] as const;
