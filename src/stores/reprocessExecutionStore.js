import { prisma } from "../clients/prismaClient.js";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return Math.floor(n);
}

function toInt(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return null;
  }
  return Math.trunc(num);
}

function toClient(value) {
  return String(value || "").trim().toLowerCase() || "unknown";
}

function getInputPayload(input) {
  if (!input || typeof input !== "object") {
    return null;
  }
  const payload = Array.isArray(input.payload) ? input.payload[0] : input.payload;
  if (!payload || typeof payload !== "object") {
    return null;
  }
  return payload;
}

function getWebhookBody(input, result) {
  const payload = getInputPayload(input);
  if (payload && payload.body && typeof payload.body === "object") {
    return payload.body;
  }
  if (payload && typeof payload === "object") {
    return payload;
  }
  if (result && typeof result === "object" && result.payload && typeof result.payload === "object") {
    return result.payload;
  }
  return null;
}

function getWebhookUrl(input) {
  const payload = getInputPayload(input);
  return String(payload?.webhookUrl || "").trim() || null;
}

function extractPhone(webhookBody) {
  return (
    String(
      webhookBody?.meta?.sender?.phone_number ||
        webhookBody?.meta?.sender?.phone ||
        webhookBody?.messages?.[0]?.sender?.phone_number ||
        webhookBody?.phone ||
        "",
    ).trim() || null
  );
}

function toDbStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "success") {
    return "success";
  }
  if (normalized === "error" || normalized === "failed" || normalized === "crashed") {
    return "error";
  }
  if (normalized === "timeout") {
    return "timeout";
  }
  if (normalized === "canceled" || normalized === "cancelled" || normalized === "paused" || normalized === "skipped") {
    return "canceled";
  }
  if (normalized === "running" || normalized === "new" || normalized === "waiting") {
    return "running";
  }
  if (normalized === "pending") {
    return "pending";
  }
  if (normalized === "warning") {
    return "warning";
  }
  return "running";
}

export async function registerExecutionDispatch({ result, input }) {
  const requestId = String(result?.request_id || "").trim();
  if (!requestId) {
    return null;
  }

  const body = getWebhookBody(input, result);
  const conversationId = toInt(result?.conversation_id) ?? toInt(body?.conversation_id ?? body?.id);
  const contactId =
    toInt(result?.contact_id) ??
    toInt(body?.meta?.sender?.id) ??
    toInt(body?.messages?.[0]?.sender_id);
  const accountId = toInt(body?.messages?.[0]?.account_id) ?? toInt(body?.account_id);
  const client = toClient(result?.client || input?.client);
  const phone = extractPhone(body);
  const now = new Date();

  const record = await prisma.reprocessExecution.upsert({
    where: { requestId },
    create: {
      requestId,
      client,
      accountId,
      conversationId,
      contactId,
      phone,
      status: "running",
      webhookUrl: getWebhookUrl(input),
      startedAt: now,
      webhookResponse: {
        webhook_http_status: result?.webhook_http_status || null,
        message: String(result?.message || "").trim() || null,
      },
    },
    update: {
      client,
      accountId,
      conversationId,
      contactId,
      phone,
      status: "running",
      webhookUrl: getWebhookUrl(input),
      startedAt: now,
      webhookResponse: {
        webhook_http_status: result?.webhook_http_status || null,
        message: String(result?.message || "").trim() || null,
      },
      errorCode: null,
      errorMessage: null,
      finishedAt: null,
    },
  });

  return record;
}

export async function registerExecutionSkipped({ result, input }) {
  const body = getWebhookBody(input, result);
  const now = new Date();
  const record = await prisma.reprocessExecution.create({
    data: {
      requestId: null,
      client: toClient(result?.client || input?.client),
      accountId: toInt(body?.messages?.[0]?.account_id) ?? toInt(body?.account_id),
      conversationId: toInt(result?.conversation_id) ?? toInt(body?.conversation_id ?? body?.id),
      contactId:
        toInt(result?.contact_id) ??
        toInt(body?.meta?.sender?.id) ??
        toInt(body?.messages?.[0]?.sender_id),
      phone: extractPhone(body),
      status: "canceled",
      webhookUrl: getWebhookUrl(input),
      startedAt: now,
      finishedAt: now,
      errorCode: "paused",
      errorMessage: String(result?.message || "Contato pausado.").trim(),
      webhookResponse: {
        skipped: true,
        status: String(result?.status || "paused"),
      },
    },
  });
  return record;
}

export async function registerExecutionFailure({ input, formattedBody }) {
  const details = formattedBody?.details || {};
  const requestId = String(details?.request_id || "").trim();
  const body = getWebhookBody(input, formattedBody);
  const now = new Date();

  if (requestId) {
    return prisma.reprocessExecution.upsert({
      where: { requestId },
      create: {
        requestId,
        client: toClient(details?.client || input?.client),
        accountId: toInt(body?.messages?.[0]?.account_id) ?? toInt(body?.account_id),
        conversationId: toInt(details?.conversation_id) ?? toInt(body?.conversation_id ?? body?.id),
        contactId:
          toInt(details?.contact_id) ??
          toInt(body?.meta?.sender?.id) ??
          toInt(body?.messages?.[0]?.sender_id),
        phone: extractPhone(body),
        status: "error",
        webhookUrl: getWebhookUrl(input),
        startedAt: now,
        finishedAt: now,
        errorCode: String(formattedBody?.error || "webhook_request_error"),
        errorMessage: String(formattedBody?.message || "Falha no reprocessamento."),
      },
      update: {
        status: "error",
        finishedAt: now,
        errorCode: String(formattedBody?.error || "webhook_request_error"),
        errorMessage: String(formattedBody?.message || "Falha no reprocessamento."),
      },
    });
  }

  return prisma.reprocessExecution.create({
    data: {
      requestId: null,
      client: toClient(details?.client || input?.client),
      accountId: toInt(body?.messages?.[0]?.account_id) ?? toInt(body?.account_id),
      conversationId: toInt(details?.conversation_id) ?? toInt(body?.conversation_id ?? body?.id),
      contactId:
        toInt(details?.contact_id) ??
        toInt(body?.meta?.sender?.id) ??
        toInt(body?.messages?.[0]?.sender_id),
      phone: extractPhone(body),
      status: "error",
      webhookUrl: getWebhookUrl(input),
      startedAt: now,
      finishedAt: now,
      errorCode: String(formattedBody?.error || "webhook_request_error"),
      errorMessage: String(formattedBody?.message || "Falha no reprocessamento."),
    },
  });
}

export async function syncExecutionStatusFromN8nEvent(event) {
  const requestId = String(event?.request_id || "").trim();
  if (!requestId) {
    return null;
  }

  const status = toDbStatus(event?.status || event?.category);
  const isTerminal = status === "success" || status === "error" || status === "timeout" || status === "canceled";
  const now = new Date();

  return prisma.reprocessExecution.updateMany({
    where: { requestId },
    data: {
      status,
      finishedAt: isTerminal ? now : null,
      n8nExecutionId: String(event?.execution_id || "").trim() || undefined,
      n8nWorkflowName: String(event?.workflow_name || "").trim() || undefined,
      errorMessage:
        status === "error"
          ? String(event?.error_description || event?.error_message || event?.likely_cause || "").trim() || undefined
          : null,
    },
  });
}

export async function finalizeExecutionByRequestId({ requestId, status, message } = {}) {
  const safeRequestId = String(requestId || "").trim();
  if (!safeRequestId) {
    return { updated: 0 };
  }

  const nextStatus = toDbStatus(status);
  const isTerminal =
    nextStatus === "success" ||
    nextStatus === "error" ||
    nextStatus === "timeout" ||
    nextStatus === "canceled";

  const updated = await prisma.reprocessExecution.updateMany({
    where: { requestId: safeRequestId },
    data: {
      status: nextStatus,
      finishedAt: isTerminal ? new Date() : null,
      errorMessage:
        nextStatus === "error" || nextStatus === "canceled"
          ? String(message || "").trim() || undefined
          : null,
    },
  });

  return {
    updated: Number(updated?.count || 0),
    request_id: safeRequestId,
    status: nextStatus,
  };
}

export async function getReprocessDashboardStats() {
  const since = new Date(Date.now() - THIRTY_DAYS_MS);

  const [successCount, failedCount, pendingCount, activeClients] = await Promise.all([
    prisma.reprocessExecution.count({
      where: {
        createdAt: { gte: since },
        status: "success",
      },
    }),
    prisma.reprocessExecution.count({
      where: {
        createdAt: { gte: since },
        status: { in: ["error", "timeout"] },
      },
    }),
    prisma.reprocessExecution.count({
      where: {
        status: { in: ["pending", "running"] },
        finishedAt: null,
      },
    }),
    prisma.reprocessExecution.findMany({
      where: {
        createdAt: { gte: since },
      },
      distinct: ["client"],
      select: { client: true },
    }),
  ]);

  return {
    success_30d: successCount,
    failed_30d: failedCount,
    pending_now: pendingCount,
    active_clients_30d: activeClients.length,
  };
}

export async function listReprocessExecutions({ page = 1, perPage = 20 } = {}) {
  const safePage = toPositiveInt(page, 1);
  const safePerPage = Math.max(1, Math.min(toPositiveInt(perPage, 20), 100));
  const skip = (safePage - 1) * safePerPage;

  const [total, rows] = await Promise.all([
    prisma.reprocessExecution.count(),
    prisma.reprocessExecution.findMany({
      orderBy: { createdAt: "desc" },
      skip,
      take: safePerPage,
    }),
  ]);

  return {
    page: safePage,
    per_page: safePerPage,
    total,
    total_pages: Math.max(1, Math.ceil(total / safePerPage)),
    items: rows.map((row) => ({
      id: row.id,
      request_id: row.requestId || null,
      conversation_id: row.conversationId || null,
      client: row.client,
      status: row.status,
      created_at: row.createdAt ? row.createdAt.toISOString() : null,
      started_at: row.startedAt ? row.startedAt.toISOString() : null,
      finished_at: row.finishedAt ? row.finishedAt.toISOString() : null,
      duration_ms: row.durationMs || null,
      error_message: row.errorMessage || null,
    })),
  };
}

export async function listPendingExecutions({ limit = 100 } = {}) {
  const safeLimit = Math.max(1, Math.min(toPositiveInt(limit, 100), 300));
  const rows = await prisma.reprocessExecution.findMany({
    where: {
      status: { in: ["pending", "running"] },
      finishedAt: null,
    },
    orderBy: { createdAt: "desc" },
    take: safeLimit,
  });

  return rows.map((row) => ({
    id: row.id,
    request_id: row.requestId || null,
    conversation_id: row.conversationId || null,
    client: row.client,
    status: row.status,
    created_at: row.createdAt ? row.createdAt.toISOString() : null,
  }));
}

export async function cancelPendingExecutionById({ id, reason = "queue_removed_by_operator" } = {}) {
  const safeId = String(id || "").trim();
  if (!safeId) {
    return { updated: 0 };
  }

  const updated = await prisma.reprocessExecution.updateMany({
    where: {
      id: safeId,
      status: { in: ["pending", "running"] },
      finishedAt: null,
    },
    data: {
      status: "canceled",
      finishedAt: new Date(),
      errorCode: "queue_canceled",
      errorMessage: String(reason || "").trim() || "Execução cancelada no painel.",
    },
  });

  return {
    updated: Number(updated?.count || 0),
    id: safeId,
  };
}

export async function cancelAllPendingExecutions({ reason = "queue_cleared_by_operator" } = {}) {
  const updated = await prisma.reprocessExecution.updateMany({
    where: {
      status: { in: ["pending", "running"] },
      finishedAt: null,
    },
    data: {
      status: "canceled",
      finishedAt: new Date(),
      errorCode: "queue_cleared",
      errorMessage: String(reason || "").trim() || "Execuções pendentes canceladas no painel.",
    },
  });

  return {
    updated: Number(updated?.count || 0),
  };
}
