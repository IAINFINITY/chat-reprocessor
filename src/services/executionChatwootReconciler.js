import { prisma } from "../clients/prismaClient.js";
import { createChatwootClient } from "../clients/chatwootClient.js";
import { finalizeExecutionByRequestId } from "../stores/reprocessExecutionStore.js";

const DEFAULT_LOOKUP_LIMIT = 8;
const RECONCILE_COOLDOWN_MS = 10000;

let lastReconcileAt = 0;
let inflightReconcile = null;

function toInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return Math.trunc(n);
}

function isOutgoingMessage(message) {
  if (!message || typeof message !== "object") {
    return false;
  }

  const messageType = Number(message?.message_type);
  const direction = String(message?.direction || "").trim().toLowerCase();
  const senderType = String(message?.sender_type || message?.sender?.type || "").trim().toLowerCase();

  return messageType === 1 || direction === "outbound" || senderType === "user" || senderType === "agent";
}

function getMessageTimestampMs(message) {
  const createdAt = Number(message?.created_at || 0);
  if (!Number.isFinite(createdAt) || createdAt <= 0) {
    return 0;
  }
  return createdAt * 1000;
}

function hasChatwootReturnAfterStartedAt(messages, startedAtMs) {
  const rows = Array.isArray(messages) ? messages : [];
  if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) {
    return false;
  }

  return rows.some((message) => isOutgoingMessage(message) && getMessageTimestampMs(message) >= startedAtMs);
}

async function reconcileOnce(config, limit) {
  const reconcileId = `chatwoot-reconcile-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const baseUrl = String(config?.chatwootBaseUrl || "").trim();
  const apiAccessToken = String(config?.chatwootApiToken || "").trim();

  if (!baseUrl || !apiAccessToken) {
    return {
      reconcile_id: reconcileId,
      updated: 0,
      updated_request_ids: [],
      inspected: 0,
      skipped: "chatwoot_not_configured",
    };
  }

  const safeLimit = Math.max(1, Math.min(toInt(limit, DEFAULT_LOOKUP_LIMIT), 20));
  const client = createChatwootClient({
    baseUrl,
    apiAccessToken,
  });

  const candidates = await prisma.reprocessExecution.findMany({
    where: {
      status: { in: ["pending", "running"] },
      finishedAt: null,
      requestId: { not: null },
      accountId: { not: null },
      conversationId: { not: null },
      startedAt: { not: null },
    },
    orderBy: {
      updatedAt: "asc",
    },
    take: safeLimit,
  });

  let updated = 0;
  const updatedRequestIds = [];

  for (const execution of candidates) {
    const startedAtMs = execution?.startedAt ? execution.startedAt.getTime() : 0;
    if (!startedAtMs) {
      continue;
    }

    try {
      const messagesResponse = await client.getConversationMessages(
        Number(execution.accountId),
        Number(execution.conversationId),
      );
      const messages = Array.isArray(messagesResponse?.payload) ? messagesResponse.payload : [];

      if (!hasChatwootReturnAfterStartedAt(messages, startedAtMs)) {
        continue;
      }

      const result = await finalizeExecutionByRequestId({
        requestId: execution.requestId,
        status: "success",
        message: "Retorno confirmado no Chatwoot.",
      });

      if (Number(result?.updated || 0) > 0) {
        updated += 1;
        updatedRequestIds.push(String(execution.requestId || "").trim());
      }
    } catch {
      continue;
    }
  }

  return {
    reconcile_id: reconcileId,
    updated,
    updated_request_ids: updatedRequestIds,
    inspected: candidates.length,
    skipped: null,
  };
}

export async function reconcileOpenExecutionsWithChatwoot(config, limit) {
  const now = Date.now();
  if (inflightReconcile) {
    return inflightReconcile;
  }

  if (now - lastReconcileAt < RECONCILE_COOLDOWN_MS) {
    return {
      reconcile_id: `chatwoot-reconcile-cooldown-${Math.floor(now / RECONCILE_COOLDOWN_MS)}`,
      updated: 0,
      updated_request_ids: [],
      inspected: 0,
      skipped: "cooldown",
    };
  }

  inflightReconcile = reconcileOnce(config, limit)
    .finally(() => {
      lastReconcileAt = Date.now();
      inflightReconcile = null;
    });

  return inflightReconcile;
}
