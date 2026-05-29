import { createHash, createHmac } from "node:crypto";
import { extractIdsFromChatUrl } from "../../domain/idParser.js";
import {
  detectReprocessClientByAccountId,
  detectReprocessClientByAccountName,
  getReprocessClient,
} from "../../domain/reprocessClients.js";

export class ReprocessApiError extends Error {
  constructor(code, message, statusCode = 400, details = null) {
    super(message);
    this.name = "ReprocessApiError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function fail(code, message, statusCode = 400, details = null) {
  throw new ReprocessApiError(code, message, statusCode, details);
}

export function ensureChatwootHostMatches(conversationUrl, configuredBaseUrl) {
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
      `O link informado pertence ao host '${conversationHost}', mas o backend está configurado para '${configuredHost}'.`,
      400,
    );
  }
}

export function extractConversationIdentity(conversationUrl, configuredBaseUrl) {
  const parsed = extractIdsFromChatUrl(conversationUrl);

  if (!parsed.accountId || !parsed.conversationId) {
    fail(
      "invalid_link",
      "Link inválido. Informe uma URL no formato .../accounts/{account_id}/conversations/{conversation_id}.",
      400,
    );
  }

  ensureChatwootHostMatches(conversationUrl, configuredBaseUrl);

  return {
    accountId: Number(parsed.accountId),
    conversationId: Number(parsed.conversationId),
  };
}

export function mergeConversationMessages(conversation, messagesResponse, accountId, conversationId) {
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

export function isUserMessage(message) {
  const senderType = String(message?.sender_type || message?.sender?.type || "").toLowerCase();
  const messageType = Number(message?.message_type);
  const isPrivate = Boolean(message?.private);

  if (isPrivate) {
    return false;
  }

  return messageType === 0 || senderType === "contact";
}

function sortByNewest(left, right) {
  const byCreatedAt = Number(right?.created_at || 0) - Number(left?.created_at || 0);
  if (byCreatedAt !== 0) {
    return byCreatedAt;
  }

  return Number(right?.id || 0) - Number(left?.id || 0);
}

export function pickLatestMessage(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }

  return [...messages].sort(sortByNewest)[0] || null;
}

export function pickLatestUserMessage(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }

  return [...messages].sort(sortByNewest).find((message) => isUserMessage(message)) || null;
}

export function pickContact(conversation, messagesResponse, latestMessage) {
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

export async function parseClientSelection(clientInput, accountId, accountName = null) {
  const selectedClient = await getReprocessClient(clientInput);
  if (selectedClient) {
    return selectedClient;
  }

  if (clientInput) {
    fail(
      "client_not_configured",
      `Cliente '${clientInput}' não encontrado na configuração de empresas.`,
      400,
    );
  }

  const detectedClient = await detectReprocessClientByAccountId(accountId);
  if (detectedClient) {
    return detectedClient;
  }

  const detectedByName = await detectReprocessClientByAccountName(accountName);
  if (detectedByName) {
    return detectedByName;
  }

  fail(
    "client_required",
    "Não foi possível detectar o cliente por account_id. Selecione um cliente explicitamente.",
    400,
  );
}

export function mapChatwootError(error) {
  const message = String(error?.message || "");

  if (message.includes("retornou 404")) {
    return new ReprocessApiError(
      "conversation_not_found",
      "Conversa não encontrada no Chatwoot para os IDs informados.",
      404,
    );
  }

  return new ReprocessApiError(
    "chatwoot_request_error",
    `Erro ao consultar Chatwoot: ${message || "falha não identificada"}`,
    502,
  );
}

export function parseJsonSafe(rawText) {
  try {
    return JSON.parse(String(rawText || ""));
  } catch {
    return null;
  }
}

export function truncateText(value, max = 600) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export function pickUpstreamMessage(parsedBody, rawBody) {
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

export function getRawConversationUrl(input) {
  return String(input?.conversationUrl || input?.conversation_url || input?.chat_url || "").trim();
}

export function getClientInput(input) {
  return String(input?.client || "").trim().toLowerCase();
}

export function getMessageCountInput(input) {
  const raw = Number(input?.messageCount ?? input?.message_count ?? 1);

  if (!Number.isFinite(raw) || raw <= 0) {
    return 1;
  }

  return Math.min(Math.floor(raw), 20);
}

export function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function shouldRetry({ statusCode, networkError }) {
  if (networkError) {
    return true;
  }

  return statusCode === 429 || statusCode >= 500;
}

export function extractCoreMessage(payload) {
  if (typeof payload?.message === "string") {
    return payload.message;
  }

  return String(payload?.messages?.[0]?.content || "");
}

export function extractCoreConversationId(payload) {
  return Number(payload?.conversation_id || payload?.id || 0) || "";
}

export function extractCoreContactId(payload) {
  return Number(payload?.contact_id || payload?.meta?.sender?.id || 0) || "";
}

export function extractPhoneForPauseCheck(payload) {
  const candidates = [
    payload?.meta?.sender?.phone_number,
    payload?.messages?.[0]?.sender?.phone_number,
    payload?.contact_inbox?.source_id,
    payload?.phone,
  ];

  const first = candidates.find((value) => String(value || "").trim().length > 0);
  return String(first || "").trim();
}

export function buildIdempotencyKey(clientKey, payload) {
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

export function signPayload(payloadText, hmacSecret) {
  return `sha256=${createHmac("sha256", hmacSecret).update(payloadText).digest("hex")}`;
}

export function logEvent(level, event, details) {
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
