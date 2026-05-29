import { createChatwootClient } from "../../clients/chatwootClient.js";
import { createOpenAiClient } from "../../clients/openaiClient.js";
import { buildReplayPayload, buildWebhookLikeBody } from "../../domain/normalize.js";
import { getWebhookHeaderTemplate } from "../../domain/webhookResolver.js";
import { buildMergedUserTextWithMeta } from "../../services/messageEnricher.js";
import {
  extractConversationIdentity,
  fail,
  getClientInput,
  getMessageCountInput,
  getRawConversationUrl,
  mapChatwootError,
  mergeConversationMessages,
  parseClientSelection,
  pickLatestMessage,
  pickLatestUserMessage,
} from "./common.js";

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
  const selectedClient = await parseClientSelection(selectedClientInput, accountId, accountName);

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
      "Não foi encontrada mensagem enviada pelo usuário nessa conversa.",
      422,
    );
  }

  const openaiClient = createOpenAiClient(config);
  const mergedResult = await buildMergedUserTextWithMeta({
    allMessages: mergedMessages,
    messageCount,
    openaiClient,
    config,
    chatwootApiToken: config.chatwootApiToken,
  });
  const mergedUserText = String(mergedResult?.text || "").trim();
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
  const previewItem = Array.isArray(payloadCompleto) ? payloadCompleto[0] : null;
  if (previewItem && typeof previewItem === "object") {
    previewItem.preview_meta = {
      selected_client: selectedClient.key,
      message_count: messageCount,
      generated_at: new Date().toISOString(),
      media: mergedResult?.meta || null,
    };
  }

  return payloadCompleto;
}
