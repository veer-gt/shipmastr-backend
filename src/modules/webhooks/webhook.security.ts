import crypto from "crypto";
import {env} from "../../config/env.js";

export function verifyWebhookSignature(
 rawBody:Buffer,
 signature?:string
){
 if(!signature) return false;

 const expected=
 crypto
  .createHmac(
   "sha256",
   env.WEBHOOK_SECRET
  )
  .update(rawBody)
  .digest("hex");

 try{
  return crypto.timingSafeEqual(
   Buffer.from(signature),
   Buffer.from(expected)
  );
 }catch{
  return false;
 }
}
