import { PrismaClient } from "@prisma/client";

const globalKey = "__chatwootReprocessPrismaClient__";

function createPrismaClient() {
  return new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
}

export const prisma =
  globalThis[globalKey] ||
  createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis[globalKey] = prisma;
}

