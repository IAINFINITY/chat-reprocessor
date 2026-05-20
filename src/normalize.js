function pickContactFromConversation(conversationResponse, messagesResponse) {
  const directMetaSender = conversationResponse?.meta?.sender;
  if (directMetaSender) {
    return directMetaSender;
  }

  const contactPayload = conversationResponse?.meta?.contact?.payload;
  if (Array.isArray(contactPayload) && contactPayload.length > 0) {
    return contactPayload[0];
  }

  const messageMetaContact = messagesResponse?.meta?.contact;
  if (messageMetaContact) {
    return messageMetaContact;
  }

  if (conversationResponse?.contact) {
    return conversationResponse.contact;
  }

  return null;
}

function mergeMessages(conversationResponse, messagesResponse, accountId, conversationId) {
  const conversationMessages = Array.isArray(conversationResponse?.messages) ? conversationResponse.messages : [];
  const endpointMessages = Array.isArray(messagesResponse?.payload) ? messagesResponse.payload : [];

  if (conversationMessages.length === 0 && endpointMessages.length === 0) {
    return [];
  }

  const endpointById = new Map(endpointMessages.map((message) => [message.id, message]));

  const merged = conversationMessages.map((conversationMessage) => {
    const endpointMessage = endpointById.get(conversationMessage.id) || {};

    return {
      ...endpointMessage,
      ...conversationMessage,
      account_id: Number(conversationMessage?.account_id || endpointMessage?.account_id || accountId),
      conversation_id: Number(
        conversationMessage?.conversation_id || endpointMessage?.conversation_id || conversationId,
      ),
      inbox_id: Number(conversationMessage?.inbox_id || endpointMessage?.inbox_id || 0) || null,
    };
  });

  for (const endpointMessage of endpointMessages) {
    if (!merged.some((message) => message.id === endpointMessage.id)) {
      merged.push({
        ...endpointMessage,
        account_id: Number(endpointMessage?.account_id || accountId),
        conversation_id: Number(endpointMessage?.conversation_id || conversationId),
        inbox_id: Number(endpointMessage?.inbox_id || 0) || null,
      });
    }
  }

  return merged;
}

function inferContactInbox(conversationResponse, contact, messages) {
  if (conversationResponse?.contact_inbox) {
    return conversationResponse.contact_inbox;
  }

  const sourceId =
    messages[0]?.conversation?.contact_inbox?.source_id ||
    contact?.phone_number?.replace(/^\+/, "") ||
    contact?.identifier ||
    null;

  if (!sourceId) {
    return null;
  }

  return {
    id: null,
    contact_id: contact?.id || null,
    inbox_id: conversationResponse?.inbox_id || null,
    source_id: String(sourceId),
    created_at: null,
    updated_at: null,
    hmac_verified: Boolean(conversationResponse?.meta?.hmac_verified),
    pubsub_token: null,
  };
}

function isCustomerMessage(message) {
  const senderType = String(message?.sender_type || message?.sender?.type || "").toLowerCase();
  const isIncomingType = Number(message?.message_type) === 0;
  const isPrivate = Boolean(message?.private);

  return !isPrivate && (isIncomingType || senderType === "contact");
}

function pickLatestCustomerMessage(messages) {
  const customerMessages = messages.filter(isCustomerMessage);
  if (customerMessages.length === 0) {
    return "";
  }

  const sorted = [...customerMessages].sort((a, b) => {
    const left = Number(a?.created_at || 0);
    const right = Number(b?.created_at || 0);
    return right - left;
  });

  return sorted[0]?.content || "";
}

function pickRecentCustomerMessages(messages, count) {
  const customerMessages = messages.filter(isCustomerMessage);
  if (customerMessages.length === 0) {
    return [];
  }

  const sortedByNewest = [...customerMessages].sort((a, b) => {
    const left = Number(a?.created_at || 0);
    const right = Number(b?.created_at || 0);

    if (right !== left) {
      return right - left;
    }

    return Number(b?.id || 0) - Number(a?.id || 0);
  });

  const normalizedCount = Number.isInteger(count) && count > 0 ? count : 1;

  return sortedByNewest.slice(0, normalizedCount).reverse();
}

function normalizeSenderShape(sender) {
  if (!sender) {
    return null;
  }

  return {
    additional_attributes: sender.additional_attributes || {},
    custom_attributes: sender.custom_attributes || {},
    email: sender.email ?? null,
    id: Number(sender.id || 0) || null,
    identifier: sender.identifier ?? null,
    name: sender.name || "",
    phone_number: sender.phone_number || "",
    thumbnail: sender.thumbnail || "",
    blocked: Boolean(sender.blocked),
    type: String(sender.type || "contact").toLowerCase(),
  };
}

function pickEventMessage(conversationResponse, allMessages, accountId, conversationId) {
  if (allMessages.length === 0) {
    return null;
  }

  const sorted = [...allMessages].sort((a, b) => {
    const left = Number(a?.created_at || 0);
    const right = Number(b?.created_at || 0);

    if (right !== left) {
      return right - left;
    }

    return Number(b?.id || 0) - Number(a?.id || 0);
  });

  const firstIncoming = sorted.find((message) => !message?.private && Number(message?.message_type) === 0);
  const nonPrivate = sorted.find((message) => !message?.private);
  const selected = firstIncoming || nonPrivate || sorted[0];

  return {
    ...selected,
    account_id: Number(selected?.account_id || accountId),
    conversation_id: Number(selected?.conversation_id || conversationId),
    inbox_id: Number(selected?.inbox_id || 0) || null,
  };
}

export function buildMainVariables({ accountId, conversationId, conversationResponse, messagesResponse }) {
  const contact = pickContactFromConversation(conversationResponse, messagesResponse);
  const messages = mergeMessages(conversationResponse, messagesResponse, accountId, conversationId);

  return {
    numero_cliente: contact?.phone_number || contact?.identifier || "",
    id_conversa: Number(conversationId),
    id_contato_cliente: Number(contact?.id || 0) || null,
    nome_cliente: contact?.name || "",
    ultima_mensagem_cliente: pickLatestCustomerMessage(messages),
    account_id: Number(accountId),
  };
}

export function buildWebhookLikeBody({
  accountId,
  conversationId,
  conversationResponse,
  messagesResponse,
  messageCount = 1,
  mergedUserText = "",
}) {
  const allMessages = mergeMessages(conversationResponse, messagesResponse, accountId, conversationId);
  const eventMessageBase = pickEventMessage(conversationResponse, allMessages, accountId, conversationId);
  const recentCustomerMessages = pickRecentCustomerMessages(allMessages, messageCount);
  const mergedCustomerContent = recentCustomerMessages
    .map((message) => String(message?.content || "").trim())
    .filter(Boolean)
    .join("\n");

  const finalContent = String(mergedUserText || mergedCustomerContent || "").trim();
  const eventMessage =
    eventMessageBase && finalContent
      ? {
          ...eventMessageBase,
          content: finalContent,
          processed_message_content: finalContent,
        }
      : eventMessageBase;

  const messages = eventMessage ? [eventMessage] : [];
  const contact = pickContactFromConversation(conversationResponse, messagesResponse);
  const meta = conversationResponse?.meta || {};
  const eventConversation = eventMessage?.conversation || {};

  const unreadCount = Number(eventConversation?.unread_count ?? conversationResponse?.unread_count ?? 0);
  const lastActivityAt = Number(
    eventConversation?.last_activity_at ||
      conversationResponse?.last_activity_at ||
      conversationResponse?.timestamp ||
      eventMessage?.created_at ||
      0,
  );
  const createdAt = Number(eventMessage?.created_at || conversationResponse?.created_at || 0);

  return {
    additional_attributes: conversationResponse?.additional_attributes || {},
    can_reply: Boolean(conversationResponse?.can_reply ?? true),
    channel: conversationResponse?.channel || meta?.channel || null,
    contact_inbox: inferContactInbox(conversationResponse, contact, messages),
    id: Number(conversationResponse?.id || conversationId),
    inbox_id: Number(conversationResponse?.inbox_id || 0) || null,
    messages,
    labels: conversationResponse?.labels || messagesResponse?.meta?.labels || [],
    meta: {
      sender: normalizeSenderShape(meta?.sender || contact),
      assignee: meta?.assignee ?? null,
      team: meta?.team ?? null,
      hmac_verified: Boolean(meta?.hmac_verified),
    },
    status: conversationResponse?.status || "open",
    custom_attributes: conversationResponse?.custom_attributes || {},
    snoozed_until: conversationResponse?.snoozed_until ?? null,
    unread_count: unreadCount,
    first_reply_created_at: conversationResponse?.first_reply_created_at || null,
    priority: conversationResponse?.priority ?? null,
    waiting_since: Number(conversationResponse?.waiting_since || eventMessage?.created_at || createdAt || 0),
    agent_last_seen_at: Number(eventConversation?.assignee_id ? conversationResponse?.agent_last_seen_at : 0),
    contact_last_seen_at: Number(conversationResponse?.contact_last_seen_at || 0),
    last_activity_at: lastActivityAt,
    timestamp: lastActivityAt,
    created_at: createdAt,
    updated_at: conversationResponse?.updated_at || null,
    event: "automation_event.message_created",
  };
}

export function buildReplayPayload({ body, webhookUrl, headers }) {
  return [
    {
      headers: headers || {},
      params: {},
      query: {},
      body,
      webhookUrl: webhookUrl || "",
      executionMode: "production",
    },
  ];
}
