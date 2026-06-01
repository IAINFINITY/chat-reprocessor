import { prisma } from "../clients/prismaClient.js";

let MAX_EVENTS = 500;
const DEDUPE_WINDOW_MS = 20 * 60 * 1000;

function toLower(value) {
  return String(value || "").toLowerCase();
}

function normalizeClientAlias(value) {
  const normalized = toLower(value).trim();
  if (normalized === "clinic-") {
    return "clinic+";
  }
  return normalized;
}

function matchesClientFilter(eventClient, filterClient) {
  if (!String(filterClient || "").trim()) {
    return true;
  }
  return normalizeClientAlias(eventClient) === normalizeClientAlias(filterClient);
}

function parseTimestampMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function truncate(value, max = 1200) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function isRecentEvent(event, maxAgeMs) {
  if (!maxAgeMs || maxAgeMs <= 0) {
    return true;
  }

  const ts = parseTimestampMs(event?.received_at);
  if (!ts) {
    return true;
  }

  return Date.now() - ts <= maxAgeMs;
}

function stableEventText(value) {
  return String(value || "").trim().toLowerCase();
}

function buildEventDedupeKey(event) {
  const type = stableEventText(event?.event_type);
  const category = stableEventText(event?.category);
  const requestId = stableEventText(event?.request_id);
  const conversationId = stableEventText(event?.conversation_id);
  const client = stableEventText(normalizeClientAlias(event?.client));
  const executionId = stableEventText(event?.execution_id);
  const status = stableEventText(event?.status);
  const failedNode = stableEventText(event?.failed_node);
  const cause = stableEventText(event?.likely_cause || event?.error_message || event?.error_description);

  if (requestId) {
    if (category === "n8n_execution_lookup_failed") {
      return `${type}|${category}|req:${requestId}`;
    }

    if (category === "n8n_execution_not_found") {
      return `${type}|${category}|req:${requestId}`;
    }

    if (type === "execution") {
      return `${type}|${category}|req:${requestId}|status:${status}`;
    }

    if (type === "status") {
      if (category === "webhook_dispatched") {
        return `${type}|${category}|req:${requestId}`;
      }
      return `${type}|${category}|req:${requestId}|exec:${executionId}|cause:${cause}`;
    }

    return `${type}|${category}|req:${requestId}|exec:${executionId}|cause:${cause}`;
  }

  if (executionId) {
    return `${type}|${category}|exec:${executionId}|status:${status}|node:${failedNode}`;
  }

  if (conversationId && client) {
    return `${type}|${category}|conv:${conversationId}|client:${client}|cause:${cause}`;
  }

  return "";
}

function parseN8nErrorPayload(input) {
  const rootPayload = Array.isArray(input) ? input[0] : input;
  const payload =
    rootPayload?.body &&
    typeof rootPayload.body === "object" &&
    !Array.isArray(rootPayload.body) &&
    !rootPayload?.execution &&
    !rootPayload?.workflow
      ? rootPayload.body
      : rootPayload;
  const execution = payload?.execution || payload?.trigger?.error?.execution || {};
  const workflow = payload?.workflow || {};
  const error = execution?.error || payload?.trigger?.error || {};
  const ctx = error?.context || {};
  const request = ctx?.request || {};
  const reqHeaders = request?.headers || {};
  const reqBody = request?.body || {};

  const description = String(error?.description || "");
  const message = String(error?.message || "");
  const messagesArray = Array.isArray(error?.messages) ? error.messages : [];
  const combined = `${message}\n${description}\n${messagesArray.join("\n")}`.toLowerCase();

  let category = "n8n_node_error";
  let title = "Erro no fluxo n8n";
  let likelyCause = "Um nó do workflow falhou durante a execução.";
  let suggestion = "Abrir a execução no n8n e verificar o nó com erro.";

  if (combined.includes("insufficient_quota") || combined.includes("invalid_api_key")) {
    category = "openai_auth_or_quota";
    title = "OpenAI sem token/crédito";
    likelyCause = "O nó remoto reportou erro de autenticação/quota da OpenAI.";
    suggestion = "Conferir token e faturamento da OpenAI no ambiente do fluxo.";
  } else if (combined.includes("variable") && combined.includes("not found")) {
    category = "workflow_variable_not_found";
    title = "Variável ausente no fluxo";
    likelyCause = "O node tentou acessar uma variável inexistente no contexto.";
    suggestion = "Revisar expressões e variáveis no node com erro dentro do n8n.";
  } else if (combined.includes("dify")) {
    category = "dify_unavailable";
    title = "Dify indisponível";
    likelyCause = "Falha de chamada do Dify no workflow.";
    suggestion = "Conferir endpoint, token e status do Dify.";
  } else if (combined.includes("supabase") && /(pause|paused|inativ|disabled)/.test(combined)) {
    category = "supabase_ai_paused";
    title = "IA pausada no Supabase";
    likelyCause = "Regra de negócio bloqueou execução por IA pausada.";
    suggestion = "Reativar IA no Supabase e testar novamente.";
  }

  return {
    event_type: "error",
    received_at: new Date().toISOString(),
    category,
    title,
    likely_cause: likelyCause,
    suggestion,
    workflow_name: workflow?.name || null,
    workflow_id: workflow?.id || null,
    execution_id: execution?.id || null,
    execution_url: execution?.url || null,
    failed_node: execution?.lastNodeExecuted || error?.node?.name || null,
    n8n_http_code: error?.httpCode || null,
    error_message: truncate(message, 600),
    error_description: truncate(description, 900),
    upstream_messages: messagesArray.slice(0, 3),
    request_id: reqHeaders?.["x-request-id"] || reqHeaders?.["X-Request-Id"] || null,
    conversation_id: reqBody?.conversation_id || null,
    client: payload?.client || null,
  };
}

function parseN8nStatusPayload(input) {
  const rootPayload = Array.isArray(input) ? input[0] : input;
  const payload =
    rootPayload?.body &&
    typeof rootPayload.body === "object" &&
    !Array.isArray(rootPayload.body) &&
    !rootPayload?.execution &&
    !rootPayload?.workflow
      ? rootPayload.body
      : rootPayload;

  const statusKey = String(payload?.status_key || payload?.category || "flow_status").trim().toLowerCase();
  const statusTitle = String(payload?.status_title || payload?.title || "Status do fluxo n8n").trim();
  const statusMessage = String(
    payload?.status_message || payload?.likely_cause || payload?.message || "Evento de status recebido do fluxo.",
  ).trim();
  const suggestion = String(payload?.suggestion || payload?.next_step || "Verificar o fluxo no n8n.").trim();

  return {
    event_type: "status",
    received_at: new Date().toISOString(),
    category: statusKey || "flow_status",
    title: statusTitle || "Status do fluxo n8n",
    likely_cause: statusMessage,
    suggestion,
    workflow_name: payload?.workflow_name || payload?.workflow?.name || null,
    workflow_id: payload?.workflow_id || payload?.workflow?.id || null,
    execution_id: payload?.execution_id || payload?.execution?.id || null,
    execution_url: payload?.execution_url || payload?.execution?.url || null,
    failed_node: payload?.node_name || payload?.node || null,
    n8n_http_code: payload?.http_code || null,
    error_message: null,
    error_description: null,
    upstream_messages: [],
    request_id: payload?.request_id || null,
    conversation_id: payload?.conversation_id || null,
    client: payload?.client || null,
  };
}

function normalizeExecutionPayload(event) {
  return {
    event_type: "execution",
    received_at: new Date().toISOString(),
    category: String(event?.category || "n8n_execution_status").trim(),
    title: String(event?.title || "Status da execução n8n").trim(),
    likely_cause: String(event?.likely_cause || "Status da execução atualizado via API do n8n.").trim(),
    suggestion: String(event?.suggestion || "Verificar detalhes da execução no n8n.").trim(),
    workflow_name: event?.workflow_name || null,
    workflow_id: event?.workflow_id || null,
    execution_id: event?.execution_id || null,
    execution_url: event?.execution_url || null,
    failed_node: event?.failed_node || null,
    n8n_http_code: event?.n8n_http_code || null,
    error_message: event?.error_message || null,
    error_description: event?.error_description || null,
    upstream_messages: Array.isArray(event?.upstream_messages) ? event.upstream_messages.slice(0, 3) : [],
    request_id: event?.request_id || null,
    conversation_id: event?.conversation_id || null,
    client: event?.client || null,
    status: event?.status || null,
    nodes_executed: Number(event?.nodes_executed || 0) || 0,
    source: event?.source || "n8n_api_poll",
  };
}

function buildDispatchStatusEvent(input) {
  return {
    event_type: "status",
    received_at: new Date().toISOString(),
    category: "webhook_dispatched",
    title: "Payload enviado ao webhook",
    likely_cause: "Webhook recebeu a requisição inicial de reprocessamento.",
    suggestion: "Aguardar retorno do fluxo ou consultar status da execução no n8n.",
    workflow_name: null,
    workflow_id: null,
    execution_id: null,
    execution_url: null,
    failed_node: null,
    n8n_http_code: input?.httpStatusCode || null,
    error_message: null,
    error_description: null,
    upstream_messages: [],
    request_id: input?.request_id || null,
    conversation_id: input?.conversation_id || null,
    client: input?.client || null,
  };
}

function toPrismaEventType(value) {
  const safe = String(value || "").trim().toLowerCase();
  if (safe === "error") {
    return "error";
  }
  if (safe === "status") {
    return "status";
  }
  return "execution";
}

function mapToPrismaData(event) {
  return {
    eventType: toPrismaEventType(event.event_type),
    category: String(event.category || "").trim() || "n8n_event",
    title: String(event.title || "").trim() || "Evento n8n",
    likelyCause: event.likely_cause || null,
    suggestion: event.suggestion || null,
    workflowName: event.workflow_name || null,
    workflowId: event.workflow_id || null,
    executionId: event.execution_id || null,
    executionUrl: event.execution_url || null,
    failedNode: event.failed_node || null,
    requestId: event.request_id || null,
    conversationId: event.conversation_id ? String(event.conversation_id) : null,
    client: event.client ? normalizeClientAlias(event.client) : null,
    status: event.status || null,
    nodesExecuted: Number(event.nodes_executed || 0) || 0,
    n8nHttpCode: event.n8n_http_code ? String(event.n8n_http_code) : null,
    errorMessage: event.error_message || null,
    errorDescription: event.error_description || null,
    upstreamMessages: Array.isArray(event.upstream_messages) ? event.upstream_messages : [],
    source: event.source || null,
    receivedAt: new Date(event.received_at || Date.now()),
  };
}

function mapFromPrismaRow(row) {
  return {
    id: row.id,
    event_type: row.eventType,
    received_at: row.receivedAt ? row.receivedAt.toISOString() : new Date().toISOString(),
    category: row.category,
    title: row.title,
    likely_cause: row.likelyCause,
    suggestion: row.suggestion,
    workflow_name: row.workflowName,
    workflow_id: row.workflowId,
    execution_id: row.executionId,
    execution_url: row.executionUrl,
    failed_node: row.failedNode,
    request_id: row.requestId,
    conversation_id: row.conversationId,
    client: row.client,
    status: row.status,
    nodes_executed: row.nodesExecuted || 0,
    n8n_http_code: row.n8nHttpCode,
    error_message: row.errorMessage,
    error_description: row.errorDescription,
    upstream_messages: Array.isArray(row.upstreamMessages) ? row.upstreamMessages : [],
    source: row.source,
    duplicate_count: Number(row.duplicateCount || 1),
  };
}

async function trimOldEvents() {
  const rows = await prisma.n8nEvent.findMany({
    orderBy: { receivedAt: "desc" },
    select: { id: true },
    skip: MAX_EVENTS,
  });
  if (rows.length > 0) {
    await prisma.n8nEvent.deleteMany({
      where: {
        id: { in: rows.map((item) => item.id) },
      },
    });
  }
}

async function findDedupeCandidate(event) {
  const minDate = new Date(Date.now() - DEDUPE_WINDOW_MS);
  const where = {
    eventType: toPrismaEventType(event.event_type),
    receivedAt: { gte: minDate },
  };

  if (event.request_id) {
    where.requestId = String(event.request_id);
  } else if (event.execution_id) {
    where.executionId = String(event.execution_id);
  } else if (event.conversation_id && event.client) {
    where.conversationId = String(event.conversation_id);
    where.client = normalizeClientAlias(event.client);
  }

  const candidates = await prisma.n8nEvent.findMany({
    where,
    orderBy: { receivedAt: "desc" },
    take: 100,
  });

  const targetKey = buildEventDedupeKey(event);
  if (!targetKey) {
    return null;
  }

  for (const candidate of candidates) {
    const mapped = mapFromPrismaRow(candidate);
    if (buildEventDedupeKey(mapped) === targetKey && isRecentEvent(mapped, DEDUPE_WINDOW_MS)) {
      return candidate;
    }
  }
  return null;
}

async function appendEvent(event) {
  const dedupeCandidate = await findDedupeCandidate(event);
  if (dedupeCandidate) {
    const updated = await prisma.n8nEvent.update({
      where: { id: dedupeCandidate.id },
      data: {
        ...mapToPrismaData(event),
        duplicateCount: Number(dedupeCandidate.duplicateCount || 1) + 1,
      },
    });
    return mapFromPrismaRow(updated);
  }

  const created = await prisma.n8nEvent.create({
    data: {
      ...mapToPrismaData(event),
      duplicateCount: Number(event?.duplicate_count || 1),
    },
  });
  await trimOldEvents();
  return mapFromPrismaRow(created);
}

export function configureN8nEventStore({ maxEvents } = {}) {
  const parsedMax = Number(maxEvents);
  if (Number.isInteger(parsedMax) && parsedMax > 0) {
    MAX_EVENTS = parsedMax;
  }
}

export async function registerN8nErrorEvent(rawPayload) {
  const parsed = parseN8nErrorPayload(rawPayload);
  return appendEvent(parsed);
}

export async function registerN8nStatusEvent(rawPayload) {
  const parsed = parseN8nStatusPayload(rawPayload);
  return appendEvent(parsed);
}

export async function registerN8nExecutionEvent(payload) {
  const parsed = normalizeExecutionPayload(payload);
  return appendEvent(parsed);
}

export async function registerWebhookDispatchEvent(payload) {
  const parsed = buildDispatchStatusEvent(payload || {});
  return appendEvent(parsed);
}

export async function getLatestN8nErrorEvent({ client, conversationId, requestId } = {}) {
  const byClient = normalizeClientAlias(client);
  const byConversation = String(conversationId || "").trim();
  const byRequestId = String(requestId || "").trim();
  const maxAgeMs = 10 * 60 * 1000;

  const strict = await prisma.n8nEvent.findFirst({
    where: {
      eventType: "error",
      ...(byRequestId ? { requestId: byRequestId } : {}),
      ...(byConversation ? { conversationId: byConversation } : {}),
      ...(byClient ? { client: byClient } : {}),
    },
    orderBy: { receivedAt: "desc" },
  });
  if (strict) {
    return mapFromPrismaRow(strict);
  }

  if (byClient) {
    const fallback = await prisma.n8nEvent.findMany({
      where: {
        eventType: "error",
        client: byClient,
      },
      orderBy: { receivedAt: "desc" },
      take: 30,
    });
    const mapped = fallback.map(mapFromPrismaRow).find((item) => isRecentEvent(item, maxAgeMs)) || null;
    if (mapped) {
      return mapped;
    }
  }

  if (!byClient && !byConversation && !byRequestId) {
    const lastError = await prisma.n8nEvent.findFirst({
      where: { eventType: "error" },
      orderBy: { receivedAt: "desc" },
    });
    return lastError ? mapFromPrismaRow(lastError) : null;
  }

  return null;
}

export async function getLatestN8nStatusEvent({ client, conversationId, requestId } = {}) {
  const byClient = normalizeClientAlias(client);
  const byConversation = String(conversationId || "").trim();
  const byRequestId = String(requestId || "").trim();

  const row = await prisma.n8nEvent.findFirst({
    where: {
      eventType: "status",
      ...(byRequestId ? { requestId: byRequestId } : {}),
      ...(byConversation ? { conversationId: byConversation } : {}),
      ...(byClient ? { client: byClient } : {}),
    },
    orderBy: { receivedAt: "desc" },
  });
  return row ? mapFromPrismaRow(row) : null;
}

export async function getLatestN8nExecutionEvent({ client, conversationId, requestId } = {}) {
  const byClient = normalizeClientAlias(client);
  const byConversation = String(conversationId || "").trim();
  const byRequestId = String(requestId || "").trim();

  const row = await prisma.n8nEvent.findFirst({
    where: {
      eventType: "execution",
      ...(byRequestId ? { requestId: byRequestId } : {}),
      ...(byConversation ? { conversationId: byConversation } : {}),
      ...(byClient ? { client: byClient } : {}),
    },
    orderBy: { receivedAt: "desc" },
  });
  return row ? mapFromPrismaRow(row) : null;
}

export async function listRecentN8nEvents({ limit = 20, client, requestId, conversationId } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit || 20), 100));
  const byClient = normalizeClientAlias(client);
  const byRequestId = String(requestId || "").trim();
  const byConversationId = String(conversationId || "").trim();
  const where = {
    ...(byClient ? { client: byClient } : {}),
    ...(byRequestId ? { requestId: byRequestId } : {}),
    ...(byConversationId ? { conversationId: byConversationId } : {}),
  };

  const rows = await prisma.n8nEvent.findMany({
    where,
    orderBy: { receivedAt: "desc" },
    take: Math.max(safeLimit * 4, 120),
  });

  const source = rows.map(mapFromPrismaRow);
  const deduped = [];
  const seen = new Set();

  for (const event of source) {
    const key =
      buildEventDedupeKey(event) ||
      `${stableEventText(event?.event_type)}|${stableEventText(event?.category)}|${stableEventText(event?.received_at)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(event);
    if (deduped.length >= safeLimit) {
      break;
    }
  }

  return deduped;
}
