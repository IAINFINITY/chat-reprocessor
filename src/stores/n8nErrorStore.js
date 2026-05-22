import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

let MAX_EVENTS = 500;
let storeFilePath = path.resolve(process.cwd(), "data", "n8n-events.json");
let events = [];
const DEDUPE_WINDOW_MS = 20 * 60 * 1000;

function toLower(value) {
  return String(value || "").toLowerCase();
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

function ensureStoreDirectoryExists(filePath) {
  const dirPath = path.dirname(filePath);
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

function parseStoreFile(rawText) {
  try {
    const parsed = JSON.parse(String(rawText || ""));
    if (Array.isArray(parsed)) {
      return parsed;
    }

    if (Array.isArray(parsed?.events)) {
      return parsed.events;
    }

    return [];
  } catch {
    return [];
  }
}

function persistEvents() {
  ensureStoreDirectoryExists(storeFilePath);
  writeFileSync(
    storeFilePath,
    JSON.stringify(
      {
        version: 1,
        updated_at: new Date().toISOString(),
        total: events.length,
        events,
      },
      null,
      2,
    ),
    "utf8",
  );
}

function loadPersistedEvents() {
  try {
    if (!existsSync(storeFilePath)) {
      events = [];
      return;
    }

    const content = readFileSync(storeFilePath, "utf8");
    const parsedEvents = parseStoreFile(content)
      .filter((item) => item && typeof item === "object")
      .slice(0, MAX_EVENTS);
    events = parsedEvents;
  } catch {
    events = [];
  }
}

function appendEvent(event) {
  const dedupeKey = buildEventDedupeKey(event);
  if (dedupeKey) {
    const existingIndex = events.findIndex((item) => {
      if (buildEventDedupeKey(item) !== dedupeKey) {
        return false;
      }
      return isRecentEvent(item, DEDUPE_WINDOW_MS);
    });

    if (existingIndex >= 0) {
      const existing = events[existingIndex];
      const merged = {
        ...existing,
        ...event,
        received_at: event?.received_at || new Date().toISOString(),
        duplicate_count: Number(existing?.duplicate_count || 1) + 1,
      };
      events.splice(existingIndex, 1);
      events.unshift(merged);
      persistEvents();
      return merged;
    }
  }

  events.unshift({
    ...event,
    duplicate_count: Number(event?.duplicate_count || 1),
  });
  if (events.length > MAX_EVENTS) {
    events.length = MAX_EVENTS;
  }
  persistEvents();
  return events[0];
}

function stableEventText(value) {
  return String(value || "").trim().toLowerCase();
}

function buildEventDedupeKey(event) {
  const type = stableEventText(event?.event_type);
  const category = stableEventText(event?.category);
  const requestId = stableEventText(event?.request_id);
  const conversationId = stableEventText(event?.conversation_id);
  const client = stableEventText(event?.client);
  const executionId = stableEventText(event?.execution_id);
  const status = stableEventText(event?.status);
  const failedNode = stableEventText(event?.failed_node);
  const nodesExecuted = Number(event?.nodes_executed || 0) || 0;
  const cause = stableEventText(event?.likely_cause || event?.error_message || event?.error_description);

  if (requestId) {
    if (category === "n8n_execution_lookup_failed") {
      return `${type}|${category}|req:${requestId}`;
    }

    if (type === "execution") {
      return `${type}|${category}|req:${requestId}|status:${status}|exec:${executionId}|node:${failedNode}|nodes:${nodesExecuted}`;
    }

    if (type === "status") {
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
  let likelyCause = "Um no do workflow falhou durante a execucao.";
  let suggestion = "Abrir a execucao no n8n e verificar o no com erro.";

  if (combined.includes("insufficient_quota") || combined.includes("invalid_api_key")) {
    category = "openai_auth_or_quota";
    title = "OpenAI sem token/credito";
    likelyCause = "O no remoto reportou erro de autenticacao/quota da OpenAI.";
    suggestion = "Conferir token e faturamento da OpenAI no ambiente do fluxo.";
  } else if (combined.includes("variable") && combined.includes("not found")) {
    category = "workflow_variable_not_found";
    title = "Variavel ausente no fluxo";
    likelyCause = "O node tentou acessar uma variavel inexistente no contexto.";
    suggestion = "Revisar expressoes e variaveis no node com erro dentro do n8n.";
  } else if (combined.includes("dify")) {
    category = "dify_unavailable";
    title = "Dify indisponivel";
    likelyCause = "Falha de chamada do Dify no workflow.";
    suggestion = "Conferir endpoint, token e status do Dify.";
  } else if (combined.includes("supabase") && /(pause|paused|inativ|disabled)/.test(combined)) {
    category = "supabase_ai_paused";
    title = "IA pausada no Supabase";
    likelyCause = "Regra de negocio bloqueou execucao por IA pausada.";
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
  const normalized = {
    event_type: "execution",
    received_at: new Date().toISOString(),
    category: String(event?.category || "n8n_execution_status").trim(),
    title: String(event?.title || "Status da execucao n8n").trim(),
    likely_cause: String(event?.likely_cause || "Status da execucao atualizado via API do n8n.").trim(),
    suggestion: String(event?.suggestion || "Verificar detalhes da execucao no n8n.").trim(),
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

  return normalized;
}

function buildDispatchStatusEvent(input) {
  return {
    event_type: "status",
    received_at: new Date().toISOString(),
    category: "webhook_dispatched",
    title: "Payload enviado ao webhook",
    likely_cause: "Webhook recebeu a requisicao inicial de reprocessamento.",
    suggestion: "Aguardar retorno do fluxo ou consultar status da execucao no n8n.",
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

export function configureN8nEventStore({
  filePath,
  maxEvents,
} = {}) {
  if (filePath) {
    storeFilePath = path.resolve(process.cwd(), String(filePath));
  }

  const parsedMax = Number(maxEvents);
  if (Number.isInteger(parsedMax) && parsedMax > 0) {
    MAX_EVENTS = parsedMax;
  }

  loadPersistedEvents();
}

export function registerN8nErrorEvent(rawPayload) {
  const parsed = parseN8nErrorPayload(rawPayload);
  return appendEvent(parsed);
}

export function registerN8nStatusEvent(rawPayload) {
  const parsed = parseN8nStatusPayload(rawPayload);
  return appendEvent(parsed);
}

export function registerN8nExecutionEvent(payload) {
  const parsed = normalizeExecutionPayload(payload);
  return appendEvent(parsed);
}

export function registerWebhookDispatchEvent(payload) {
  const parsed = buildDispatchStatusEvent(payload || {});
  return appendEvent(parsed);
}

export function getLatestN8nErrorEvent({ client, conversationId, requestId } = {}) {
  const byClient = toLower(client);
  const byConversation = String(conversationId || "").trim();
  const byRequestId = String(requestId || "").trim();
  const maxAgeMs = 10 * 60 * 1000;

  const strictMatch =
    events.find((event) => {
      if (String(event?.event_type || "") !== "error") {
        return false;
      }

      if (byRequestId && String(event.request_id || "") !== byRequestId) {
        return false;
      }

      if (byConversation && String(event.conversation_id || "") !== byConversation) {
        return false;
      }

      if (byClient && toLower(event.client) !== byClient) {
        return false;
      }

      return true;
    }) || null;

  if (strictMatch) {
    return strictMatch;
  }

  const clientFallback =
    events.find((event) => {
      if (String(event?.event_type || "") !== "error") {
        return false;
      }

      if (!isRecentEvent(event, maxAgeMs)) {
        return false;
      }

      if (byClient && toLower(event.client) !== byClient) {
        return false;
      }

      return true;
    }) || null;

  if (clientFallback) {
    return clientFallback;
  }

  if (!byClient && !byConversation && !byRequestId) {
    return events.find((event) => String(event?.event_type || "") === "error") || null;
  }

  return null;
}

export function getLatestN8nStatusEvent({ client, conversationId, requestId } = {}) {
  const byClient = toLower(client);
  const byConversation = String(conversationId || "").trim();
  const byRequestId = String(requestId || "").trim();

  return (
    events.find((event) => {
      if (String(event?.event_type || "") !== "status") {
        return false;
      }

      if (byRequestId && String(event.request_id || "") !== byRequestId) {
        return false;
      }

      if (byConversation && String(event.conversation_id || "") !== byConversation) {
        return false;
      }

      if (byClient && toLower(event.client) !== byClient) {
        return false;
      }

      return true;
    }) || null
  );
}

export function getLatestN8nExecutionEvent({ client, conversationId, requestId } = {}) {
  const byClient = toLower(client);
  const byConversation = String(conversationId || "").trim();
  const byRequestId = String(requestId || "").trim();

  return (
    events.find((event) => {
      if (String(event?.event_type || "") !== "execution") {
        return false;
      }

      if (byRequestId && String(event.request_id || "") !== byRequestId) {
        return false;
      }

      if (byConversation && String(event.conversation_id || "") !== byConversation) {
        return false;
      }

      if (byClient && toLower(event.client) !== byClient) {
        return false;
      }

      return true;
    }) || null
  );
}

export function listRecentN8nEvents({ limit = 20, client } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit || 20), 100));
  const byClient = toLower(client);
  const source = byClient
    ? events.filter((event) => toLower(event.client) === byClient)
    : events;

  const deduped = [];
  const seen = new Set();

  for (const event of source) {
    const key = buildEventDedupeKey(event) || `${stableEventText(event?.event_type)}|${stableEventText(event?.category)}|${stableEventText(event?.received_at)}`;
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

configureN8nEventStore();
