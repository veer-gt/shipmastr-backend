import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const pincodes = [
  { pincode: "560001", addressConfidence: 86, deliveryRate: 0.91, rtoRate: 0.05, ndrRate: 0.08 },
  { pincode: "110001", addressConfidence: 82, deliveryRate: 0.88, rtoRate: 0.07, ndrRate: 0.1 },
  { pincode: "400001", addressConfidence: 84, deliveryRate: 0.9, rtoRate: 0.06, ndrRate: 0.09 }
];

const couriers = [
  { name: "Shipmastr Manual Courier", code: "SMMANUAL", priority: 100 },
  { name: "Metro Swift", code: "METROSWIFT", priority: 80 },
  { name: "Bharat Express", code: "BHARATEXP", priority: 90 }
];

async function main() {
  for (const pincode of pincodes) {
    await prisma.pincodeIntelligence.upsert({
      where: { pincode: pincode.pincode },
      create: {
        pincode: pincode.pincode,
        totalOrders: 100,
        deliveredOrders: Math.round(pincode.deliveryRate * 100),
        ndrOrders: Math.round(pincode.ndrRate * 100),
        rtoOrders: Math.round(pincode.rtoRate * 100),
        addressConfidence: pincode.addressConfidence,
        deliveryRate: pincode.deliveryRate,
        rtoRate: pincode.rtoRate,
        ndrRate: pincode.ndrRate,
        metadata: { seed: true }
      },
      update: {
        addressConfidence: pincode.addressConfidence,
        deliveryRate: pincode.deliveryRate,
        rtoRate: pincode.rtoRate,
        ndrRate: pincode.ndrRate,
        metadata: { seed: true }
      }
    });
  }

  for (const courier of couriers) {
    const partner = await prisma.courierPartner.upsert({
      where: { code: courier.code },
      create: {
        name: courier.name,
        code: courier.code,
        priority: courier.priority,
        apiMode: "mock",
        supportsCOD: true,
        supportsPrepaid: true,
        supportsPickup: true
      },
      update: {
        name: courier.name,
        priority: courier.priority,
        active: true
      }
    });

    for (const pincode of pincodes) {
      const score = Math.round(pincode.deliveryRate * 80 - pincode.rtoRate * 50 + (100 - courier.priority) / 5 + 20);
      await prisma.courierPincodePerformance.upsert({
        where: {
          courierId_pincode: {
            courierId: partner.id,
            pincode: pincode.pincode
          }
        },
        create: {
          courierId: partner.id,
          pincode: pincode.pincode,
          totalShipments: 100,
          deliveredCount: Math.round(pincode.deliveryRate * 100),
          ndrCount: Math.round(pincode.ndrRate * 100),
          rtoCount: Math.round(pincode.rtoRate * 100),
          deliveryRate: pincode.deliveryRate,
          rtoRate: pincode.rtoRate,
          score
        },
        update: {
          deliveryRate: pincode.deliveryRate,
          rtoRate: pincode.rtoRate,
          score
        }
      });
    }

    await prisma.courierScorecard.upsert({
      where: { courierId: partner.id },
      create: {
        courierId: partner.id,
        shipmentCount: 300,
        deliveredCount: 269,
        ndrCount: 27,
        rtoCount: 18,
        deliveryRate: 0.8967,
        rtoRate: 0.06,
        score: 82
      },
      update: {
        shipmentCount: 300,
        deliveredCount: 269,
        ndrCount: 27,
        rtoCount: 18,
        deliveryRate: 0.8967,
        rtoRate: 0.06,
        score: 82
      }
    });
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
