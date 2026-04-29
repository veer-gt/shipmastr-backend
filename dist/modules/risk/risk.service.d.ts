import type { Order, RiskDecision, RiskLevel } from "@prisma/client";
type RiskResult = {
    score: number;
    level: RiskLevel;
    decision: RiskDecision;
    addressConfidence: number;
    reasons: string[];
};
export declare function calculateRisk(order: Pick<Order, "buyerPhone" | "addressLine1" | "addressLine2" | "city" | "state" | "pincode" | "orderValue" | "codAmount" | "paymentMode">): RiskResult;
export declare function scoreOrder(orderId: string): Promise<{
    level: import("@prisma/client").$Enums.RiskLevel;
    id: string;
    createdAt: Date;
    score: number;
    decision: import("@prisma/client").$Enums.RiskDecision;
    addressConfidence: number;
    reasons: import("@prisma/client/runtime/library").JsonValue;
    modelVersion: string;
    orderId: string;
}>;
export {};
//# sourceMappingURL=risk.service.d.ts.map