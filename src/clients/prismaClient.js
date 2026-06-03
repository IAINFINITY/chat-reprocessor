import { PrismaClient } from "@prisma/client";

const globalKey = "__chatwootReprocessPrismaClient__";

function ensureQueryParam(url, key, value) {
  const rawUrl = String(url || "").trim();
  if (!rawUrl) {
    return rawUrl;
  }

  try {
    const parsed = new URL(rawUrl);
    if (!parsed.searchParams.has(key)) {
      parsed.searchParams.set(key, String(value));
    }
    return parsed.toString();
  } catch {
    const hasQuery = rawUrl.includes("?");
    const separator = hasQuery ? "&" : "?";
    return rawUrl.includes(`${key}=`) ? rawUrl : `${rawUrl}${separator}${key}=${encodeURIComponent(String(value))}`;
  }
}

function resolveDatasourceUrl() {
  const baseUrl = String(process.env.DATABASE_URL || "").trim();
  if (!baseUrl) {
    return baseUrl;
  }

  const withConnectionLimit = ensureQueryParam(baseUrl, "connection_limit", 1);
  return ensureQueryParam(withConnectionLimit, "pool_timeout", 20);
}

function createPrismaClient() {
  return new PrismaClient({
    datasources: {
      db: {
        url: resolveDatasourceUrl(),
      },
    },
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
}

export const prisma =
  globalThis[globalKey] ||
  createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis[globalKey] = prisma;
}
