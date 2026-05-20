import { createChatwootClient } from "./chatwootClient.js";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { extractIdsFromChatUrl } from "./idParser.js";
import { buildReplayPayload, buildWebhookLikeBody } from "./normalize.js";
import { createOpenAiClient } from "./openaiClient.js";
import {
  detectReprocessClientByAccountId,
  detectReprocessClientByAccountName,
  getReprocessClient,
} from "./reprocessClients.js";
import { getWebhookHeaderTemplate } from "./webhookResolver.js";
import { buildMergedUserText } from "./messageEnricher.js";

export class ReprocessApiError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "ReprocessApiError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(code, message, statusCode = 400) {
  throw new ReprocessApiError(code, message, statusCode);
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

export async function executeReprocessWebhook({ input }) {
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

      if (response.ok) {
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
        };
      }

      const responseText = await response.text();
      lastStatusCode = response.status;
      lastErrorMessage = `Webhook respondeu com status ${response.status}. Body: ${responseText || "(vazio)"}`;

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
      lastErrorMessage = isAbort
        ? `Timeout ao chamar webhook apos ${Number(clientConfig.timeoutMs || 10000)}ms`
        : `Erro ao chamar o webhook: ${error?.message || "falha de rede"}`;

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
  );
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

    fail(
      "webhook_connection_test_failed",
      isTimeout
        ? `Timeout no teste de conexao apos ${timeoutMs}ms`
        : `Falha no teste de conexao: ${error?.message || "erro de rede"}`,
      502,
    );
  }
}
