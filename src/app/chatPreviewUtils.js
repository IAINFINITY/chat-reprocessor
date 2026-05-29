function normalizeChatPreviewContent(message, extractMessageAttachments) {
  const content = String(message?.content || "").trim();
  if (content) {
    return content;
  }

  const processed = String(message?.processed_message_content || "").trim();
  if (processed) {
    return processed;
  }

  const attachments = extractMessageAttachments(message);
  const contentType = String(message?.content_type || "").toLowerCase();
  const hasAudio = attachments.some((item) =>
    /audio|ogg|mp3|wav|m4a/.test(String(item?.extension || "").toLowerCase()),
  );
  const hasImage = attachments.some((item) =>
    /image|jpg|jpeg|png|webp|gif/.test(
      `${String(item?.extension || "").toLowerCase()} ${String(item?.file_type || "").toLowerCase()}`,
    ),
  );

  if (hasAudio || contentType === "audio") {
    return "[audio]";
  }

  if (hasImage || contentType === "image") {
    return "[imagem]";
  }

  if (attachments.length > 0) {
    return `[midia: ${attachments.length} anexo(s)]`;
  }

  if (contentType && contentType !== "text") {
    return `[${contentType}]`;
  }

  return "[mensagem sem texto]";
}

export function extractMessageAttachments(message) {
  const fromList = Array.isArray(message?.attachments) ? message.attachments : [];
  if (fromList.length > 0) {
    return fromList;
  }

  const single = message?.attachment;
  if (single && typeof single === "object") {
    const hasData =
      single.id ||
      single.data_url ||
      single.url ||
      single.file_type ||
      single.extension;
    if (hasData) {
      return [single];
    }
  }

  return [];
}

function mapMessageDirection(message) {
  if (Boolean(message?.private)) {
    return "private";
  }

  const senderType = String(message?.sender_type || message?.sender?.type || "").toLowerCase();
  const messageType = Number(message?.message_type);

  if (senderType === "contact" || messageType === 0) {
    return "inbound";
  }

  if (messageType === 1) {
    return "outbound";
  }

  if (messageType === 2 || messageType === 3) {
    return "system";
  }

  return "unknown";
}

function detectAttachmentKind(attachment) {
  const fileType = String(attachment?.file_type || "").toLowerCase();
  const extension = String(attachment?.extension || "").toLowerCase();
  const joined = `${fileType} ${extension}`;

  if (/audio|ogg|mp3|wav|m4a|aac|opus/.test(joined)) {
    return "audio";
  }

  if (/image|jpg|jpeg|png|webp|gif|bmp|svg/.test(joined)) {
    return "image";
  }

  return "file";
}

export function resolveAttachmentSourceUrl(attachment, baseUrl) {
  const candidates = [
    attachment?.data_url,
    attachment?.url,
    attachment?.download_url,
    attachment?.file_url,
    attachment?.thumb_url,
  ];

  const raw = String(candidates.find((value) => String(value || "").trim()) || "").trim();
  if (!raw) {
    return "";
  }

  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }

  if (raw.startsWith("//")) {
    return `https:${raw}`;
  }

  const normalizedBase = String(baseUrl || "").replace(/\/+$/, "");
  if (!normalizedBase) {
    return raw;
  }

  if (raw.startsWith("/")) {
    return `${normalizedBase}${raw}`;
  }

  return `${normalizedBase}/${raw}`;
}

export function guessAttachmentMimeType(attachment) {
  const fileType = String(attachment?.file_type || "").toLowerCase();
  if (fileType) {
    return fileType;
  }

  const ext = String(attachment?.extension || "").toLowerCase().replace(/^\./, "");
  const map = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    svg: "image/svg+xml",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    aac: "audio/aac",
    opus: "audio/ogg",
    pdf: "application/pdf",
  };

  return map[ext] || "application/octet-stream";
}

function buildAttachmentProxyUrl({ conversationUrl, messageId, attachmentIndex }) {
  const params = new URLSearchParams();
  params.set("conversationUrl", String(conversationUrl || ""));
  params.set("messageId", String(messageId || ""));
  params.set("attachmentIndex", String(attachmentIndex || 0));
  return `/api/reprocess/chatwoot/media?${params.toString()}`;
}

export function normalizeConversationMessagesForPreview(messagesResponse, options = {}) {
  const baseUrl = String(options.baseUrl || "").trim();
  const conversationUrl = String(options.conversationUrl || "").trim();
  const payload = Array.isArray(messagesResponse?.payload) ? messagesResponse.payload : [];
  const sorted = [...payload].sort((left, right) => {
    const byCreatedAt = Number(left?.created_at || 0) - Number(right?.created_at || 0);
    if (byCreatedAt !== 0) {
      return byCreatedAt;
    }

    return Number(left?.id || 0) - Number(right?.id || 0);
  });

  return sorted.map((message) => {
    const createdAtSec = Number(message?.created_at || 0);
    const messageId = Number(message?.id || 0) || null;
    const rawAttachments = extractMessageAttachments(message);
    const attachments = rawAttachments.map((attachment, index) => {
      const sourceUrl = resolveAttachmentSourceUrl(attachment, baseUrl);
      const mediaKind = detectAttachmentKind(attachment);
      return {
        id: Number(attachment?.id || 0) || null,
        kind: mediaKind,
        file_type: String(attachment?.file_type || ""),
        extension: String(attachment?.extension || ""),
        file_size: Number(attachment?.file_size || 0) || 0,
        width: Number(attachment?.width || 0) || null,
        height: Number(attachment?.height || 0) || null,
        source_url: sourceUrl || null,
        proxy_url:
          conversationUrl && messageId != null
            ? buildAttachmentProxyUrl({
                conversationUrl,
                messageId,
                attachmentIndex: index,
              })
            : null,
      };
    });

    return {
      id: messageId,
      conversation_id: Number(message?.conversation_id || 0) || null,
      account_id: Number(message?.account_id || 0) || null,
      message_type: Number(message?.message_type),
      content_type: String(message?.content_type || "text"),
      sender_type: String(message?.sender_type || message?.sender?.type || ""),
      sender_name: String(message?.sender?.name || message?.sender?.available_name || ""),
      private: Boolean(message?.private),
      direction: mapMessageDirection(message),
      attachments_count: attachments.length,
      attachments,
      content: normalizeChatPreviewContent(message, extractMessageAttachments),
      created_at: createdAtSec || null,
      created_at_iso: createdAtSec
        ? new Date(createdAtSec * 1000).toISOString()
        : null,
    };
  });
}

export async function mapProfileAccounts(profile, findWebhookMappingByAccountName) {
  const accounts = Array.isArray(profile?.accounts) ? profile.accounts : [];

  const mapped = await Promise.all(accounts.map(async (account) => {
    const accountId = Number(account?.id || 0);
    const accountName = account?.name || `Conta ${accountId}`;
    const mapping = await findWebhookMappingByAccountName(accountName);

    return {
      account_id: accountId,
      nome: accountName,
      role: account?.role || null,
      webhook_configurado: Boolean(mapping),
      empresa_mapeada: mapping?.nome || null,
    };
  }));

  return mapped;
}
