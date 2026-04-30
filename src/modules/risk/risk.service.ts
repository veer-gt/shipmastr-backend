import type { Order, Prisma, RiskDecision, RiskLevel } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

type RiskResult = {
  score: number;
  level: RiskLevel;
  decision: RiskDecision;
  addressConfidence: number;
  reasons: string[];
};

function clamp(n:number){
 return Math.max(0,Math.min(100,Math.round(n)));
}

export function calculateRisk(
 order: Pick<Order,
 "buyerPhone"|
 "addressLine1"|
 "addressLine2"|
 "city"|
 "state"|
 "pincode"|
 "orderValue"|
 "codAmount"|
 "paymentMode">
):RiskResult{

 let score=12;
 let addressConfidence=90;
 const reasons:string[]=[];

 const phone=order.buyerPhone.replace(/\D/g,"");

 const addr=`
 ${order.addressLine1}
 ${order.addressLine2 ?? ""}
 ${order.city}
 ${order.state}
 ${order.pincode}
 `.toLowerCase();

 if(order.paymentMode==="COD"){
   score+=20;
   reasons.push("COD order");
 }

 if(order.codAmount>=1500){
   score+=15;
   reasons.push("High COD");
 }

 if(order.codAmount>=3000){
   score+=15;
   reasons.push("Very high COD");
 }

 if(addr.length<35){
   score+=12;
   addressConfidence-=20;
   reasons.push("Weak address");
 }

 if(!/^\d{6}$/.test(order.pincode)){
   score+=20;
   reasons.push("Bad pincode");
 }

 if(/(near|opposite|behind|landmark)/i.test(addr)){
   score+=8;
   reasons.push("Landmark heavy");
 }

 if(/^(.)\1{5,}$/.test(phone)){
   score+=25;
   reasons.push("Suspicious phone");
 }

 score=clamp(score);
 addressConfidence=clamp(addressConfidence);

 let level:RiskLevel="LOW";
 let decision:RiskDecision="SHIP";

 if(score>=75){
   level="CRITICAL";
   decision="HOLD";
 }
 else if(score>=55){
   level="HIGH";
   decision="VERIFY";
 }
 else if(score>=35){
   level="MEDIUM";
   decision="VERIFY";
 }

 if(score>=90){
   decision="BLOCK";
 }

 return {
   score,
   level,
   decision,
   addressConfidence,
   reasons
 };
}

export async function scoreOrder(orderId:string, client: Prisma.TransactionClient = prisma){
 const order=await client.order.findUniqueOrThrow({
   where:{id:orderId}
 });

 const result=calculateRisk(order);

 const risk=await client.riskScore.create({
   data:{
    orderId,
    score:result.score,
    level:result.level,
    decision:result.decision,
    addressConfidence:result.addressConfidence,
    reasons:result.reasons
   }
 });

 await client.order.update({
   where:{id:orderId},
   data:{status:"RISK_SCORED"}
 });

 return risk;
}
