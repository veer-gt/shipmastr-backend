import type { LegacyRiskDecision, Order, Prisma, RiskLevel } from "@prisma/client";
type RiskResult = {
    score: number;
    level: RiskLevel;
    decision: LegacyRiskDecision;
    addressConfidence: number;
    reasons: string[];
};
export declare function calculateRisk(order: Pick<Order, "buyerPhone" | "addressLine1" | "addressLine2" | "city" | "state" | "pincode" | "orderValue" | "codAmount" | "paymentMode">): RiskResult;
export declare function scoreOrder(orderId: string, client?: Prisma.TransactionClient): Promise<{
    level: import("@prisma/client").$Enums.RiskLevel;
    id: string;
    createdAt: Date;
    orderId: string;
    reasons: Prisma.JsonValue;
    score: number;
    decision: import("@prisma/client").$Enums.LegacyRiskDecision;
    addressConfidence: number;
    modelVersion: string;
}>;
export {};
//# sourceMappingURL=risk.service.d.ts.map