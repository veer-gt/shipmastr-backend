import { prisma } from "../src/lib/prisma.js";

const merchants = await prisma.merchant.findMany({
  select: {
    id: true,
    name: true,
    createdAt: true,
  },
  take: 10,
  orderBy: {
    createdAt: "desc",
  },
});

console.log(JSON.stringify(merchants, null, 2));
await prisma.$disconnect();
