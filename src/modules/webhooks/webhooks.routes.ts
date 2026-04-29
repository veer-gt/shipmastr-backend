import {Router} from "express";
import {z} from "zod";
import {prisma} from "../../lib/prisma.js";
import {verifyWebhookSignature} from "./webhook.security.js";

export const webhooksRouter=Router();

const schema=z.object({
 externalId:z.string(),
 eventType:z.string(),
 externalOrderId:z.string().optional()
}).passthrough();

webhooksRouter.post(
"/carrier",
async(req,res)=>{

const signatureValid=
verifyWebhookSignature(
 req.rawBody ??
 Buffer.from(JSON.stringify(req.body)),
 req.header(
 "x-shipmastr-signature"
 ) ?? undefined
);

const body=schema.parse(req.body);

const existing=
await prisma.webhookEvent.findUnique({
 where:{
  provider_externalId:{
   provider:"CARRIER",
   externalId:body.externalId
  }
 }
});

if(existing){
 return res.json({
  ok:true,
  duplicate:true
 });
}

const order=
body.externalOrderId
? await prisma.order.findFirst({
 where:{
  externalOrderId:
   body.externalOrderId
 }
})
:null;

const webhookData: Record<string, unknown> = {
 provider: "CARRIER",
 externalId: body.externalId,
 eventType: body.eventType,
 payload: body as any,
 signatureValid,
 status: "PROCESSED"
};

if (order?.id) {
 webhookData.orderId = order.id;
}

const event =
await prisma.webhookEvent.create({
 data: webhookData as any
});

if (order) {
 const mappedStatus =
  body.eventType === "shipment.delivered" ? "DELIVERED" :
  body.eventType === "shipment.ndr" ? "NDR" :
  body.eventType === "shipment.rto" ? "RTO" :
  body.eventType === "shipment.shipped" ? "SHIPPED" :
  undefined;

 if (mappedStatus) {
  await prisma.order.update({
   where: { id: order.id },
   data: { status: mappedStatus as any }
  });
 }
}


res.json({
 ok:true,
 eventId:event.id
});

});
