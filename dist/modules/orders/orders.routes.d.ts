import { buildSellerSafeOrderDecision } from "../intelligence/seller-safe-decision.service.js";
export declare const ordersRouter: import("express-serve-static-core").Router;
type OrderAutomationDecision = Awaited<ReturnType<typeof buildSellerSafeOrderDecision>>;
type SellerOrderShipmentDetails = {
    courierId?: string | null;
    awb?: string | null;
    trackingNumber?: string | null;
    shipmentStatus?: string | null;
    weightGrams?: number | null;
    volumetricWeight?: unknown;
} | null;
type SellerOrderSource = {
    id: string;
    merchantId: string;
    externalOrderId: string;
    buyerName: string;
    city: string;
    state: string;
    pincode: string;
    orderValue: number;
    codAmount: number;
    paymentMode: string;
    weightGrams?: number | null;
    status: string;
    createdAt: Date;
    updatedAt: Date;
    shipmentDetails?: SellerOrderShipmentDetails;
};
type SellerOrderCourier = {
    id?: string;
    name?: string | null;
    code?: string | null;
};
type SellerOrderCourierShipment = {
    id: string;
    orderId?: string | null;
    awbNumber: string;
    status: string;
    weightGrams?: number | null;
    trackingUrl?: string | null;
    createdAt: Date;
    updatedAt: Date;
    courier: SellerOrderCourier;
    firstShipmentRequest?: {
        merchantId: string;
    } | null;
};
type SellerOrderCodRemittance = {
    id: string;
    merchantId: string;
    awb?: string | null;
    orderId?: string | null;
    externalOrderId?: string | null;
    remittedAmount?: unknown;
    remittedAt?: Date | null;
    utr?: string | null;
    status: string;
    createdAt: Date;
    updatedAt: Date;
};
type SellerOrderSettlement = {
    merchantId: string;
    orderId?: string | null;
    awb?: string | null;
    status: string;
    sellerPayable?: unknown;
    approvedAt?: Date | null;
    settledAt?: Date | null;
    metadata?: unknown;
    createdAt: Date;
    updatedAt: Date;
};
export declare function buildSellerSafeOrders(input: {
    orders: SellerOrderSource[];
    courierById?: Map<string, SellerOrderCourier>;
    courierShipments?: SellerOrderCourierShipment[];
    codRemittances?: SellerOrderCodRemittance[];
    sellerSettlements?: SellerOrderSettlement[];
}): {
    id: string;
    merchantId: string;
    externalOrderId: string;
    orderId: string;
    customerName: string;
    buyerName: string;
    city: string;
    state: string;
    pincode: string;
    shippingPincode: string;
    declaredValue: number;
    orderValue: number;
    codAmount: number;
    paymentMode: string;
    weightGrams: number | null;
    status: string;
    isDelivered: boolean;
    createdAt: Date;
    updatedAt: Date;
    awb: string | null;
    awbNumber: string | null;
    carrier: string | null;
    shipmentStatus: string;
    trackingNumber: string | null;
    trackingUrl: string | null;
    deadWeightKg: number | null;
    volumetricWeightKg: any;
    chargeableWeightKg: number | null;
    shipmentWeight: {
        deadWeightKg: number | null;
        volumetricWeightKg: any;
        chargeableWeightKg: number | null;
    };
    codRemittanceStatus: string | null;
    codRemittanceReadiness: string | null;
    codRemittedAmount: any;
    codRemittedAt: Date | null;
    sellerPayoutReadiness: string | null;
    sellerPayoutApprovalStatus: string | null;
    sellerPayoutApprovedAmount: any;
    sellerPayoutApprovedAt: Date | null;
    sellerPayoutReleaseStatus: string | null;
    sellerPayoutReleaseConfirmed: boolean;
    sellerPayoutReleasedAmount: any;
    sellerPayoutReleasedAt: string | null;
    sellerPayoutAwaitingExternalExecution: boolean | null;
    sellerPayoutPaid: boolean;
    sellerPayoutPaidAmount: any;
    sellerPayoutPaidAt: string | Date | null;
    sellerPayoutPaidMode: string | null;
    sellerPayoutPaidReference: string | null;
    sellerPayoutSandboxManual: boolean;
    sellerPayoutPaymentProviderCalled: boolean | null;
    sellerPayoutBankTransferCreated: boolean | null;
}[];
export declare function buildOrderAutomationPayloads(order: {
    id: string;
    merchantId: string;
    externalOrderId: string;
    buyerName: string;
    buyerPhone: string;
    addressLine1: string;
    addressLine2: string | null;
    city: string;
    state: string;
    pincode: string;
    orderValue: number;
    codAmount: number;
    paymentMode: string;
}, decision: OrderAutomationDecision): {
    orderCreated: {
        orderId: string;
        externalOrderId: string;
        orderValue: number;
        codAmount: number;
        paymentMode: string;
        buyerContact: {
            name: string;
            phone: string;
        };
        destination: {
            city: string;
            state: string;
            pincode: string;
        };
        codDecision: import("@prisma/client").$Enums.CodDecision;
        shipmentDecision: import("@prisma/client").$Enums.ShipmentDecision;
        automationStatus: import("../intelligence/seller-safe-decision.service.js").SellerSafeAutomationStatus;
        pendingRequiredAction: string | null;
        riskTier: string;
        sellerSafeRiskSummary: string[];
        recommendedAction: string;
    };
    codRiskHigh: {
        eventIntent: string;
        orderId: string;
        externalOrderId: string;
        orderValue: number;
        codAmount: number;
        paymentMode: string;
        buyerContact: {
            name: string;
            phone: string;
        };
        destination: {
            city: string;
            state: string;
            pincode: string;
        };
        codDecision: import("@prisma/client").$Enums.CodDecision;
        shipmentDecision: import("@prisma/client").$Enums.ShipmentDecision;
        automationStatus: import("../intelligence/seller-safe-decision.service.js").SellerSafeAutomationStatus;
        pendingRequiredAction: string | null;
        riskTier: string;
        sellerSafeRiskSummary: string[];
        recommendedAction: string;
    };
    addressConfirmation: {
        eventIntent: string;
        shippingAddress: {
            line1: string;
            line2: string | null;
            city: string;
            state: string;
            pincode: string;
        };
        orderId: string;
        externalOrderId: string;
        orderValue: number;
        codAmount: number;
        paymentMode: string;
        buyerContact: {
            name: string;
            phone: string;
        };
        destination: {
            city: string;
            state: string;
            pincode: string;
        };
        codDecision: import("@prisma/client").$Enums.CodDecision;
        shipmentDecision: import("@prisma/client").$Enums.ShipmentDecision;
        automationStatus: import("../intelligence/seller-safe-decision.service.js").SellerSafeAutomationStatus;
        pendingRequiredAction: string | null;
        riskTier: string;
        sellerSafeRiskSummary: string[];
        recommendedAction: string;
    };
};
export declare function buildOrderAutomationEvents(order: Parameters<typeof buildOrderAutomationPayloads>[0], decision: OrderAutomationDecision): {
    merchantId: string;
    eventKey: string;
    source: string;
    sourceId: string;
    idempotencyKey: string;
    payload: {
        orderId: string;
        externalOrderId: string;
        orderValue: number;
        codAmount: number;
        paymentMode: string;
        buyerContact: {
            name: string;
            phone: string;
        };
        destination: {
            city: string;
            state: string;
            pincode: string;
        };
        codDecision: import("@prisma/client").$Enums.CodDecision;
        shipmentDecision: import("@prisma/client").$Enums.ShipmentDecision;
        automationStatus: import("../intelligence/seller-safe-decision.service.js").SellerSafeAutomationStatus;
        pendingRequiredAction: string | null;
        riskTier: string;
        sellerSafeRiskSummary: string[];
        recommendedAction: string;
    };
}[];
export {};
//# sourceMappingURL=orders.routes.d.ts.map