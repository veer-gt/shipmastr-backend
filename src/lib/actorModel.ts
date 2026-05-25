import { ActorType } from "./accountRoles.js";

export type ActorFeature = {
  key: string;
  label: string;
  route: string;
};

export type ActorModelDefinition = {
  actorType: ActorType;
  label: string;
  panelName: string;
  entryPoint: string;
  primaryRoute: string;
  emptyStateCta: string;
  description: string;
  features: ActorFeature[];
};

export const shipmastrActorModel: Record<ActorType.MERCHANT | ActorType.SELLER | ActorType.COURIER_PARTNER, ActorModelDefinition> = {
  [ActorType.MERCHANT]: {
    actorType: ActorType.MERCHANT,
    label: "Merchant",
    panelName: "Merchant Panel",
    entryPoint: "Build on Shipmastr",
    primaryRoute: "/merchant",
    emptyStateCta: "Create your hosted store",
    description: "Full-stack commerce account using Shipmastr Website Hosting, Checkout, and Shipping.",
    features: [
      { key: "website", label: "Hosted storefront and themes", route: "/merchant/website" },
      { key: "products", label: "Products and catalog", route: "/merchant/products" },
      { key: "domains", label: "Brand domains, DNS, and SSL", route: "/merchant/domains" },
      { key: "checkout", label: "Checkout", route: "/merchant/checkout" },
      { key: "orders", label: "Orders", route: "/merchant/orders" },
      { key: "shipping", label: "Shipping", route: "/merchant/shipping" },
      { key: "finance", label: "Finance", route: "/merchant/finance" },
      { key: "customers", label: "Customers", route: "/merchant/customers" },
      { key: "marketing-services", label: "Marketing and services", route: "/merchant/tenx-services" }
    ]
  },
  [ActorType.SELLER]: {
    actorType: ActorType.SELLER,
    label: "Seller",
    panelName: "Seller Panel",
    entryPoint: "Connect existing store",
    primaryRoute: "/seller/dashboard",
    emptyStateCta: "Connect your existing store",
    description: "External-store account using Shipmastr Checkout and/or Shipping as modular services.",
    features: [
      { key: "checkout-api", label: "Checkout link/API", route: "/seller/apps" },
      { key: "orders", label: "Orders", route: "/seller/orders" },
      { key: "shipping", label: "Shipping and quick delivery", route: "/seller/quick-delivery" },
      { key: "cod-risk", label: "COD risk", route: "/seller/dashboard" },
      { key: "reconciliation", label: "COD and reconciliation", route: "/seller/finance/reconciliation" },
      { key: "ndr-rto", label: "NDR/RTO recovery", route: "/seller/ndr" },
      { key: "integrations", label: "Integrations", route: "/seller/apps" }
    ]
  },
  [ActorType.COURIER_PARTNER]: {
    actorType: ActorType.COURIER_PARTNER,
    label: "Courier Partner",
    panelName: "Courier Partner Panel",
    entryPoint: "Courier Partner / API Partner",
    primaryRoute: "/courier/dashboard",
    emptyStateCta: "Configure API and serviceability",
    description: "3PL/carrier API partner integrated into Shipmastr logistics operations.",
    features: [
      { key: "api-docs", label: "API docs and sandbox", route: "/courier/docs" },
      { key: "serviceability", label: "Serviceability zones", route: "/courier/profile" },
      { key: "rate-cards", label: "Rate cards", route: "/courier/profile" },
      { key: "pickup-capacity", label: "Pickup capacity", route: "/courier/pickups" },
      { key: "scans", label: "Scans and shipment events", route: "/courier/shipments" },
      { key: "ndr-rto", label: "NDR/RTO events", route: "/courier/ndr" },
      { key: "invoices", label: "Invoices and disputes", route: "/courier/invoices" },
      { key: "sla-metrics", label: "SLA metrics", route: "/courier/dashboard" }
    ]
  }
};

export function actorModelForType(actorType: ActorType) {
  if (actorType === ActorType.ADMIN) return null;
  return shipmastrActorModel[actorType];
}
