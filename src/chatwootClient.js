export function createChatwootClient({ baseUrl, apiAccessToken }) {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");

  async function apiGet(pathname) {
    const response = await fetch(`${normalizedBaseUrl}${pathname}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        api_access_token: apiAccessToken,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Chatwoot API retornou ${response.status} em ${pathname}. Body: ${errorText || "(vazio)"}`,
      );
    }

    return response.json();
  }

  async function getProfile() {
    return apiGet("/api/v1/profile");
  }

  async function getConversation(accountId, conversationId) {
    return apiGet(`/api/v1/accounts/${accountId}/conversations/${conversationId}`);
  }

  async function getConversationMessages(accountId, conversationId) {
    return apiGet(`/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`);
  }

  return {
    getProfile,
    getConversation,
    getConversationMessages,
  };
}
