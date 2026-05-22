import { createChatwootClient } from "../clients/chatwootClient.js";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { extractIdsFromChatUrl } from "../domain/idParser.js";
import { buildReplayPayload, buildWebhookLikeBody } from "../domain/normalize.js";
import { createOpenAiClient } from "../clients/openaiClient.js";
import {
  detectReprocessClientByAccountId,
  detectReprocessClientByAccountName,
  getReprocessClient,
} from "../domain/reprocessClients.js";
import { getWebhookHeaderTemplate } from "../domain/webhookResolver.js";
import { buildMergedUserText } from "../services/messageEnricher.js";
import { checkClientPauseStatus } from "../services/pauseChecker.js";

export class ReprocessApiError extends Error {
  constructor(code, message, statusCode = 400, details = null) {
    super(message);
    this.name = "ReprocessApiError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function fail(code, message, statusCode = 400, details = null) {
  throw new ReprocessApiError(code, message, statusCode, details);
}

function ensureChatwootHostMatches(conversationUrl, configuredBaseUrl) {
  let conversationHost;
  let configuredHost;

  try {
    conversationHost = new URL(conversationUrl).host;
    configuredHost = new URL(configuredBaseUrl).host;
  } catch {
    return;
  }

  if (conversationHost !== configuredHost) {
    fail(
      "link_invalid_host",
      `O link informado pertence ao host '${conversationHost}', mas o backend esta configurado para '${configuredHost}'.`,
      400,
    );
  }
}

function extractConversationIdentity(conversationUrl, configuredBaseUrl) {
  const parsed = extractIdsFromChatUrl(conversationUrl);

  if (!parsed.accountId || !parsed.conversationId) {
    fail(
      "invalid_link",
      "Link invalido. Informe uma URL no formato .../accounts/{account_id}/conversations/{conversation_id}.",
      400,
    );
  }

  ensureChatwootHostMatches(conversationUrl, configuredBaseUrl);

  return {
    accountId: Number(parsed.accountId),
    conversationId: Number(parsed.conversationId),
  };
}

function mergeConversationMessages(conversation, messagesResponse, accountId, conversationId) {
  const fromConversation = Array.isArray(conversation?.messages) ? conversation.messages : [];
  const fromMessagesApi = Array.isArray(messagesResponse?.payload) ? messagesResponse.payload : [];
  const byId = new Map();

  for (const message of [...fromMessagesApi, ...fromConversation]) {
    const id = Number(message?.id || 0);
    const normalized = {
      ...message,
      id: id || null,
      account_id: Number(message?.account_id || accountId),
      conversation_id: Number(message?.conversation_id || conversationId),
      created_at: Number(message?.created_at || 0),
    };

    if (id) {
      byId.set(id, { ...(byId.get(id) || {}), ...normalized });
      continue;
    }

    byId.set(`local-${byId.size}`, normalized);
  }

  return [...byId.values()];
}

function isUserMessage(message) {
  const senderType = String(message?.sender_type || message?.sender?.type || "").toLowerCase();
  const messageType = Number(message?.message_type);
  const isPrivate = Boolean(message?.private);

  if (isPrivate) {
    return false;
  }

  return messageType === 0 || senderType === "contact";
}

function pickLatestMessage(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }

  const sorted = [...messages].sort((left, right) => {
    const byCreatedAt = Number(right?.created_at || 0) - Number(left?.created_at || 0);
    if (byCreatedAt !== 0) {
      return byCreatedAt;
    }

    return Number(right?.id || 0) - Number(left?.id || 0);
  });

  return sorted[0];
}

function pickLatestUserMessage(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }

  const sorted = [...messages].sort((left, right) => {
    const byCreatedAt = Number(right?.created_at || 0) - Number(left?.created_at || 0);
    if (byCreatedAt !== 0) {
      return byCreatedAt;
    }

    return Number(right?.id || 0) - Number(left?.id || 0);
  });

  return sorted.find((message) => isUserMessage(message)) || null;
}

function pickContact(conversation, messagesResponse, latestMessage) {
  if (conversation?.meta?.sender) {
    return conversation.meta.sender;
  }

  const contactPayload = conversation?.meta?.contact?.payload;
  if (Array.isArray(contactPayload) && contactPayload.length > 0) {
    return contactPayload[0];
  }

  if (messagesResponse?.meta?.contact) {
    return messagesResponse.meta.contact;
  }

  if (conversation?.contact) {
    return conversation.contact;
  }

  if (latestMessage?.sender) {
    return latestMessage.sender;
  }

  return null;
}

function parseClientSelection(clientInput, accountId, accountName = null) {
  const selectedClient = getReprocessClient(clientInput);
  if (selectedClient) {
    return selectedClient;
  }

  if (clientInput) {
    fail(
      "client_not_configured",
      `Cliente '${clientInput}' nao encontrado no arquivo empresas.json.`,
      400,
    );
  }

  const detectedClient = detectReprocessClientByAccountId(accountId);
  if (detectedClient) {
    return detectedClient;
  }

  const detectedByName = detectReprocessClientByAccountName(accountName);
  if (detectedByName) {
    return detectedByName;
  }

  fail(
    "client_required",
    "Nao foi possivel detectar o cliente por account_id. Selecione um cliente explicitamente.",
    400,
  );
}

function mapChatwootError(error) {
  const message = String(error?.message || "");

  if (message.includes("retornou 404")) {
    return new ReprocessApiError(
      "conversation_not_found",
      "Conversa nao encontrada no Chatwoot para os IDs informados.",
      404,
    );
  }

  return new ReprocessApiError(
    "chatwoot_request_error",
    `Erro ao consultar Chatwoot: ${message || "falha nao identificada"}`,
    502,
  );
}

function parseJsonSafe(rawText) {
  try {
    return JSON.parse(String(rawText || ""));
  } catch {
    return null;
  }
}

function truncateText(value, max = 600) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function pickUpstreamMessage(parsedBody, rawBody) {
  if (!parsedBody || typeof parsedBody !== "object") {
    return truncateText(rawBody, 500);
  }

  const messageCandidates = [
    parsedBody.message,
    parsedBody.error?.message,
    parsedBody.error_description,
    parsedBody.description,
    parsedBody.reason,
    parsedBody.error,
  ];

  const first = messageCandidates.find((item) => typeof item === "string" && item.trim().length > 0);
  if (first) {
    return truncateText(first, 500);
  }

  return truncateText(rawBody, 500);
}

function classifyWebhookFailure({ statusCode, responseBody }) {
  const parsed = parseJsonSafe(responseBody);
  const upstreamMessage = pickUpstreamMessage(parsed, responseBody);
  const normalized = `${statusCode} ${upstreamMessage}`.toLowerCase();

  let category = "upstream_workflow_error";
  let title = "Erro no workflow remoto";
  let likelyCause =
    "O n8n recebeu a chamada, mas ocorreu erro interno durante o processamento do fluxo.";
  let suggestion =
    "Verifique no n8n qual no falhou nessa execucao e ajuste tratamento/fallback do fluxo.";

  if (normalized.includes("supabase") && /(pause|paused|suspend|inativ|disabled)/.test(normalized)) {
    category = "supabase_ai_paused";
    title = "Supabase/IA pausada";
    likelyCause = "O fluxo indica que a automacao/IA no Supabase esta pausada ou indisponivel.";
    suggestion = "Reativar o status da IA no Supabase e testar novamente.";
  } else if (
    normalized.includes("variable") &&
    normalized.includes("not found")
  ) {
    category = "workflow_variable_not_found";
    title = "Variavel ausente no fluxo";
    likelyCause = "O fluxo tentou usar uma variavel que nao existe no contexto desta execucao.";
    suggestion = "Revisar o node com erro e validar nomes/caminhos de variaveis no n8n.";
  } else if (normalized.includes("dify") && /(unavailable|timeout|refused|down|503|504|502|failed)/.test(normalized)) {
    category = "dify_unavailable";
    title = "Dify indisponivel";
    likelyCause = "O workflow nao conseguiu acessar o Dify (queda, timeout ou indisponibilidade).";
    suggestion = "Validar status do Dify e conectividade do ambiente n8n para o endpoint do Dify.";
  } else if (
    normalized.includes("openai") &&
    /(invalid_api_key|api key|unauthorized|401|insufficient_quota|quota|billing|credit)/.test(normalized)
  ) {
    category = "openai_auth_or_quota";
    title = "OpenAI sem token/credito";
    likelyCause = "Erro de autenticacao ou de quota/credito da OpenAI no fluxo remoto.";
    suggestion = "Conferir chave da OpenAI no n8n e saldo/quota da conta.";
  } else if (statusCode === 404) {
    category = "webhook_not_found";
    title = "Webhook nao encontrado";
    likelyCause = "A URL de webhook pode estar incorreta, desativada ou removida no n8n.";
    suggestion = "Validar URL em empresas.json e confirmar que o workflow/webhook esta ativo.";
  } else if (statusCode === 401 || statusCode === 403) {
    category = "webhook_auth_error";
    title = "Falha de autenticacao no webhook";
    likelyCause = "O webhook rejeitou a chamada por token/header invalido.";
    suggestion = "Conferir headers de secret/HMAC esperados pelo workflow.";
  }

  return {
    category,
    title,
    likely_cause: likelyCause,
    suggestion,
    status_code: statusCode,
    upstream_message: upstreamMessage,
    upstream_body_excerpt: truncateText(responseBody, 1200),
  };
}

function detectLogicalFailureInSuccessResponse(responseText) {
  const parsed = parseJsonSafe(responseText);
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const statusFromBody = Number(parsed?.status || parsed?.status_code || parsed?.error?.status || 0);
  const code = String(parsed?.code || parsed?.error?.code || "").toLowerCase();
  const message = String(
    parsed?.message || parsed?.error?.message || parsed?.description || "",
  ).toLowerCase();
  const successFlag = parsed?.success;

  if (statusFromBody >= 400) {
    return {
      statusCode: statusFromBody,
      reason: "status_code_in_body",
    };
  }

  if (successFlag === false) {
    return {
      statusCode: 422,
      reason: "success_false_in_body",
    };
  }

  if (code && /(invalid_param|error|failed|fail|exception)/.test(code)) {
    return {
      statusCode: 422,
      reason: "error_code_in_body",
    };
  }

  if (/run failed|variable .* not found|bad request|invalid_param/.test(message)) {
    return {
      statusCode: 422,
      reason: "error_message_in_body",
    };
  }

  return null;
}

function classifyNetworkFailure(error, timeoutMs) {
  const isTimeout = error?.name === "AbortError";
  const code = error?.code || error?.cause?.code || "";
  const causeMessage = error?.cause?.message || error?.message || "falha de rede";
  const normalized = `${code} ${causeMessage}`.toLowerCase();

  let category = "network_error";
  let title = "Falha de rede ao chamar webhook";
  let likelyCause = "Nao foi possivel estabelecer comunicacao com o endpoint remoto.";
  let suggestion = "Validar DNS/rede/firewall e disponibilidade do dominio do webhook.";

  if (isTimeout) {
    category = "network_timeout";
    title = "Timeout na chamada do webhook";
    likelyCause = `O endpoint nao respondeu dentro de ${timeoutMs}ms.`;
    suggestion = "Aumentar timeout ou ajustar o workflow para responder mais rapido.";
  } else if (normalized.includes("enotfound") || normalized.includes("eai_again")) {
    category = "dns_resolution_error";
    title = "Falha de DNS";
    likelyCause = "O host do webhook nao foi resolvido neste ambiente.";
    suggestion = "Checar DNS/rede local e disponibilidade do dominio.";
  } else if (normalized.includes("econnrefused")) {
    category = "connection_refused";
    title = "Conexao recusada";
    likelyCause = "O host respondeu recusando conexao na porta alvo.";
    suggestion = "Verificar se o servico de destino esta ativo e aceitando conexoes HTTPS.";
  } else if (normalized.includes("econnreset") || normalized.includes("socket")) {
    category = "connection_reset";
    title = "Conexao encerrada pelo servidor";
    likelyCause = "A conexao foi encerrada no meio da requisicao (proxy/WAF/upstream).";
    suggestion = "Verificar logs do Cloudflare/proxy/n8n para reset de conexao.";
  }

  return {
    category,
    title,
    likely_cause: likelyCause,
    suggestion,
    error_code: code || null,
    error_message: String(error?.message || "erro de rede"),
    error_cause: causeMessage,
    is_timeout: isTimeout,
  };
}

function getRawConversationUrl(input) {
  return String(input?.conversationUrl || input?.conversation_url || input?.chat_url || "").trim();
}

function getClientInput(input) {
  return String(input?.client || "").trim().toLowerCase();
}

function getMessageCountInput(input) {
  const raw = Number(input?.messageCount ?? input?.message_count ?? 1);

  if (!Number.isFinite(raw) || raw <= 0) {
    return 1;
  }

  return Math.min(Math.floor(raw), 20);
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function shouldRetry({ statusCode, networkError }) {
  if (networkError) {
    return true;
  }

  return statusCode === 429 || statusCode >= 500;
}

function extractCoreMessage(payload) {
  if (typeof payload?.message === "string") {
    return payload.message;
  }

  return String(payload?.messages?.[0]?.content || "");
}

function extractCoreConversationId(payload) {
  return Number(payload?.conversation_id || payload?.id || 0) || "";
}

function extractCoreContactId(payload) {
  return Number(payload?.contact_id || payload?.meta?.sender?.id || 0) || "";
}

function extractPhoneForPauseCheck(payload) {
  const candidates = [
    payload?.meta?.sender?.phone_number,
    payload?.messages?.[0]?.sender?.phone_number,
    payload?.contact_inbox?.source_id,
    payload?.phone,
  ];

  const first = candidates.find((value) => String(value || "").trim().length > 0);
  return String(first || "").trim();
}

function buildIdempotencyKey(clientKey, payload) {
  const hash = createHash("sha256");
  hash.update(clientKey);
  hash.update("|");
  hash.update(String(extractCoreConversationId(payload)));
  hash.update("|");
  hash.update(String(extractCoreContactId(payload)));
  hash.update("|");
  hash.update(extractCoreMessage(payload));
  return `reprocess-${hash.digest("hex").slice(0, 32)}`;
}

function signPayload(payloadText, hmacSecret) {
  return `sha256=${createHmac("sha256", hmacSecret).update(payloadText).digest("hex")}`;
}

function logEvent(level, event, details) {
  const base = {
    level,
    event,
    ts: new Date().toISOString(),
    ...details,
  };
  const line = JSON.stringify(base);

  if (level === "error") {
    console.error(line);
    return;
  }

  console.log(line);
}

export async function buildReprocessPreview({ input, config }) {
  const conversationUrl = getRawConversationUrl(input);

  if (!conversationUrl) {
    fail("invalid_link", "Informe o link da conversa antes de gerar o preview.", 400);
  }

  const { accountId, conversationId } = extractConversationIdentity(conversationUrl, config.chatwootBaseUrl);
  const selectedClientInput = getClientInput(input);
  const messageCount = getMessageCountInput(input);

  const chatwootClient = createChatwootClient({
    baseUrl: config.chatwootBaseUrl,
    apiAccessToken: config.chatwootApiToken,
  });

  let conversation;
  let messagesResponse;
  let profile;

  try {
    [conversation, messagesResponse, profile] = await Promise.all([
      chatwootClient.getConversation(accountId, conversationId),
      chatwootClient.getConversationMessages(accountId, conversationId),
      chatwootClient.getProfile(),
    ]);
  } catch (error) {
    throw mapChatwootError(error);
  }

  const profileAccounts = Array.isArray(profile?.accounts) ? profile.accounts : [];
  const matchedAccount =
    profileAccounts.find((account) => Number(account?.id || 0) === Number(accountId)) || null;
  const accountName = matchedAccount?.name || null;
  const selectedClient = parseClientSelection(selectedClientInput, accountId, accountName);

  const mergedMessages = mergeConversationMessages(conversation, messagesResponse, accountId, conversationId);
  if (mergedMessages.length === 0) {
    fail("no_messages_found", "Nenhuma mensagem encontrada para essa conversa.", 404);
  }

  const latestMessage = pickLatestMessage(mergedMessages);
  if (!latestMessage) {
    fail("no_messages_found", "Nenhuma mensagem encontrada para essa conversa.", 404);
  }

  const latestUserMessage = pickLatestUserMessage(mergedMessages);
  if (!latestUserMessage) {
    fail(
      "last_message_not_user",
      "Nao foi encontrada mensagem enviada pelo usuario nessa conversa.",
      422,
    );
  }

  const contact = pickContact(conversation, messagesResponse, latestUserMessage);
  const openaiClient = createOpenAiClient(config);
  const mergedUserText = await buildMergedUserText({
    allMessages: mergedMessages,
    messageCount,
    openaiClient,
    config,
    chatwootApiToken: config.chatwootApiToken,
  });
  const webhookBody = buildWebhookLikeBody({
    accountId,
    conversationId,
    conversationResponse: conversation,
    messagesResponse,
    messageCount,
    mergedUserText,
  });
  const payloadCompleto = buildReplayPayload({
    body: webhookBody,
    webhookUrl: selectedClient.webhookUrl,
    headers: getWebhookHeaderTemplate(),
  });

  return payloadCompleto;
}

export async function executeReprocessWebhook({ input, config }) {
  const clientKey = getClientInput(input);
  const payload = input?.payload;

  if (!clientKey) {
    fail("client_required", "Informe o cliente para executar o reprocessamento.", 400);
  }

  if (!payload || typeof payload !== "object") {
    fail("invalid_payload", "Payload invalido. Gere o preview antes de executar.", 400);
  }

  const clientConfig = getReprocessClient(clientKey);
  if (!clientConfig || !clientConfig.webhookUrl) {
    fail(
      "webhook_not_configured",
      `Webhook nao configurado para o cliente '${clientKey}'.`,
      400,
    );
  }

  const normalizedPayload = Array.isArray(payload) ? payload[0] : payload;
  const webhookBody = normalizedPayload?.body || payload;
  const phoneForPauseCheck = extractPhoneForPauseCheck(webhookBody);
  const pauseStatus = await checkClientPauseStatus({
    clientConfig,
    phone: phoneForPauseCheck,
    config,
    timeoutMs: Number(config?.pauseCheckTimeoutMs || 8000),
  });

  if (pauseStatus.checked && pauseStatus.paused) {
    logEvent("info", "reprocess_skipped_paused", {
      client: clientKey,
      conversation_id: extractCoreConversationId(webhookBody) || null,
      contact_id: extractCoreContactId(webhookBody) || null,
      matched_phone: pauseStatus.matched_phone || null,
      pause_table: pauseStatus.table || null,
    });

    return {
      success: true,
      skipped: true,
      status: "paused",
      message: "Reprocessamento nao enviado: contato com IA pausada no Supabase.",
      pause_status: {
        event_type: "status",
        category: "supabase_ai_paused",
        title: "IA pausada no Supabase",
        likely_cause:
          "Contato encontrado na tabela de pausa configurada para este cliente.",
        suggestion: "Remover a pausa no Supabase e tentar novamente.",
        conversation_id: extractCoreConversationId(webhookBody) || null,
        client: clientKey,
        ...pauseStatus,
      },
    };
  }

  const requestId = randomUUID();
  const payloadText = JSON.stringify(webhookBody);
  const idempotencyKey = buildIdempotencyKey(clientKey, webhookBody);

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "x-request-id": requestId,
    "x-idempotency-key": idempotencyKey,
  };

  if (clientConfig.webhookSecret) {
    headers[clientConfig.webhookSecretHeader || "x-reprocess-secret"] = clientConfig.webhookSecret;
  }

  if (clientConfig.webhookHmacSecret) {
    headers[clientConfig.webhookHmacHeader || "x-reprocess-signature"] = signPayload(
      payloadText,
      clientConfig.webhookHmacSecret,
    );
  }

  const maxAttempts = Number(clientConfig.retryCount || 0) + 1;
  let lastErrorMessage = "Erro nao identificado";
  let lastStatusCode = null;
  let lastErrorDetails = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(clientConfig.timeoutMs || 10000));

    try {
      logEvent("info", "webhook_send_attempt", {
        request_id: requestId,
        client: clientKey,
        attempt,
        max_attempts: maxAttempts,
        timeout_ms: Number(clientConfig.timeoutMs || 10000),
        conversation_id: extractCoreConversationId(webhookBody) || null,
        contact_id: extractCoreContactId(webhookBody) || null,
      });

      const response = await fetch(clientConfig.webhookUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(webhookBody),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const responseText = await response.text();

      if (response.ok) {
        const logicalFailure = detectLogicalFailureInSuccessResponse(responseText);
        if (logicalFailure) {
          const classified = classifyWebhookFailure({
            statusCode: logicalFailure.statusCode,
            responseBody: responseText,
          });

          lastStatusCode = logicalFailure.statusCode;
          lastErrorMessage = `Webhook respondeu HTTP 200, mas com erro logico no body: ${responseText || "(vazio)"}`;
          lastErrorDetails = {
            ...classified,
            request_id: requestId,
            client: clientKey,
            attempt,
            http_status_code: response.status,
            logical_failure: logicalFailure.reason,
          };

          logEvent("error", "webhook_send_failed_logical_response", {
            request_id: requestId,
            client: clientKey,
            attempt,
            http_status_code: response.status,
            logical_status_code: logicalFailure.statusCode,
            logical_failure: logicalFailure.reason,
            response_body: responseText || "",
          });

          break;
        }

        logEvent("info", "webhook_send_success", {
          request_id: requestId,
          client: clientKey,
          attempt,
          status_code: response.status,
          conversation_id: extractCoreConversationId(webhookBody) || null,
          contact_id: extractCoreContactId(webhookBody) || null,
        });

        return {
          success: true,
          message: "Reprocessamento enviado com sucesso.",
          request_id: requestId,
          idempotency_key: idempotencyKey,
          client: clientKey,
          conversation_id: extractCoreConversationId(webhookBody) || null,
          contact_id: extractCoreContactId(webhookBody) || null,
          webhook_http_status: response.status,
          pause_status: pauseStatus.checked ? pauseStatus : null,
        };
      }
      const classified = classifyWebhookFailure({
        statusCode: response.status,
        responseBody: responseText,
      });
      lastStatusCode = response.status;
      lastErrorMessage = `Webhook respondeu com status ${response.status}. Body: ${responseText || "(vazio)"}`;
      lastErrorDetails = {
        ...classified,
        request_id: requestId,
        client: clientKey,
        attempt,
      };

      logEvent("error", "webhook_send_failed_response", {
        request_id: requestId,
        client: clientKey,
        attempt,
        status_code: response.status,
        response_body: responseText || "",
      });

      if (!shouldRetry({ statusCode: response.status, networkError: false }) || attempt >= maxAttempts) {
        break;
      }
    } catch (error) {
      clearTimeout(timeout);

      const isAbort = error?.name === "AbortError";
      const classifiedNetwork = classifyNetworkFailure(error, Number(clientConfig.timeoutMs || 10000));
      lastErrorMessage = isAbort
        ? `Timeout ao chamar webhook apos ${Number(clientConfig.timeoutMs || 10000)}ms`
        : `Erro ao chamar o webhook: ${error?.message || "falha de rede"}`;
      lastErrorDetails = {
        ...classifiedNetwork,
        request_id: requestId,
        client: clientKey,
        attempt,
      };

      logEvent("error", "webhook_send_failed_network", {
        request_id: requestId,
        client: clientKey,
        attempt,
        is_timeout: isAbort,
        error_name: error?.name || null,
        error_code: error?.code || error?.cause?.code || null,
        error_cause: error?.cause?.message || null,
        error_message: error?.message || "erro de rede",
      });

      if (!shouldRetry({ statusCode: null, networkError: true }) || attempt >= maxAttempts) {
        break;
      }
    }

    const backoffMs = attempt * 500;
    await wait(backoffMs);
  }

  fail(
    "webhook_request_error",
    `${lastErrorMessage} (request_id=${requestId}${lastStatusCode ? `, status=${lastStatusCode}` : ""})`,
    502,
    lastErrorDetails,
  );
}

export async function previewPauseStatus({ input, config }) {
  const clientKey = getClientInput(input);
  const payload = input?.payload;

  if (!clientKey) {
    fail("client_required", "Informe o cliente para consultar status de pausa.", 400);
  }

  if (!payload || typeof payload !== "object") {
    fail("invalid_payload", "Payload invalido para consulta de pausa.", 400);
  }

  const clientConfig = getReprocessClient(clientKey);
  if (!clientConfig || !clientConfig.webhookUrl) {
    fail(
      "webhook_not_configured",
      `Webhook nao configurado para o cliente '${clientKey}'.`,
      400,
    );
  }

  const normalizedPayload = Array.isArray(payload) ? payload[0] : payload;
  const webhookBody = normalizedPayload?.body || payload;
  const phoneForPauseCheck = extractPhoneForPauseCheck(webhookBody);
  const pauseStatus = await checkClientPauseStatus({
    clientConfig,
    phone: phoneForPauseCheck,
    config,
    timeoutMs: Number(config?.pauseCheckTimeoutMs || 8000),
  });

  return {
    success: true,
    client: clientKey,
    conversation_id: extractCoreConversationId(webhookBody) || null,
    contact_id: extractCoreContactId(webhookBody) || null,
    phone: phoneForPauseCheck || null,
    pause_status: pauseStatus,
  };
}

export async function testWebhookConnection({ input }) {
  const clientKey = getClientInput(input);

  if (!clientKey) {
    fail("client_required", "Informe o cliente para testar conexao.", 400);
  }

  const clientConfig = getReprocessClient(clientKey);
  if (!clientConfig || !clientConfig.webhookUrl) {
    fail(
      "webhook_not_configured",
      `Webhook nao configurado para o cliente '${clientKey}'.`,
      400,
    );
  }

  const requestId = randomUUID();
  const timeoutMs = Number(clientConfig.timeoutMs || 10000);
  const method = String(input?.method || "POST").toUpperCase();
  const safeMethod = ["HEAD", "OPTIONS", "GET", "POST"].includes(method) ? method : "POST";

  const headers = {
    "x-request-id": requestId,
    "x-connection-test": "true",
  };

  if (clientConfig.webhookSecret) {
    headers[clientConfig.webhookSecretHeader || "x-reprocess-secret"] = clientConfig.webhookSecret;
  }

  const controller = new AbortController();
  const start = Date.now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(clientConfig.webhookUrl, {
      method: safeMethod,
      headers,
      body: safeMethod === "POST" ? "{}" : undefined,
      signal: controller.signal,
    });
    clearTimeout(timer);

    return {
      success: true,
      message: "Conexao com webhook testada.",
      request_id: requestId,
      client: clientKey,
      method: safeMethod,
      status_code: response.status,
      ok: response.ok,
      latency_ms: Date.now() - start,
    };
  } catch (error) {
    clearTimeout(timer);
    const isTimeout = error?.name === "AbortError";
    const details = classifyNetworkFailure(error, timeoutMs);

    fail(
      "webhook_connection_test_failed",
      isTimeout
        ? `Timeout no teste de conexao apos ${timeoutMs}ms`
        : `Falha no teste de conexao: ${error?.message || "erro de rede"}`,
      502,
      details,
    );
  }
}

