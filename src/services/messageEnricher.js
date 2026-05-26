import { loadPromptFile } from "./promptLoader.js";
import { toFile } from "openai/uploads";

const DEFAULT_AUDIO_PROMPT =
  "Transcreva o audio em portugues do Brasil, mantendo a intencao do cliente e corrigindo apenas ruidos obvios.";
const DEFAULT_IMAGE_PROMPT =
  "Descreva a imagem objetivamente em portugues para contexto de atendimento ao cliente. Seja util e conciso.";

function isIncomingUserMessage(message) {
  const senderType = String(message?.sender_type || message?.sender?.type || "").toLowerCase();
  const messageType = Number(message?.message_type);
  const isPrivate = Boolean(message?.private);

  return !isPrivate && (messageType === 0 || senderType === "contact");
}

function sortByNewest(messages) {
  return [...messages].sort((left, right) => {
    const byCreatedAt = Number(right?.created_at || 0) - Number(left?.created_at || 0);
    if (byCreatedAt !== 0) {
      return byCreatedAt;
    }

    return Number(right?.id || 0) - Number(left?.id || 0);
  });
}

function normalizeMessageCount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 1;
  }

  return Math.min(Math.floor(parsed), 20);
}

function attachmentTypeOf(attachment) {
  const fileType = String(attachment?.file_type || attachment?.fileType || "").toLowerCase();
  const contentType = String(attachment?.data_url || attachment?.content_type || "").toLowerCase();
  const merged = `${fileType} ${contentType}`;

  if (merged.includes("audio")) {
    return "audio";
  }

  if (merged.includes("image")) {
    return "image";
  }

  return "other";
}

function getAttachmentUrl(attachment) {
  return (
    attachment?.data_url ||
    attachment?.dataUrl ||
    attachment?.thumb_url ||
    attachment?.thumbUrl ||
    attachment?.external_url ||
    null
  );
}

function getAttachmentLabel(attachment) {
  const fileName =
    attachment?.file_name ||
    attachment?.filename ||
    attachment?.name ||
    attachment?.id ||
    "arquivo";
  return String(fileName).trim() || "arquivo";
}

function createEmptyMediaMeta({ selectedMessages = 0, mediaAiEnabled = false } = {}) {
  return {
    selected_messages: Number(selectedMessages || 0),
    text_messages: 0,
    audio_attachments: 0,
    image_attachments: 0,
    other_attachments: 0,
    media_ai_enabled: Boolean(mediaAiEnabled),
    audio_transcribed: 0,
    image_described: 0,
    attachment_fallbacks: 0,
  };
}

async function downloadAttachmentBuffer(url, chatwootApiToken) {
  if (!url) {
    return null;
  }

  const attempts = [
    { headers: chatwootApiToken ? { api_access_token: chatwootApiToken } : {} },
    { headers: {} },
  ];

  let lastStatus = null;
  for (const attempt of attempts) {
    const response = await fetch(url, { headers: attempt.headers });
    if (response.ok) {
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }
    lastStatus = response.status;
  }

  throw new Error(`Falha ao baixar anexo: HTTP ${lastStatus || "desconhecido"}`);
}

async function transcribeAudio({ openaiClient, config, attachmentUrl, chatwootApiToken }) {
  if (!openaiClient) {
    return "[audio recebido]";
  }

  const buffer = await downloadAttachmentBuffer(attachmentUrl, chatwootApiToken);
  if (!buffer) {
    return "[audio recebido]";
  }

  const transcriptionPrompt = loadPromptFile(config?.mediaAudioPromptPath, DEFAULT_AUDIO_PROMPT);
  const file = await toFile(buffer, "audio.ogg", {
    type: "audio/ogg",
  });
  const transcription = await openaiClient.audio.transcriptions.create({
    model: config.openaiAudioModelName,
    file,
    prompt: transcriptionPrompt,
  });

  const text = String(transcription?.text || "").trim();
  return text || "[audio recebido]";
}

async function describeImage({ openaiClient, config, attachmentUrl, chatwootApiToken, messageText }) {
  if (!openaiClient) {
    return "[imagem recebida]";
  }

  const buffer = await downloadAttachmentBuffer(attachmentUrl, chatwootApiToken);
  if (!buffer) {
    return "[imagem recebida]";
  }

  const imagePrompt = loadPromptFile(config?.mediaImagePromptPath, DEFAULT_IMAGE_PROMPT);
  const contextualPrompt = String(messageText || "").trim()
    ? `${imagePrompt}

Contexto textual da mesma mensagem do cliente:
"${String(messageText || "").trim()}"

Sua descricao deve se conectar ao contexto acima e manter o sentido da conversa.`
    : imagePrompt;
  const base64 = buffer.toString("base64");
  const inferredMime =
    attachmentUrl?.includes(".png") ? "image/png" : attachmentUrl?.includes(".webp") ? "image/webp" : "image/jpeg";
  const response = await openaiClient.responses.create({
    model: config.openaiVisionModelName,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: contextualPrompt,
          },
          {
            type: "input_image",
            image_url: `data:${inferredMime};base64,${base64}`,
          },
        ],
      },
    ],
  });

  const text = String(response?.output_text || "").trim();
  return text || "[imagem recebida]";
}

async function enrichMessage(message, { openaiClient, config, chatwootApiToken }) {
  const textParts = [];
  const rawText = String(message?.content || "").trim();
  const meta = createEmptyMediaMeta({
    selectedMessages: 1,
    mediaAiEnabled: Boolean(config?.enableMediaAi),
  });
  if (rawText) {
    textParts.push(rawText);
    meta.text_messages += 1;
  }

  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];

  for (const attachment of attachments) {
    const type = attachmentTypeOf(attachment);
    const url = getAttachmentUrl(attachment);

    try {
      if (type === "audio") {
        meta.audio_attachments += 1;
        const transcript = await transcribeAudio({
          openaiClient,
          config,
          attachmentUrl: url,
          chatwootApiToken,
        });
        textParts.push(transcript);
        meta.audio_transcribed += 1;
      } else if (type === "image") {
        meta.image_attachments += 1;
        const description = await describeImage({
          openaiClient,
          config,
          attachmentUrl: url,
          chatwootApiToken,
          messageText: rawText,
        });
        textParts.push(description);
        meta.image_described += 1;
      } else {
        meta.other_attachments += 1;
        textParts.push(`[anexo recebido: ${getAttachmentLabel(attachment)}]`);
        meta.attachment_fallbacks += 1;
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "media_ai_failed",
          ts: new Date().toISOString(),
          media_type: type,
          attachment_url: url || null,
          message_id: message?.id || null,
          error_name: error?.name || null,
          error_message: error?.message || "erro desconhecido",
        }),
      );
      if (type === "audio") {
        meta.audio_attachments += 1;
        textParts.push("[audio recebido]");
      } else if (type === "image") {
        meta.image_attachments += 1;
        textParts.push("[imagem recebida]");
      } else {
        meta.other_attachments += 1;
        textParts.push(`[anexo recebido: ${getAttachmentLabel(attachment)}]`);
      }
      meta.attachment_fallbacks += 1;
    }
  }

  return {
    text: textParts.join("\n").trim(),
    meta,
  };
}

function mergeMediaMeta(baseMeta, nextMeta) {
  const result = { ...baseMeta };
  if (!nextMeta || typeof nextMeta !== "object") {
    return result;
  }

  result.text_messages += Number(nextMeta.text_messages || 0);
  result.audio_attachments += Number(nextMeta.audio_attachments || 0);
  result.image_attachments += Number(nextMeta.image_attachments || 0);
  result.other_attachments += Number(nextMeta.other_attachments || 0);
  result.audio_transcribed += Number(nextMeta.audio_transcribed || 0);
  result.image_described += Number(nextMeta.image_described || 0);
  result.attachment_fallbacks += Number(nextMeta.attachment_fallbacks || 0);
  return result;
}

export async function buildMergedUserText({
  allMessages,
  messageCount,
  openaiClient,
  config,
  chatwootApiToken,
}) {
  const result = await buildMergedUserTextWithMeta({
    allMessages,
    messageCount,
    openaiClient,
    config,
    chatwootApiToken,
  });

  return String(result?.text || "").trim();
}

export async function buildMergedUserTextWithMeta({
  allMessages,
  messageCount,
  openaiClient,
  config,
  chatwootApiToken,
}) {
  const incoming = sortByNewest((allMessages || []).filter(isIncomingUserMessage));
  if (incoming.length === 0) {
    return {
      text: "",
      meta: createEmptyMediaMeta({
        selectedMessages: 0,
        mediaAiEnabled: Boolean(config?.enableMediaAi),
      }),
    };
  }

  const selected = incoming.slice(0, normalizeMessageCount(messageCount)).reverse();
  const parts = [];
  let mediaMeta = createEmptyMediaMeta({
    selectedMessages: selected.length,
    mediaAiEnabled: Boolean(config?.enableMediaAi),
  });

  for (const message of selected) {
    if (config?.enableMediaAi) {
      const enriched = await enrichMessage(message, {
        openaiClient,
        config,
        chatwootApiToken,
      });
      mediaMeta = mergeMediaMeta(mediaMeta, enriched?.meta);
      if (enriched?.text) {
        parts.push(enriched.text);
      }
      continue;
    }

    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    const fallback = String(message?.content || "").trim();
    if (fallback) {
      parts.push(fallback);
      mediaMeta.text_messages += 1;
    }

    for (const attachment of attachments) {
      const type = attachmentTypeOf(attachment);
      if (type === "audio") {
        mediaMeta.audio_attachments += 1;
        mediaMeta.attachment_fallbacks += 1;
        parts.push("[audio recebido]");
      } else if (type === "image") {
        mediaMeta.image_attachments += 1;
        mediaMeta.attachment_fallbacks += 1;
        parts.push("[imagem recebida]");
      } else {
        mediaMeta.other_attachments += 1;
        mediaMeta.attachment_fallbacks += 1;
        parts.push(`[anexo recebido: ${getAttachmentLabel(attachment)}]`);
      }
    }
  }

  return {
    text: parts.join("\n").trim(),
    meta: mediaMeta,
  };
}

