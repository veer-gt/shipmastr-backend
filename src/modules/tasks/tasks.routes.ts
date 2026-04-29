import {Router} from "express";

export const tasksRouter=Router();

tasksRouter.post(
"/notifications",
async(req,res)=>{
 res.json({
  ok:true,
  task:"notifications"
 });
});

tasksRouter.post(
"/ndr-actions",
async(req,res)=>{
 res.json({
  ok:true,
  task:"ndr"
 });
});
