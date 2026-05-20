function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function extractIdsFromChatUrl(chatUrl) {
  if (!chatUrl || typeof chatUrl !== "string") {
    return { accountId: null, conversationId: null, baseUrl: null };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(chatUrl);
  } catch {
    return { accountId: null, conversationId: null, baseUrl: null };
  }

  const parts = parsedUrl.pathname.split("/").filter(Boolean);
  const accountIdx = parts.findIndex((part) => part === "accounts");
  const conversationIdx = parts.findIndex((part) => part === "conversations");

  const accountId = accountIdx >= 0 ? toNumberOrNull(parts[accountIdx + 1]) : null;
  const conversationId = conversationIdx >= 0 ? toNumberOrNull(parts[conversationIdx + 1]) : null;
  const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;

  return { accountId, conversationId, baseUrl };
}

export function resolveConversationIdentity(input, defaultBaseUrl = null) {
  const parsedFromUrl = extractIdsFromChatUrl(input?.chat_url);

  const accountId = toNumberOrNull(input?.account_id) ?? parsedFromUrl.accountId;
  const conversationId = toNumberOrNull(input?.conversation_id) ?? parsedFromUrl.conversationId;
  const baseUrl = input?.chatwoot_base_url || parsedFromUrl.baseUrl || defaultBaseUrl;

  if (!accountId || !conversationId) {
    throw new Error(
      "Nao foi possivel identificar account_id e conversation_id. Envie chat_url valido ou account_id + conversation_id.",
    );
  }

  if (!baseUrl) {
    throw new Error(
      "Nao foi possivel identificar CHATWOOT_BASE_URL. Defina no .env ou envie chatwoot_base_url no payload.",
    );
  }

  return {
    accountId,
    conversationId,
    baseUrl: baseUrl.replace(/\/$/, ""),
  };
}
