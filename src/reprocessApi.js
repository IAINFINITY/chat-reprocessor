import { createChatwootClient } from "./chatwootClient.js";
import { extractIdsFromChatUrl } from "./idParser.js";
import {
  buildClientPayload,
  detectReprocessClientByAccountId,
  getReprocessClient,
} from "./reprocessClients.js";

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

function parseClientSelection(clientInput, accountId) {
  const selectedClient = getReprocessClient(clientInput);
  if (selectedClient) {
    return selectedClient;
  }

  if (clientInput) {
    fail(
      "client_not_configured",
      `Webhook nao configurado para o cliente '${clientInput}'. Verifique as variaveis de ambiente do backend.`,
      400,
    );
  }

  const detectedClient = detectReprocessClientByAccountId(accountId);
  if (detectedClient) {
    return detectedClient;
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

function buildConversationSummary({ conversation, contact, accountId, conversationId, latestUserMessage }) {
  return {
    account_id: Number(conversation?.account_id || accountId),
    conversation_id: Number(conversation?.id || conversationId),
    inbox_id: Number(conversation?.inbox_id || 0) || null,
    status: conversation?.status || null,
    contact: {
      id: Number(contact?.id || 0) || null,
      name: contact?.name || "",
      phone: String(contact?.phone_number || contact?.identifier || ""),
    },
    last_user_message: {
      id: Number(latestUserMessage?.id || 0) || null,
      created_at: Number(latestUserMessage?.created_at || 0) || null,
      content: String(latestUserMessage?.content || ""),
    },
  };
}

function getRawConversationUrl(input) {
  return String(input?.conversationUrl || input?.conversation_url || input?.chat_url || "").trim();
}

function getClientInput(input) {
  return String(input?.client || "").trim().toLowerCase();
}

export async function buildReprocessPreview({ input, config }) {
  const conversationUrl = getRawConversationUrl(input);

  if (!conversationUrl) {
    fail("invalid_link", "Informe o link da conversa antes de gerar o preview.", 400);
  }

  const { accountId, conversationId } = extractConversationIdentity(conversationUrl, config.chatwootBaseUrl);
  const selectedClient = parseClientSelection(getClientInput(input), accountId);

  const chatwootClient = createChatwootClient({
    baseUrl: config.chatwootBaseUrl,
    apiAccessToken: config.chatwootApiToken,
  });

  let conversation;
  let messagesResponse;

  try {
    [conversation, messagesResponse] = await Promise.all([
      chatwootClient.getConversation(accountId, conversationId),
      chatwootClient.getConversationMessages(accountId, conversationId),
    ]);
  } catch (error) {
    throw mapChatwootError(error);
  }

  const mergedMessages = mergeConversationMessages(conversation, messagesResponse, accountId, conversationId);
  if (mergedMessages.length === 0) {
    fail("no_messages_found", "Nenhuma mensagem encontrada para essa conversa.", 404);
  }

  const latestMessage = pickLatestMessage(mergedMessages);
  if (!latestMessage) {
    fail("no_messages_found", "Nenhuma mensagem encontrada para essa conversa.", 404);
  }

  if (!isUserMessage(latestMessage)) {
    fail(
      "last_message_not_user",
      "A ultima mensagem da conversa nao foi enviada pelo usuario.",
      422,
    );
  }

  const contact = pickContact(conversation, messagesResponse, latestMessage);
  const payload = buildClientPayload(selectedClient, {
    clientKey: selectedClient.key,
    lastUserMessage: latestMessage,
    contact,
    conversation,
  });

  return {
    success: true,
    client: {
      key: selectedClient.key,
      name: selectedClient.name,
    },
    payload,
    conversation: buildConversationSummary({
      conversation,
      contact,
      accountId,
      conversationId,
      latestUserMessage: latestMessage,
    }),
  };
}

export async function executeReprocessWebhook({ input }) {
  const clientKey = getClientInput(input);
  const payload = input?.payload;

  if (!clientKey) {
    fail("client_required", "Informe o cliente para executar o reprocessamento.", 400);
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
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

  const headers = {
    "Content-Type": "application/json",
  };

  if (clientConfig.webhookSecret) {
    headers[clientConfig.webhookSecretHeader || "x-reprocess-secret"] = clientConfig.webhookSecret;
  }

  let response;

  try {
    response = await fetch(clientConfig.webhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  } catch (error) {
    fail(
      "webhook_request_error",
      `Erro ao chamar o webhook: ${error?.message || "falha de rede"}`,
      502,
    );
  }

  if (!response.ok) {
    const responseText = await response.text();
    fail(
      "webhook_request_error",
      `Webhook respondeu com status ${response.status}. Body: ${responseText || "(vazio)"}`,
      502,
    );
  }

  return {
    success: true,
    message: "Reprocessamento enviado com sucesso.",
  };
}

