import { createChatwootClient } from "../clients/chatwootClient.js";
import { buildMainVariables, buildWebhookLikeBody, buildReplayPayload } from "../domain/normalize.js";
import { resolveConversationIdentity } from "../domain/idParser.js";
import { buildMergedUserText } from "../services/messageEnricher.js";
import { createOpenAiClient } from "../clients/openaiClient.js";
import { resolveWebhookConfigByAccountName } from "../domain/webhookResolver.js";

function getAccountFromProfile(profile, accountId) {
  const accounts = Array.isArray(profile?.accounts) ? profile.accounts : [];
  return accounts.find((account) => Number(account?.id || 0) === Number(accountId || 0)) || null;
}

export async function reprocessConversation({ input, config }) {
  const identity = resolveConversationIdentity(input, config.chatwootBaseUrl);
  const accountIdFromLink = Number(identity.accountId);
  const selectedAccountId = Number(input?.selected_account_id || 0) || null;

  if (selectedAccountId && selectedAccountId !== accountIdFromLink) {
    throw new Error(
      `O link aponta para account_id=${accountIdFromLink}, mas voce selecionou account_id=${selectedAccountId}.`,
    );
  }

  const chatwootClient = createChatwootClient({
    baseUrl: identity.baseUrl,
    apiAccessToken: config.chatwootApiToken,
  });

  const [conversationResponse, messagesResponse, profile] = await Promise.all([
    chatwootClient.getConversation(identity.accountId, identity.conversationId),
    chatwootClient.getConversationMessages(identity.accountId, identity.conversationId),
    chatwootClient.getProfile(),
  ]);

  const account = getAccountFromProfile(profile, accountIdFromLink);
  const accountName = account?.name || `Conta ${accountIdFromLink}`;
  const webhookConfig = resolveWebhookConfigByAccountName(accountName);

  const context = {
    accountId: Number(identity.accountId),
    inboxId: Number(conversationResponse?.inbox_id || 0),
    accountName,
  };

  const mergedMessages = [
    ...(Array.isArray(conversationResponse?.messages) ? conversationResponse.messages : []),
    ...(Array.isArray(messagesResponse?.payload) ? messagesResponse.payload : []),
  ];
  const openaiClient = createOpenAiClient(config);
  const messageCount = Number(input?.messageCount ?? input?.message_count ?? 1);
  const mergedUserText = await buildMergedUserText({
    allMessages: mergedMessages,
    messageCount,
    openaiClient,
    config,
    chatwootApiToken: config.chatwootApiToken,
  });

  const webhookBody = buildWebhookLikeBody({
    accountId: identity.accountId,
    conversationId: identity.conversationId,
    conversationResponse,
    messagesResponse,
    messageCount,
    mergedUserText,
  });

  const payloadCompleto = buildReplayPayload({
    body: webhookBody,
    webhookUrl: webhookConfig.webhookUrl,
    headers: webhookConfig.headersTemplate,
  });

  if (input?.debug === true) {
    const variaveis = buildMainVariables({
      accountId: identity.accountId,
      conversationId: identity.conversationId,
      conversationResponse,
      messagesResponse,
    });

    return {
      payload_completo: payloadCompleto,
      variaveis,
      input_resolvido: identity,
      contexto_conversa: {
        account_id: context.accountId,
        account_nome: context.accountName,
        inbox_id: context.inboxId,
        webhook_mapeado: webhookConfig.webhookUrl,
        headers_mode: "template",
      },
      dados_brutos: {
        conversation: conversationResponse,
        messages: messagesResponse,
      },
    };
  }

  return payloadCompleto;
}


