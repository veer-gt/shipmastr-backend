export type ShipmentReferenceResolverInput = {
  externalRef: string;
  source: string;
  counterparty?: string | null | undefined;
  brandOrgId?: string | null | undefined;
};

export type ShipmentReferenceResolverResult = {
  shipmentId: string;
};

export interface ShipmentReferenceResolver {
  resolveShipmentRef(input: ShipmentReferenceResolverInput): Promise<ShipmentReferenceResolverResult | null>;
}

export class NullShipmentReferenceResolver implements ShipmentReferenceResolver {
  async resolveShipmentRef(): Promise<ShipmentReferenceResolverResult | null> {
    return null;
  }
}
