(() => {
"use strict";

var COMPANY_LOGOS = {
  "akila": "/logos/akilalogo.webp",
  "astro": "/logos/astrologo.png",
  "clinic+": "/logos/clinicmaislogo.png",
  "clinic-": "/logos/clinicmaislogo.png",
  "espaco-infinity": "/logos/espacoinfinitylogo.webp",
  "grupo-botta": "/logos/botta_logo.png",
  "vai-xora-tintas": "/logos/vaixorartintaslogo.webp",
  "vai-xor-tintas": "/logos/vaixorartintaslogo.webp",
};

var COMPANY_LOGO_STYLE = {
  "akila": "ink-dark",
};

var HISTORY_STORAGE_KEY = "ia_reprocess_history_v1";
var ACTIVITY_STORAGE_KEY = "ia_reprocess_activity_v1";
var FORCE_COMPLETE_RUNNING_AFTER_MS = 180000;
var N8N_TIMELINE_STRICT_ACTIVE_REQUEST = true;
var ACTIVITY_MAX_ITEMS = 80;
var ACTIVITY_PAGE_SIZE = 6;
var N8N_TIMELINE_PAGE_SIZE = 6;

var state = {
  clients: [],
  previewPayload: null,
  previewOriginalPayload: null,
  previewMediaMeta: null,
  previewClientKey: "",
  lastDiagnosticContext: null,
  monitorTimer: null,
  monitorStartedAt: 0,
  monitorBusy: false,
  history: [],
  activity: [],
  historyPage: 1,
  activityPage: 1,
  n8nPage: 1,
  n8nEvents: [],
  localN8nEvents: [],
  n8nEventsTimer: null,
  n8nEventsFingerprint: "",
  n8nFilterType: "all",
  n8nFilterRequest: "",
  currentConversationUrl: "",
  pauseStatusPreview: null,
  chatMessages: [],
  chatMessagesFingerprint: "",
  chatBaselineIds: [],
  chatNewOutgoingMessages: [],
  chatNewOutgoingFingerprint: "",
  chatMonitorTimer: null,
  chatMonitorStartedAt: 0,
  chatMonitorBusy: false,
  chatMonitorDetectedAny: false,
  chatMonitorIdleTicksAfterDetection: 0,
  toastTimer: null,
  monitorRunningTicks: 0,
  activeRunRequestId: "",
  activeRunStartedAt: 0,
  activeRunClientKey: "",
  previewProgressTimer: null,
  previewProgressValue: 0,
  dashboardStats: null,
};

var el = {};
[
  "conversationUrl",
  "clientSelect",
  "resolvedClient",
  "messageCount",
  "pipelineSteps",
  "previewBtn",
  "executeBtn",
  "previewProgressWrap",
  "previewProgressBar",
  "previewProgressText",
  "previewProgressValue",
  "pauseWarningBox",
  "pauseWarningText",
  "statusBar",
  "statusText",
  "output",
  "copyBtn",
  "sAccount",
  "sConversation",
  "sContact",
  "sPhone",
  "sMessage",
  "sReceived",
  "sDetected",
  "sWebhook",
  "sPauseStatus",
  "sPauseDetails",
  "removePauseBtn",
  "companyLogoArea",
  "companyLogoImg",
  "resultsSection",
  "diagnosticPanel",
  "dCode",
  "dTitle",
  "dCause",
  "dSuggestion",
  "dUpstream",
  "dRequest",
  "dWorkflow",
  "dNode",
  "dExecution",
  "dFlowMessage",
  "n8nLookupBtn",
  "clearDiagnosticBtn",
  "activityFeed",
  "activityPrevBtn",
  "activityNextBtn",
  "activityPageInfo",
  "n8nEventsFeed",
  "n8nPrevBtn",
  "n8nNextBtn",
  "n8nPageInfo",
  "refreshN8nEventsBtn",
  "n8nTypeFilter",
  "n8nRequestFilter",
  "clearN8nFiltersBtn",
  "refreshChatPreviewBtn",
  "chatPreviewStatus",
  "chatPreviewList",
  "chatReprocessBadge",
  "chatReprocessList",
  "historyBody",
  "historyPagination",
  "refreshHistory",
  "queuePendingCount",
  "queueDedupeBtn",
  "queueClearBtn",
  "queueList",
  "summaryBadge",
  "editedMessage",
  "applyEditedMessageBtn",
  "resetEditedMessageBtn",
  "mediaStatusBar",
  "mediaStatusText",
  "statSuccess",
  "statErrors",
  "statPending",
  "statClients",
  "toastNotice",
  "imagePreviewModal",
  "imagePreviewImg",
  "imagePreviewCloseBtn",
].forEach(function (id) {
  el[id] = document.getElementById(id);
});

var pauseRemoveModal = document.getElementById("pauseRemoveModal");
var pauseRemoveModalOk = document.getElementById("pauseRemoveModalOk");
var pauseRemoveModalCancel = document.getElementById("pauseRemoveModalCancel");
var pauseRemoveModalResolver = null;
var imagePreviewModal = document.getElementById("imagePreviewModal");
var imagePreviewImg = document.getElementById("imagePreviewImg");
var imagePreviewCloseBtn = document.getElementById("imagePreviewCloseBtn");

function hasEl(name) {
  return Boolean(el[name]);
}

function onEl(name, eventName, handler) {
  if (!hasEl(name)) {
    return false;
  }
  el[name].addEventListener(eventName, handler);
  return true;
}

function closePauseRemoveModal(result) {
  if (pauseRemoveModal) {
    pauseRemoveModal.classList.remove("is-open");
    pauseRemoveModal.setAttribute("aria-hidden", "true");
  }
  if (typeof pauseRemoveModalResolver === "function") {
    var resolve = pauseRemoveModalResolver;
    pauseRemoveModalResolver = null;
    resolve(Boolean(result));
  }
}

function openPauseRemoveModal() {
  if (!pauseRemoveModal) {
    if (typeof window.openConfirmModal === "function") {
      return window.openConfirmModal(
        "Deseja remover este contato da tabela de IA pausada? Esta ação exclui o registro no Supabase.",
      );
    }
    return Promise.resolve(window.confirm("Deseja remover este contato da tabela de IA pausada?"));
  }

  if (typeof pauseRemoveModalResolver === "function") {
    pauseRemoveModalResolver(false);
    pauseRemoveModalResolver = null;
  }

  pauseRemoveModal.classList.add("is-open");
  pauseRemoveModal.setAttribute("aria-hidden", "false");
  return new Promise(function (resolve) {
    pauseRemoveModalResolver = resolve;
  });
}

function openImagePreviewModal(url) {
  var src = safeText(url, "");
  if (!src || !imagePreviewModal || !imagePreviewImg) {
    return;
  }
  imagePreviewImg.src = src;
  imagePreviewModal.classList.add("is-open");
  imagePreviewModal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeImagePreviewModal() {
  if (!imagePreviewModal || !imagePreviewImg) {
    return;
  }
  imagePreviewModal.classList.remove("is-open");
  imagePreviewModal.setAttribute("aria-hidden", "true");
  imagePreviewImg.src = "";
  document.body.style.overflow = "";
}

function wait(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function safeText(value, fallback) {
  var text = String(value == null ? "" : value).trim();
  return text || fallback;
}

function truncateText(value, maxLen) {
  var text = String(value == null ? "" : value).trim();
  var limit = Number(maxLen || 0);
  if (!limit || text.length <= limit) {
    return text;
  }
  return text.slice(0, Math.max(0, limit - 1)) + "…";
}

function readStorageJson(key, fallback) {
  try {
    var raw = localStorage.getItem(key);
    if (!raw) {
      return fallback;
    }
    var parsed = JSON.parse(raw);
    return parsed;
  } catch {
    return fallback;
  }
}

function writeStorageJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function normalizeLegacyPtBr(value) {
  var text = safeText(value, "");
  if (!text) {
    return text;
  }

  return text
    .replace(/Execucao/g, "Execução")
    .replace(/execucao/g, "execução")
    .replace(/conclusao/g, "conclusão")
    .replace(/requisicao/g, "requisição")
    .replace(/nao/g, "não")
    .replace(/ate agora/g, "até agora")
    .replace(/possivel/g, "possível")
    .replace(/NÃ£o/g, "Não")
    .replace(/Ã§/g, "ç")
    .replace(/Ã£/g, "ã")
    .replace(/Ã¡/g, "á")
    .replace(/Ã©/g, "é")
    .replace(/Ã­/g, "í")
    .replace(/Ã³/g, "ó")
    .replace(/Ãº/g, "ú");
}

function normalizeClientKey(value) {
  var normalized = String(value == null ? "" : value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_+-]/g, "")
    .replace(/-\+/g, "+")
    .replace(/\+-/g, "+")
    .replace(/\++/g, "+")
    .replace(/-{2,}/g, "-")
    .replace(/_{2,}/g, "_")
    .replace(/^[-_]+|[-_]+$/g, "");

  if (normalized === "clinic" || normalized === "clinic-") {
    return "clinic+";
  }

  return normalized;
}

function normalizeWebhookUrl(value) {
  var text = safeText(value, "").toLowerCase();
  if (!text) {
    return "";
  }
  return text.replace(/\/+$/, "");
}

function formatClientKeyForDisplay(value) {
  var key = normalizeClientKey(safeText(value, ""));
  if (!key) {
    return "-";
  }
  return key;
}

function deepClone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function getPreviewItem(payload) {
  if (Array.isArray(payload)) {
    return payload[0] || null;
  }
  if (payload && typeof payload === "object") {
    return payload;
  }
  return null;
}

function getPreviewWebhookBody(payload) {
  var item = getPreviewItem(payload);
  if (!item) {
    return null;
  }
  var body = item.body;
  if (body && typeof body === "object") {
    return body;
  }
  return item;
}

function extractPreviewMainMessage(payload) {
  var body = getPreviewWebhookBody(payload);
  var firstMessage = body && body.messages && body.messages[0];
  return safeText(firstMessage && firstMessage.content, "");
}

function applyEditedMessageToPayload(payload, messageText) {
  var nextPayload = deepClone(payload);
  var item = getPreviewItem(nextPayload);
  if (!item || !item.body || !Array.isArray(item.body.messages) || !item.body.messages[0]) {
    return nextPayload;
  }

  var nextText = safeText(messageText, "");
  item.body.messages[0].content = nextText;
  item.body.messages[0].processed_message_content = nextText;
  if (item.preview_meta && typeof item.preview_meta === "object") {
    item.preview_meta.edited_by_operator = true;
    item.preview_meta.edited_at = new Date().toISOString();
  }

  return nextPayload;
}

function renderMediaStatus(mediaMeta) {
  if (!hasEl("mediaStatusText") || !hasEl("mediaStatusBar")) {
    return;
  }

  var meta = mediaMeta && typeof mediaMeta === "object" ? mediaMeta : null;
  if (!meta) {
    el.mediaStatusText.textContent = "Sem mídia detectada nas mensagens selecionadas.";
    el.mediaStatusBar.classList.add("is-visible");
    el.mediaStatusBar.classList.remove("is-error");
    return;
  }

  var audioCount = Number(meta.audio_attachments || 0);
  var imageCount = Number(meta.image_attachments || 0);
  var otherCount = Number(meta.other_attachments || 0);
  var textCount = Number(meta.text_messages || 0);
  var selectedCount = Number(meta.selected_messages || 0);
  var aiEnabled = Boolean(meta.media_ai_enabled);

  if (audioCount + imageCount + otherCount <= 0) {
    el.mediaStatusText.textContent =
      "Sem mídia detectada. " +
      String(textCount) +
      " mensagem(ns) de texto em " +
      String(selectedCount) +
      " item(ns) selecionado(s).";
    el.mediaStatusBar.classList.remove("is-error");
    el.mediaStatusBar.classList.add("is-visible");
    return;
  }

  var parts = [];
  if (audioCount > 0) {
    parts.push(String(audioCount) + " áudio(s)");
  }
  if (imageCount > 0) {
    parts.push(String(imageCount) + " imagem(ns)");
  }
  if (otherCount > 0) {
    parts.push(String(otherCount) + " anexo(s)");
  }

  var modeText = aiEnabled
    ? "IA habilitada para transcrever/descrever mídia."
    : "IA de mídia desabilitada (será usado fallback textual).";

  el.mediaStatusText.textContent =
    "Mídia detectada: " + parts.join(", ") + ". " + modeText;
  el.mediaStatusBar.classList.remove("is-error");
  el.mediaStatusBar.classList.add("is-visible");
}

function selectInboundMessagesForPreview(messages, messageCount) {
  var rows = Array.isArray(messages) ? messages : [];
  var inbound = rows.filter(function (message) {
    return safeText(message && message.direction, "").toLowerCase() === "inbound";
  });
  var count = Math.max(1, Math.min(Number(messageCount || 1), 20));
  if (inbound.length <= count) {
    return inbound;
  }
  return inbound.slice(-count);
}

function detectMediaFromChatMessages(messages, messageCount) {
  var selected = selectInboundMessagesForPreview(messages, messageCount);
  var counts = {
    audio: 0,
    image: 0,
    other: 0,
    selected: selected.length,
  };

  selected.forEach(function (message) {
    var contentType = safeText(message && message.content_type, "").toLowerCase();
    var content = safeText(message && message.content, "").toLowerCase();
    var attachmentsCount = Number(message && message.attachments_count || 0);
    var attachments = Array.isArray(message && message.attachments) ? message.attachments : [];
    var attachmentKinds = attachments.map(function (item) {
      return safeText(item && item.kind, "").toLowerCase();
    });
    var hasAttachmentAudio = attachmentKinds.indexOf("audio") >= 0;
    var hasAttachmentImage = attachmentKinds.indexOf("image") >= 0;

    var isAudio =
      contentType === "audio" ||
      hasAttachmentAudio ||
      content.indexOf("[audio]") >= 0 ||
      content.indexOf("audio") >= 0;
    var isImage =
      contentType === "image" ||
      hasAttachmentImage ||
      content.indexOf("[imagem]") >= 0 ||
      content.indexOf("[image]") >= 0 ||
      content.indexOf("imagem") >= 0;

    if (isAudio) {
      counts.audio += 1;
      return;
    }
    if (isImage) {
      counts.image += 1;
      return;
    }
    if (attachmentsCount > 0 || (contentType && contentType !== "text")) {
      counts.other += 1;
    }
  });

  counts.hasMedia = counts.audio + counts.image + counts.other > 0;
  return counts;
}

function buildPrePreviewMediaNotice(mediaSignal) {
  var signal = mediaSignal && typeof mediaSignal === "object" ? mediaSignal : null;
  if (!signal) {
    return "";
  }

  var parts = [];
  if (Number(signal.audio || 0) > 0) {
    parts.push(String(signal.audio) + " áudio(s)");
  }
  if (Number(signal.image || 0) > 0) {
    parts.push(String(signal.image) + " imagem(ns)");
  }
  if (Number(signal.other || 0) > 0) {
    parts.push(String(signal.other) + " anexo(s)");
  }

  if (parts.length === 0) {
    return "";
  }

  return (
    "Pré-análise: mídia detectada em " +
    String(signal.selected || 0) +
    " mensagem(ns) selecionada(s): " +
    parts.join(", ") +
    ". Ao gerar o preview, a IA irá processar isso."
  );
}

function syncEditedMessageInputFromPayload(payload) {
  if (!hasEl("editedMessage")) {
    return;
  }
  el.editedMessage.value = extractPreviewMainMessage(payload);
}

function normalizeBackendErrorMessage(message) {
  var text = safeText(message, "");
  var normalized = text.toLowerCase();
  if (!text) {
    return "Erro desconhecido.";
  }

  var hasTokenIssue =
    normalized.includes("token") ||
    normalized.includes("sem token") ||
    normalized.includes("missing token") ||
    normalized.includes("missing api key") ||
    normalized.includes("api key") ||
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden") ||
    normalized.includes("invalid_api_key") ||
    normalized.includes("api_access_token") ||
    normalized.includes("401");

  if (hasTokenIssue) {
    return "Falha de autenticação: sem token válido em um dos serviços (Chatwoot/OpenAI/n8n/Supabase).";
  }

  return text;
}

function stripJsonFromText(value) {
  var text = safeText(value, "");
  if (!text) {
    return "";
  }

  var firstBrace = text.indexOf("{");
  var firstBracket = text.indexOf("[");
  var cutAt = -1;

  if (firstBrace >= 0 && firstBracket >= 0) {
    cutAt = Math.min(firstBrace, firstBracket);
  } else if (firstBrace >= 0) {
    cutAt = firstBrace;
  } else if (firstBracket >= 0) {
    cutAt = firstBracket;
  }

  if (cutAt <= 0) {
    return text;
  }

  return text.slice(0, cutAt).trim();
}

function resolveClientKeyFromPreviewPayload(payload, selectedClient) {
  var selected = safeText(selectedClient, "");
  if (selected) {
    return selected;
  }

  var item = Array.isArray(payload) ? payload[0] : payload;
  var payloadWebhook = normalizeWebhookUrl(item && item.webhookUrl);
  var webhookMatch = state.clients.find(function (client) {
    return normalizeWebhookUrl(client && client.webhook_url) === payloadWebhook;
  });
  if (webhookMatch && webhookMatch.key) {
    return webhookMatch.key;
  }

  var body = (item && item.body) || {};
  var firstMessage = (body.messages && body.messages[0]) || {};
  var accountId = Number(firstMessage.account_id || body.account_id || 0);
  if (Number.isInteger(accountId) && accountId > 0) {
    var accountMatch = state.clients.find(function (client) {
      var ids = Array.isArray(client && client.chatwoot_account_ids)
        ? client.chatwoot_account_ids
        : [];
      return ids.some(function (id) { return Number(id) === accountId; });
    });
    if (accountMatch && accountMatch.key) {
      return accountMatch.key;
    }
  }

  return "";
}

function setStatus(message, isError) {
  if (!hasEl("statusText") || !hasEl("statusBar")) {
    return;
  }
  el.statusText.textContent = message;
  el.statusBar.style.animation = "none";
  el.statusBar.classList.remove("is-visible", "is-error");
  void el.statusBar.offsetHeight;
  if (isError) {
    el.statusBar.classList.add("is-error");
  } else {
    el.statusBar.classList.add("is-visible");
  }
}

function setChatPreviewStatus(message) {
  if (!hasEl("chatPreviewStatus")) {
    return;
  }
  el.chatPreviewStatus.textContent = message;
}

function showToast(message, type) {
  if (!hasEl("toastNotice")) {
    return;
  }

  if (state.toastTimer) {
    clearTimeout(state.toastTimer);
    state.toastTimer = null;
  }

  var kind = safeText(type, "success").toLowerCase();
  el.toastNotice.innerHTML =
    (kind === 'success'
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>') +
    '<span>' + safeText(message, "Operacao concluida.") + '</span>';
  el.toastNotice.classList.remove("is-error", "is-success", "is-visible");
  el.toastNotice.classList.add(kind === "error" ? "is-error" : "is-success");
  void el.toastNotice.offsetHeight;
  el.toastNotice.classList.add("is-visible");

  state.toastTimer = setTimeout(function () {
    el.toastNotice.classList.remove("is-visible");
  }, 3500);
}

function stopChatMonitor() {
  if (state.chatMonitorTimer) {
    clearInterval(state.chatMonitorTimer);
    state.chatMonitorTimer = null;
  }
  state.chatMonitorStartedAt = 0;
  state.chatMonitorBusy = false;
}

function resetChatState() {
  stopChatMonitor();
  state.chatMessages = [];
  state.chatMessagesFingerprint = "";
  state.chatBaselineIds = [];
  state.chatNewOutgoingMessages = [];
  state.chatNewOutgoingFingerprint = "";
  state.chatMonitorDetectedAny = false;
  state.chatMonitorIdleTicksAfterDetection = 0;
  if (hasEl("chatReprocessBadge")) {
    el.chatReprocessBadge.textContent = "0";
  }
  renderChatMessages({ suppressAnimations: true });
}

function isChatMessageOutgoing(message) {
  var direction = safeText(message && message.direction, "").toLowerCase();
  if (direction === "outbound") {
    return true;
  }
  return false;
}

function getChatMessageKey(message) {
  return safeText(message && message.id, "");
}

function buildChatFingerprint(messages) {
  var rows = Array.isArray(messages) ? messages : [];
  return rows.map(function (message) {
    return [
      safeText(message && message.id, ""),
      safeText(message && message.created_at_iso, ""),
      safeText(message && message.direction, ""),
      safeText(message && message.status, ""),
      safeText(message && message.content, ""),
    ].join("|");
  }).join("||");
}

function setChatAnimationSuppressed(enabled) {
  var shouldSuppress = enabled === true;
  if (hasEl("chatPreviewList")) {
    el.chatPreviewList.classList.toggle("is-live-updating", shouldSuppress);
  }
  if (hasEl("chatReprocessList")) {
    el.chatReprocessList.classList.toggle("is-live-updating", shouldSuppress);
  }
}

function stopPreviewProgressTimer() {
  if (state.previewProgressTimer) {
    clearInterval(state.previewProgressTimer);
    state.previewProgressTimer = null;
  }
}

function setPreviewProgress(percent, message, options) {
  if (!hasEl("previewProgressWrap") || !hasEl("previewProgressBar") || !hasEl("previewProgressText") || !hasEl("previewProgressValue")) {
    return;
  }

  var opts = options || {};
  var safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  state.previewProgressValue = safePercent;

  el.previewProgressWrap.classList.add("is-visible");
  el.previewProgressWrap.classList.toggle("is-error", opts.isError === true);
  el.previewProgressBar.style.width = safePercent + "%";
  el.previewProgressText.textContent = safeText(message, "Gerando preview...");
  el.previewProgressValue.textContent = Math.round(safePercent) + "%";
}

function startPreviewProgressFlow() {
  stopPreviewProgressTimer();
  setPreviewProgress(8, "Validando URL e preparando consulta...");
  state.previewProgressTimer = setInterval(function () {
    if (state.previewProgressValue >= 92) {
      return;
    }
    var step = state.previewProgressValue < 40 ? 5 : state.previewProgressValue < 70 ? 3 : 1.2;
    setPreviewProgress(state.previewProgressValue + step, "Processando mensagens para o preview...");
  }, 250);
}

function finishPreviewProgressFlow(isError, message) {
  stopPreviewProgressTimer();
  var text = safeText(
    message,
    isError ? "Falha ao gerar preview." : "Preview gerado com sucesso.",
  );
  setPreviewProgress(100, text, { isError: isError === true });

  setTimeout(function () {
    if (!hasEl("previewProgressWrap")) {
      return;
    }
    el.previewProgressWrap.classList.remove("is-visible", "is-error");
  }, 1000);
}

function renderPauseWarning(pauseStatus) {
  if (!hasEl("pauseWarningBox") || !hasEl("pauseWarningText")) {
    return;
  }

  var paused = Boolean(pauseStatus && pauseStatus.paused === true);
  if (!paused) {
    el.pauseWarningBox.classList.remove("is-visible");
    el.pauseWarningText.textContent = "Remova o contato da IA pausada para liberar o reprocessamento.";
    return;
  }

  var table = safeText(pauseStatus && pauseStatus.table, "-");
  var matched = safeText(pauseStatus && pauseStatus.matched_phone, "-");
  el.pauseWarningText.textContent =
    "Contato localizado na tabela '" + table + "' (match: " + matched + "). Remova da IA pausada antes de reprocessar.";
  el.pauseWarningBox.classList.add("is-visible");
}

function formatChatTime(value) {
  var date = new Date(value || "");
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toLocaleString("pt-BR", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getInitials(name) {
  var value = safeText(name, "").trim();
  if (!value) {
    return "?";
  }
  var parts = value.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return parts[0].charAt(0).toUpperCase();
  }
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

function getStatusDotClass(message) {
  var status = safeText(message && message.status, "").toLowerCase();
  if (status === "read") {
    return "read";
  }
  if (status === "delivered") {
    return "delivered";
  }
  if (status === "sent") {
    return "sent";
  }
  return "sent";
}

function isSystemNotificationMessage(message) {
  var direction = safeText(message && message.direction, "").toLowerCase();
  if (direction === "system") {
    return true;
  }

  var senderName = safeText(message && message.sender_name, "").toLowerCase();
  var content = safeText(message && message.content, "").toLowerCase();
  var attachmentsCount = Number(message && message.attachments_count || 0);

  if (attachmentsCount > 0) {
    return false;
  }

  var looksLikeOperationalNotice =
    /conversa foi|suporte adicionou|foi marcada como|foi transferida|foi atribu[ií]da|alterou|removeu/.test(content);

  if (looksLikeOperationalNotice && (senderName === "contato" || senderName === "system" || senderName === "sistema")) {
    return true;
  }

  return false;
}

function renderChatAttachmentsHtml(message) {
  var attachments = Array.isArray(message && message.attachments) ? message.attachments : [];
  if (attachments.length === 0) {
    return "";
  }

  var mediaHtml = attachments.map(function (item, index) {
    var kind = safeText(item && item.kind, "file").toLowerCase();
    var proxyUrl = safeText(item && item.proxy_url, "");
    var sourceUrl = safeText(item && item.source_url, "");
    var href = proxyUrl || sourceUrl;
    var label = "Anexo " + String(index + 1);

    if (!href) {
      return '<div class="chat-attachment chat-attachment-file"><span>' + label + ': indisponível</span></div>';
    }

    if (kind === "audio") {
      return (
        '<div class="chat-attachment chat-attachment-audio">' +
          '<div class="chat-attachment-audio-head">' +
            '<span class="chat-attachment-audio-badge">Áudio</span>' +
            '<a class="chat-attachment-audio-link" href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer">Abrir</a>' +
          "</div>" +
          '<audio class="chat-audio-player" controls preload="none" controlsList="nodownload noplaybackrate" src="' + escapeHtml(href) + '"></audio>' +
        "</div>"
      );
    }

    if (kind === "image") {
      return (
        '<button class="chat-attachment chat-attachment-image" type="button" data-image-preview-url="' + escapeHtml(href) + '">' +
          '<img src="' + escapeHtml(href) + '" loading="lazy" alt="Imagem enviada no chat">' +
        "</button>"
      );
    }

    return (
      '<a class="chat-attachment chat-attachment-file" href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer">' +
        "Abrir anexo" +
      "</a>"
    );
  }).join("");

  return '<div class="chat-attachments">' + mediaHtml + "</div>";
}

function renderChatMessages(options) {
  var opts = options || {};
  var suppressAnimations = opts.suppressAnimations === true;

  if (!hasEl("chatPreviewList") || !hasEl("chatReprocessList")) {
    return;
  }
  setChatAnimationSuppressed(suppressAnimations);
  el.chatPreviewList.innerHTML = "";
  el.chatReprocessList.innerHTML = "";

  if (!Array.isArray(state.chatMessages) || state.chatMessages.length === 0) {
    var empty = document.createElement("div");
    empty.className = "chat-bubble";
    empty.innerHTML = '<div class="content">Nenhuma mensagem carregada.</div>';
    el.chatPreviewList.appendChild(empty);
  } else {
    state.chatMessages.slice(-60).forEach(function (message, index) {
      if (isSystemNotificationMessage(message)) {
        var notificationNode = document.createElement("div");
        notificationNode.className = "chat-notification";
        notificationNode.style.animationDelay = suppressAnimations ? "0ms" : (index * 40) + "ms";
        notificationNode.innerHTML =
          '<span class="chat-notification-text">' +
          escapeHtml(safeText(message.content, "Notificação do sistema")) +
          "</span>";
        el.chatPreviewList.appendChild(notificationNode);
        return;
      }

      var direction = safeText(message.direction, "unknown").toLowerCase();
      var isOutbound = direction === "outbound";
      var isPrivate = direction === "private";
      var isNewReprocessMessage = state.chatNewOutgoingMessages.some(function (m) {
        return getChatMessageKey(m) === getChatMessageKey(message);
      });
      var senderName = safeText(message.sender_name, isOutbound ? "Atendimento" : "Contato");
      var wrapper = document.createElement("div");
      var avatar = document.createElement("div");
      var bubble = document.createElement("div");
      var statusDotClass = getStatusDotClass(message);

      wrapper.className = "chat-bubble-wrapper" + (isOutbound ? " outbound" : "");
      wrapper.style.animationDelay = suppressAnimations ? "0ms" : (index * 40) + "ms";

      avatar.className = "chat-avatar " + (isOutbound ? "agent" : "user");
      avatar.textContent = getInitials(senderName);
      avatar.style.animationDelay = suppressAnimations ? "0ms" : (index * 40) + "ms";

      var classes = ["chat-bubble", isOutbound ? "outbound" : "inbound"];
      if (isPrivate) {
        classes.push("private");
      }
      if (isNewReprocessMessage) {
        classes.push("reprocess-new");
      }

      bubble.className = classes.join(" ");
      bubble.style.animationDelay = suppressAnimations ? "0ms" : (index * 40) + "ms";
      bubble.innerHTML =
        '<div class="meta">' +
        '<span class="sender">' + escapeHtml(senderName) + "</span>" +
        '<span class="status"><span class="status-dot ' + statusDotClass + '"></span>' + escapeHtml(formatChatTime(message.created_at_iso)) + "</span>" +
        "</div>" +
        '<div class="content">' + escapeHtml(safeText(message.content, "[sem texto]")) + "</div>" +
        renderChatAttachmentsHtml(message);

      wrapper.appendChild(avatar);
      wrapper.appendChild(bubble);
      el.chatPreviewList.appendChild(wrapper);
    });
  }

  if (!Array.isArray(state.chatNewOutgoingMessages) || state.chatNewOutgoingMessages.length === 0) {
    var noNew = document.createElement("div");
    noNew.className = "chat-bubble";
    noNew.innerHTML = '<div class="content">Nenhuma nova mensagem outbound detectada ainda.</div>';
    el.chatReprocessList.appendChild(noNew);
    if (hasEl("chatReprocessBadge")) {
      el.chatReprocessBadge.textContent = "0";
    }
    return;
  }

  state.chatNewOutgoingMessages.slice(-20).forEach(function (message, index) {
    var senderName = safeText(message.sender_name, "Atendimento");
    var wrapper = document.createElement("div");
    var avatar = document.createElement("div");
    var bubble = document.createElement("div");

    wrapper.className = "chat-bubble-wrapper outbound";
    wrapper.style.animationDelay = suppressAnimations ? "0ms" : (index * 40) + "ms";

    avatar.className = "chat-avatar agent";
    avatar.textContent = getInitials(senderName);
    avatar.style.animationDelay = suppressAnimations ? "0ms" : (index * 40) + "ms";

    bubble.className = "chat-bubble outbound reprocess-new";
    bubble.style.animationDelay = suppressAnimations ? "0ms" : (index * 40) + "ms";
    bubble.innerHTML =
      '<div class="meta">' +
      '<span class="sender">' + escapeHtml(senderName) + "</span>" +
      '<span class="status"><span class="status-dot sent"></span>' + escapeHtml(formatChatTime(message.created_at_iso)) + "</span>" +
      "</div>" +
      '<div class="content">' + escapeHtml(safeText(message.content, "[sem texto]")) + "</div>" +
      renderChatAttachmentsHtml(message);

    wrapper.appendChild(avatar);
    wrapper.appendChild(bubble);
    el.chatReprocessList.appendChild(wrapper);
  });

  if (hasEl("chatReprocessBadge")) {
    el.chatReprocessBadge.textContent = String(state.chatNewOutgoingMessages.length);
  }
}

function setChatBaselineFromMessages(messages) {
  state.chatBaselineIds = (Array.isArray(messages) ? messages : [])
    .map(function (message) { return getChatMessageKey(message); })
    .filter(function (id) { return id; });
}

function detectNewOutgoingMessages(messages) {
  var baseline = new Set(state.chatBaselineIds || []);
  return (Array.isArray(messages) ? messages : []).filter(function (message) {
    var id = getChatMessageKey(message);
    if (!id || baseline.has(id)) {
      return false;
    }
    return isChatMessageOutgoing(message);
  });
}

async function fetchChatMessages(options) {
  var opts = options || {};
  var silent = opts.silent === true;
  var suppressAnimations = opts.suppressAnimations === true;
  var limit = Number(opts.limit || 100);
  var conversationUrl = safeText(opts.conversationUrl || state.currentConversationUrl, "");

  if (!conversationUrl) {
    if (!silent) {
      setChatPreviewStatus("Informe o link da conversa para carregar o chat.");
    }
    return null;
  }

  try {
    const response = await fetch("/api/reprocess/chatwoot/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationUrl: conversationUrl,
        limit: Math.max(1, Math.min(limit, 200)),
      }),
    });
    const data = await readJsonSafe(response);

    if (!response.ok || !data || !data.success) {
      if (!silent) {
        setChatPreviewStatus(safeText(data && data.message, "Falha ao carregar mensagens do Chatwoot."));
      }
      return null;
    }

    var incomingMessages = Array.isArray(data.messages) ? data.messages : [];
    var incomingFingerprint = buildChatFingerprint(incomingMessages);
    var unchanged = incomingFingerprint === state.chatMessagesFingerprint;

    if (!unchanged) {
      state.chatMessages = incomingMessages;
      state.chatMessagesFingerprint = incomingFingerprint;
      renderChatMessages({ suppressAnimations: suppressAnimations });
    }

    if (!silent) {
      setChatPreviewStatus("Preview do chat atualizado.");
    }

    return Object.assign({}, data, {
      unchanged: unchanged,
    });
  } catch (error) {
    if (!silent) {
      setChatPreviewStatus("Erro de rede ao carregar chat: " + safeText(error && error.message, "erro"));
    }
    return null;
  }
}

function startChatPostReprocessMonitor() {
  stopChatMonitor();
  if (!state.currentConversationUrl) {
    return;
  }

  state.chatMonitorStartedAt = Date.now();
  state.chatMonitorDetectedAny = false;
  state.chatMonitorIdleTicksAfterDetection = 0;
  state.chatMonitorTimer = setInterval(async function () {
    if (state.chatMonitorBusy) {
      return;
    }

    if (Date.now() - state.chatMonitorStartedAt > 120000) {
      stopChatMonitor();
      setChatPreviewStatus("Monitor de chat encerrado (timeout).");
      return;
    }

    state.chatMonitorBusy = true;
    try {
      const data = await fetchChatMessages({
        silent: true,
        limit: 120,
        suppressAnimations: true,
      });
      if (!data) {
        return;
      }

      const newOutgoing = detectNewOutgoingMessages(state.chatMessages);
      if (newOutgoing.length > 0) {
        var existingById = new Set(
          (Array.isArray(state.chatNewOutgoingMessages) ? state.chatNewOutgoingMessages : [])
            .map(function (message) { return getChatMessageKey(message); })
            .filter(Boolean),
        );
        var toAppend = newOutgoing.filter(function (message) {
          var id = getChatMessageKey(message);
          return id && !existingById.has(id);
        });

        if (toAppend.length > 0) {
          state.chatNewOutgoingMessages = state.chatNewOutgoingMessages.concat(toAppend);
          state.chatNewOutgoingFingerprint = buildChatFingerprint(state.chatNewOutgoingMessages);
          renderChatMessages({ suppressAnimations: true });
          setChatPreviewStatus(
            "Novas mensagens enviadas pelo reprocesso detectadas (" +
              String(state.chatNewOutgoingMessages.length) +
              ").",
          );
          pushActivity(
            "success",
            "Mensagens enviadas",
            "Chatwoot recebeu " + String(toAppend.length) + " nova(s) mensagem(ns) outbound.",
          );
          showToast(
            "Reprocessamento com retorno detectado no Chatwoot (" +
              String(state.chatNewOutgoingMessages.length) +
              ").",
            "success",
          );
        }
        state.chatMonitorDetectedAny = true;
        state.chatMonitorIdleTicksAfterDetection = 0;
        if (state.activeRunRequestId) {
          updateHistoryByRequestId(state.activeRunRequestId, "success", "Mensagens de retorno detectadas no Chatwoot.");
        }
        return;
      }

      if (state.chatMonitorDetectedAny) {
        state.chatMonitorIdleTicksAfterDetection += 1;
        if (state.chatMonitorIdleTicksAfterDetection >= 3) {
          setChatPreviewStatus("Mensagens do reprocesso estabilizadas no Chatwoot.");
          stopMonitor();
          pushLocalN8nTimelineEvent({
            category: "n8n_execution_success",
            status: "success",
            title: "Execução concluída",
            likely_cause: "Retorno do fluxo confirmado no Chatwoot.",
            suggestion: "Reprocessamento finalizado com sucesso.",
          });
          setPipelineStep(4);
          setStatus("Fluxo finalizado com retorno no Chatwoot.", false);
          updateHistoryByRequestId(
            state.activeRunRequestId,
            "success",
            "Fluxo finalizado com retorno confirmado no Chatwoot.",
          );
          pushActivity("success", "Fluxo finalizado", "Retorno detectado e estabilizado no Chatwoot.");
          showToast("Reprocessamento finalizado com sucesso.", "success");
          fireConfetti(20);
          stopChatMonitor();
        }
      }
    } finally {
      state.chatMonitorBusy = false;
    }
  }, 4000);
}

function stopMonitor() {
  if (state.monitorTimer) {
    clearInterval(state.monitorTimer);
    state.monitorTimer = null;
  }
  state.monitorBusy = false;
  state.monitorStartedAt = 0;
}

function hasConfirmedChatReturn() {
  return Array.isArray(state.chatNewOutgoingMessages) && state.chatNewOutgoingMessages.length > 0;
}

function hasSuccessEvidenceForActiveRun() {
  if (hasConfirmedChatReturn()) {
    return true;
  }

  if (state.activeRunRequestId) {
    var status = getHistoryStatusByRequestId(state.activeRunRequestId);
    if (status === "success") {
      return true;
    }
  }

  return false;
}

function getHistoryStatusByRequestId(requestId) {
  var needle = safeText(requestId, "");
  if (!needle) {
    return "";
  }
  var item = state.history.find(function (entry) {
    return safeText(entry && entry.requestId, "") === needle;
  });
  return item ? normalizeHistoryStatus(item.status) : "";
}

function hasActiveRunInProgress() {
  if (!state.activeRunRequestId) {
    return false;
  }
  var status = getHistoryStatusByRequestId(state.activeRunRequestId);
  if (status === "success" || status === "error") {
    return false;
  }
  return Boolean(state.monitorTimer || state.chatMonitorTimer);
}

function isAnyMonitorRunning() {
  return Boolean(state.monitorTimer || state.chatMonitorTimer || state.monitorBusy || state.chatMonitorBusy);
}

function stopN8nEventsPolling() {
  if (state.n8nEventsTimer) {
    clearInterval(state.n8nEventsTimer);
    state.n8nEventsTimer = null;
  }
}

function getN8nTimelineClient() {
  if (state.lastDiagnosticContext && state.lastDiagnosticContext.client) {
    return state.lastDiagnosticContext.client;
  }

  if (state.previewClientKey) {
    return state.previewClientKey;
  }

  return "";
}

function getActiveTimelineRequestFilter() {
  if (
    N8N_TIMELINE_STRICT_ACTIVE_REQUEST === true &&
    isAnyMonitorRunning() &&
    safeText(state.activeRunRequestId, "")
  ) {
    return safeText(state.activeRunRequestId, "");
  }
  return safeText(state.n8nFilterRequest, "");
}

function getForceCompleteRunningAfterMs(clientKey) {
  var key = normalizeClientKey(clientKey || state.previewClientKey || state.activeRunClientKey || "");
  var client = (Array.isArray(state.clients) ? state.clients : []).find(function (item) {
    return normalizeClientKey(item && item.key) === key;
  });
  var clientValue = Number(client && client.force_complete_running_after_ms || 0);
  if (Number.isFinite(clientValue) && clientValue > 0) {
    return Math.floor(clientValue);
  }
  return FORCE_COMPLETE_RUNNING_AFTER_MS;
}

function toTimelineType(event) {
  var category = safeText(event && event.category, "").toLowerCase();
  var status = safeText(event && event.status, "").toLowerCase();
  var eventType = safeText(event && event.event_type, "").toLowerCase();

  if (category === "webhook_dispatched") {
    return "info";
  }

  if (status === "success" || category.indexOf("success") >= 0) {
    return "success";
  }

  if (status === "error" || status === "failed" || eventType === "error" || category.indexOf("error") >= 0 || category.indexOf("failed") >= 0) {
    return "error";
  }

  if (status === "running" || status === "waiting" || status === "new" || category.indexOf("running") >= 0) {
    return "warning";
  }

  return "info";
}

function formatTimelineTime(value) {
  var date = new Date(value || "");
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toLocaleString("pt-BR");
}

function normalizeFilterText(value) {
  return safeText(value, "").toLowerCase();
}

function matchesTypeFilter(event, typeFilter) {
  var filter = safeText(typeFilter, "all").toLowerCase();
  if (filter === "all") {
    return true;
  }

  var timelineType = toTimelineType(event);
  if (filter === timelineType) {
    return true;
  }

  if (filter === "running") {
    var status = safeText(event && event.status, "").toLowerCase();
    return status === "running" || status === "new" || status === "waiting";
  }

  return false;
}

function matchesRequestFilter(event, requestFilter) {
  var needle = normalizeFilterText(requestFilter);
  if (!needle) {
    return true;
  }

  var fields = [
    event && event.request_id,
    event && event.execution_id,
    event && event.conversation_id,
    event && event.category,
    event && event.title,
    event && event.client,
  ];

  return fields.some(function (field) {
    return normalizeFilterText(field).indexOf(needle) >= 0;
  });
}

function isFinalTimelineEvent(event) {
  var category = safeText(event && event.category, "").toLowerCase();
  var status = safeText(event && event.status, "").toLowerCase();
  return (
    status === "success" ||
    status === "error" ||
    status === "failed" ||
    status === "crashed" ||
    category.indexOf("success") >= 0 ||
    category.indexOf("error") >= 0 ||
    category.indexOf("failed") >= 0
  );
}

function isRunningTimelineEvent(event) {
  var category = safeText(event && event.category, "").toLowerCase();
  var status = safeText(event && event.status, "").toLowerCase();
  return (
    status === "running" ||
    status === "new" ||
    status === "waiting" ||
    category.indexOf("running") >= 0
  );
}

function getEventsByRequestId(requestId) {
  var needle = safeText(requestId, "");
  if (!needle) {
    return [];
  }
  return (Array.isArray(state.n8nEvents) ? state.n8nEvents : []).filter(function (event) {
    return safeText(event && event.request_id, "") === needle;
  });
}

function resolveFinalEventFromRequestEvents(events) {
  var rows = Array.isArray(events) ? events : [];
  for (var i = 0; i < rows.length; i += 1) {
    var event = rows[i];
    if (isFinalTimelineEvent(event)) {
      return event;
    }
  }
  return null;
}

function reconcileActiveRunFromTimeline() {
  if (!state.activeRunRequestId) {
    return;
  }

  var events = getEventsByRequestId(state.activeRunRequestId);
  if (events.length === 0) {
    return;
  }

  var finalEvent = resolveFinalEventFromRequestEvents(events);
  if (finalEvent) {
    var type = toTimelineType(finalEvent);
    if (type === "success") {
      setPipelineStep(4);
      setStatus("Fluxo concluído no n8n.", false);
      updateHistoryByRequestId(
        state.activeRunRequestId,
        "success",
        safeText(finalEvent.likely_cause, "Fluxo concluído."),
      );
      stopMonitor();
      stopChatMonitor();
      return;
    }

    if (type === "error") {
      setPipelineStep(4);
      setStatus("Fluxo finalizado com erro no n8n.", true);
      updateHistoryByRequestId(
        state.activeRunRequestId,
        "error",
        safeText(finalEvent.likely_cause, "Fluxo finalizado com erro."),
      );
      stopMonitor();
      stopChatMonitor();
      return;
    }
  }

  if (hasConfirmedChatReturn()) {
    setPipelineStep(4);
    setStatus("Fluxo finalizado com retorno confirmado no Chatwoot.", false);
    updateHistoryByRequestId(state.activeRunRequestId, "success", "Retorno confirmado no Chatwoot.");
    stopMonitor();
  }
}

function collapseTimelineNoise(events) {
  var rows = Array.isArray(events) ? events : [];
  var hasFinalByRequest = new Set();
  rows.forEach(function (event) {
    var requestId = safeText(event && event.request_id, "");
    if (!requestId) {
      return;
    }
    if (isFinalTimelineEvent(event)) {
      hasFinalByRequest.add(requestId);
    }
  });

  var seenRunningByRequest = new Set();
  var cleaned = [];
  rows.forEach(function (event) {
    var requestId = safeText(event && event.request_id, "");

    if (requestId && hasFinalByRequest.has(requestId) && isRunningTimelineEvent(event)) {
      return;
    }

    if (requestId && safeText(event && event.category, "").toLowerCase() === "webhook_dispatched") {
      var hasMoreSpecificEvent = rows.some(function (candidate) {
        if (safeText(candidate && candidate.request_id, "") !== requestId) {
          return false;
        }
        var candidateCategory = safeText(candidate && candidate.category, "").toLowerCase();
        return candidateCategory !== "webhook_dispatched";
      });
      if (hasMoreSpecificEvent) {
        return;
      }
    }

    if (requestId && isRunningTimelineEvent(event)) {
      var runningKey = requestId + "|" + safeText(event && event.category, "").toLowerCase();
      if (seenRunningByRequest.has(runningKey)) {
        return;
      }
      seenRunningByRequest.add(runningKey);
    }

    cleaned.push(event);
  });

  return cleaned;
}

function buildSyntheticFinalEventsFromHistory(events) {
  var rows = Array.isArray(events) ? events : [];
  var synthetic = [];

  state.history.forEach(function (historyItem) {
    var requestId = safeText(historyItem && historyItem.requestId, "");
    var historyStatus = normalizeHistoryStatus(historyItem && historyItem.status);

    if (!requestId) {
      return;
    }
    if (historyStatus !== "success" && historyStatus !== "error") {
      return;
    }

    var hasFinalEvent = rows.some(function (event) {
      return safeText(event && event.request_id, "") === requestId && isFinalTimelineEvent(event);
    });
    if (hasFinalEvent) {
      return;
    }

    var hasRunningEvent = rows.some(function (event) {
      return safeText(event && event.request_id, "") === requestId && isRunningTimelineEvent(event);
    });
    if (!hasRunningEvent) {
      return;
    }

    synthetic.push({
      event_type: "status",
      source: "local_history",
      received_at: new Date().toISOString(),
      request_id: requestId,
      execution_id: null,
      workflow_name: null,
      failed_node: null,
      conversation_id: safeText(historyItem && historyItem.conversation, "") || null,
      client: safeText(historyItem && historyItem.client, "") || null,
      status: historyStatus,
      category: historyStatus === "success" ? "n8n_execution_success_local" : "n8n_execution_error_local",
      title: historyStatus === "success" ? "Execução finalizada (painel)" : "Execução finalizada com erro (painel)",
      likely_cause:
        historyStatus === "success"
          ? "Histórico local marcou o reprocessamento como concluído."
          : "Histórico local marcou o reprocessamento com erro.",
      suggestion:
        historyStatus === "success"
          ? "Execução considerada encerrada no painel."
          : "Verifique os detalhes da falha no diagnóstico e no n8n.",
    });
  });

  if (synthetic.length === 0) {
    return rows;
  }

  return synthetic.concat(rows);
}

function getFilteredN8nEvents() {
  var events = Array.isArray(state.n8nEvents) ? state.n8nEvents : [];
  var timelineBase = buildSyntheticFinalEventsFromHistory(events);
  var requestFilter = getActiveTimelineRequestFilter();
  var filtered = timelineBase.filter(function (event) {
    return (
      matchesTypeFilter(event, state.n8nFilterType) &&
      matchesRequestFilter(event, requestFilter)
    );
  });

  return collapseTimelineNoise(filtered);
}

function buildN8nEventsFingerprint(events) {
  var rows = Array.isArray(events) ? events : [];
  return rows.slice(0, 40).map(function (event) {
    return [
      safeText(event && event.event_type, ""),
      safeText(event && event.category, ""),
      safeText(event && event.request_id, ""),
      safeText(event && event.execution_id, ""),
      safeText(event && event.conversation_id, ""),
      safeText(event && event.received_at, ""),
    ].join("|");
  }).join("||");
}

function buildTimelineMergeKey(event) {
  var row = event && typeof event === "object" ? event : {};
  var requestId = safeText(row.request_id, "");
  var category = safeText(row.category, "").toLowerCase();
  var status = safeText(row.status, "").toLowerCase();
  var executionId = safeText(row.execution_id, "");

  if (requestId) {
    if (safeText(row.event_type, "").toLowerCase() === "execution") {
      return "execution|" + requestId + "|" + status;
    }
    if (category === "webhook_dispatched") {
      return "status|" + requestId + "|webhook_dispatched";
    }
    if (category === "n8n_execution_lookup_failed" || category === "n8n_execution_not_found") {
      return "status|" + requestId + "|" + category;
    }
    return safeText(row.event_type, "").toLowerCase() + "|" + requestId + "|" + category + "|" + executionId;
  }

  return [
    safeText(row.event_type, "").toLowerCase(),
    category,
    executionId,
    safeText(row.conversation_id, ""),
    safeText(row.received_at, ""),
  ].join("|");
}

function dedupeTimelineEventsPreservingOrder(events) {
  var rows = Array.isArray(events) ? events : [];
  var seen = new Set();
  var output = [];

  rows.forEach(function (event) {
    var key = buildTimelineMergeKey(event);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    output.push(event);
  });

  return output;
}

function pushLocalN8nTimelineEvent(event) {
  var normalized = Object.assign(
    {
      event_type: "status",
      received_at: new Date().toISOString(),
      category: "flow_status",
      title: "Status local",
      likely_cause: "Evento local registrado.",
      suggestion: "Verifique os detalhes no painel.",
      source: "local_ui",
      request_id: state.activeRunRequestId || null,
      client: state.previewClientKey || null,
      conversation_id: getConversationId() || null,
    },
    event || {},
  );

  state.localN8nEvents = [normalized].concat(Array.isArray(state.localN8nEvents) ? state.localN8nEvents : []).slice(0, 20);
  var serverEvents = (Array.isArray(state.n8nEvents) ? state.n8nEvents : []).filter(function (item) {
    return safeText(item && item.source, "") !== "local_ui";
  });
  var merged = dedupeTimelineEventsPreservingOrder(state.localN8nEvents.concat(serverEvents));
  state.n8nEvents = merged.slice(0, 100);
  state.n8nEventsFingerprint = buildN8nEventsFingerprint(state.n8nEvents);
  renderN8nEvents();
  reconcileActiveRunFromTimeline();
}

function applyTimelineTypeClass(node, type) {
  if (!node) {
    return;
  }

  node.classList.remove("is-success", "is-error", "is-warning", "is-info");
  if (type === "success") {
    node.classList.add("is-success");
    return;
  }

  if (type === "error") {
    node.classList.add("is-error");
    return;
  }

  if (type === "warning") {
    node.classList.add("is-warning");
    return;
  }

  node.classList.add("is-info");
}

function renderN8nEvents() {
  if (!hasEl("n8nEventsFeed")) {
    return;
  }

  el.n8nEventsFeed.innerHTML = "";

  var filteredEvents = getFilteredN8nEvents();
  if (!Array.isArray(filteredEvents) || filteredEvents.length === 0) {
    var empty = document.createElement("div");
    empty.className = "timeline-item";
    var hasAnyData = Array.isArray(state.n8nEvents) && state.n8nEvents.length > 0;
    empty.innerHTML = hasAnyData
      ? '<div class="title">Nenhum evento para esse filtro</div><div class="desc">Ajuste os filtros para visualizar os eventos.</div>'
      : '<div class="title">Sem eventos do n8n ainda</div><div class="desc">Envie um reprocessamento para acompanhar a timeline.</div>';
    el.n8nEventsFeed.appendChild(empty);
    if (hasEl("n8nPageInfo")) {
      el.n8nPageInfo.textContent = "0 / 0";
    }
    if (hasEl("n8nPrevBtn")) {
      el.n8nPrevBtn.disabled = true;
    }
    if (hasEl("n8nNextBtn")) {
      el.n8nNextBtn.disabled = true;
    }
    return;
  }

  var totalPages = Math.max(1, Math.ceil(filteredEvents.length / N8N_TIMELINE_PAGE_SIZE));
  if (state.n8nPage < 1) {
    state.n8nPage = 1;
  }
  if (state.n8nPage > totalPages) {
    state.n8nPage = totalPages;
  }
  var start = (state.n8nPage - 1) * N8N_TIMELINE_PAGE_SIZE;
  var pageEvents = filteredEvents.slice(start, start + N8N_TIMELINE_PAGE_SIZE);

  pageEvents.forEach(function (event) {
    var type = toTimelineType(event);
    var item = document.createElement("div");
    item.className = "timeline-item";
    applyTimelineTypeClass(item, type);

    var title = normalizeLegacyPtBr(safeText(event.title || event.category, "Evento n8n"));
    var desc =
      normalizeLegacyPtBr(stripJsonFromText(event.likely_cause)) ||
      normalizeLegacyPtBr(stripJsonFromText(event.error_description)) ||
      normalizeLegacyPtBr(stripJsonFromText(event.error_message)) ||
      "-";
    var when = formatTimelineTime(event.received_at);
    var workflow = safeText(event.workflow_name, "-");
    var node = safeText(event.failed_node, "-");
    var execution = safeText(event.execution_id, "-");
    var requestId = safeText(event.request_id, "-");

    item.innerHTML =
      '<div class="head">' +
      '<span class="title">' + escapeHtml(title) + '</span>' +
      '<span class="meta">' + escapeHtml(when) + "</span>" +
      "</div>" +
      '<div class="desc">' + escapeHtml(desc) + "</div>" +
      '<div class="tags">' +
      '<span class="timeline-tag ' + type + '">' + escapeHtml(normalizeLegacyPtBr(safeText(event.category, "status"))) + "</span>" +
      '<span class="timeline-tag">workflow: ' + escapeHtml(workflow) + "</span>" +
      '<span class="timeline-tag">node: ' + escapeHtml(node) + "</span>" +
      '<span class="timeline-tag">exec: ' + escapeHtml(execution) + "</span>" +
      '<span class="timeline-tag">req: ' + escapeHtml(requestId) + "</span>" +
      "</div>";

    el.n8nEventsFeed.appendChild(item);
  });

  if (hasEl("n8nPageInfo")) {
    el.n8nPageInfo.textContent = state.n8nPage + " / " + totalPages;
  }
  if (hasEl("n8nPrevBtn")) {
    el.n8nPrevBtn.disabled = state.n8nPage <= 1;
  }
  if (hasEl("n8nNextBtn")) {
    el.n8nNextBtn.disabled = state.n8nPage >= totalPages;
  }
}

async function fetchN8nEvents(options) {
  var opts = options || {};
  var silent = opts.silent === true;
  var limit = Number(opts.limit || 30);
  var client = opts.client || getN8nTimelineClient();
  var requestId = safeText(opts.requestId || getActiveTimelineRequestFilter(), "");
  var params = new URLSearchParams();
  params.set("limit", String(Math.max(5, Math.min(limit, 100))));
  if (client) {
    params.set("client", client);
  }
  if (requestId) {
    params.set("request_id", requestId);
  }

  try {
    var response = await fetch("/api/reprocess/n8n/events?" + params.toString());
    var data = await readJsonSafe(response);

    if (!response.ok || !data || !data.success) {
      if (!silent) {
        setStatus("Falha ao atualizar timeline n8n.", true);
      }
      return;
    }

    var incoming = Array.isArray(data.events) ? data.events : [];
    var localEvents = (Array.isArray(state.localN8nEvents) ? state.localN8nEvents : []).filter(function (event) {
      if (!requestId) {
        return true;
      }
      return safeText(event && event.request_id, "") === requestId;
    });
    var combined = dedupeTimelineEventsPreservingOrder(localEvents.concat(incoming));
    var fingerprint = buildN8nEventsFingerprint(combined);
    if (fingerprint === state.n8nEventsFingerprint) {
      return;
    }

    state.n8nEvents = combined;
    state.n8nEventsFingerprint = fingerprint;
    renderN8nEvents();
    reconcileActiveRunFromTimeline();
  } catch {
    if (!silent) {
      setStatus("Falha de rede ao atualizar timeline n8n.", true);
    }
  }
}

function startN8nEventsPolling() {
  stopN8nEventsPolling();
  state.n8nEventsTimer = setInterval(function () {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }
    fetchN8nEvents({ silent: true, limit: 30 });
    fetchDashboardStats({ silent: true });
  }, 15000);
}

function resetDiagnostic() {
  if (!hasEl("diagnosticPanel")) {
    return;
  }
  el.diagnosticPanel.classList.remove("is-visible", "is-error", "is-warning", "is-success", "is-info");
  var diagHeader = el.diagnosticPanel.querySelector(".diag-header");
  if (diagHeader) {
    diagHeader.innerHTML = "&#9888; Diagnóstico de falha";
  }
  el.dCode.textContent = "-";
  el.dTitle.textContent = "-";
  el.dCause.textContent = "-";
  el.dSuggestion.textContent = "-";
  el.dUpstream.textContent = "-";
  el.dRequest.textContent = "-";
  el.dWorkflow.textContent = "-";
  el.dNode.textContent = "-";
  el.dExecution.textContent = "-";
  el.dFlowMessage.textContent = "-";
  state.lastDiagnosticContext = null;
  if (hasEl("n8nLookupBtn")) {
    el.n8nLookupBtn.disabled = true;
  }
  stopMonitor();
}

function applyDiagnosticTone(level) {
  if (!hasEl("diagnosticPanel")) {
    return;
  }

  var tone = safeText(level, "info").toLowerCase();
  var diagHeader = el.diagnosticPanel.querySelector(".diag-header");

  el.diagnosticPanel.classList.remove("is-error", "is-warning", "is-success", "is-info");

  if (tone === "error") {
    el.diagnosticPanel.classList.add("is-error");
    if (diagHeader) {
      diagHeader.innerHTML = "&#9888; Diagnóstico de falha";
    }
    return;
  }

  if (tone === "warning") {
    el.diagnosticPanel.classList.add("is-warning");
    if (diagHeader) {
      diagHeader.innerHTML = "&#9888; Diagnóstico de atenção";
    }
    return;
  }

  if (tone === "success") {
    el.diagnosticPanel.classList.add("is-success");
    if (diagHeader) {
      diagHeader.innerHTML = "&#10003; Status do fluxo";
    }
    return;
  }

  el.diagnosticPanel.classList.add("is-info");
  if (diagHeader) {
    diagHeader.innerHTML = "&#9432; Status do fluxo";
  }
}

function resetPreviewState() {
  state.previewPayload = null;
  state.previewOriginalPayload = null;
  state.previewMediaMeta = null;
  state.previewClientKey = "";
  state.pauseStatusPreview = null;
  state.localN8nEvents = [];
  state.n8nEvents = [];
  state.n8nEventsFingerprint = "";
  state.n8nPage = 1;
  stopPreviewProgressTimer();
  if (hasEl("previewProgressWrap")) {
    el.previewProgressWrap.classList.remove("is-visible", "is-error");
  }
  el.executeBtn.disabled = true;
  resetDiagnostic();
  el.companyLogoArea.classList.remove("is-visible");
  state.currentConversationUrl = "";
  resetChatState();
  renderPauseSummary(null);
  renderPauseWarning(null);
  renderMediaStatus(null);
  if (hasEl("editedMessage")) {
    el.editedMessage.value = "";
  }
  setChatPreviewStatus("Aguardando preview da conversa...");
  setPipelineStep(0);
  renderN8nEvents();
}

function showCards(hasData) {
  if (el.resultsSection) {
    el.resultsSection.style.display = hasData ? "block" : "none";
  }
}

var PER_PAGE = 5;

function renderHistory() {
  if (!hasEl("historyBody") || !hasEl("historyPagination")) {
    return;
  }
  el.historyBody.innerHTML = "";
  el.historyPagination.innerHTML = "";

  if (state.history.length === 0) {
    var empty = document.createElement("tr");
    empty.innerHTML = '<td colspan="6" style="padding:24px;text-align:center;color:var(--muted);font-size:.85rem">Nenhum reprocessamento ainda nesta sessão.</td>';
    el.historyBody.appendChild(empty);
    updateDashboardStats();
    renderQueueControl();
    return;
  }

  var totalPages = Math.max(1, Math.ceil(state.history.length / PER_PAGE));
  if (state.historyPage > totalPages) state.historyPage = totalPages;
  if (state.historyPage < 1) state.historyPage = 1;

  var start = (state.historyPage - 1) * PER_PAGE;
  var end = Math.min(start + PER_PAGE, state.history.length);
  var pageItems = state.history.slice(start, end);

  pageItems.forEach(function (item) {
    var tr = document.createElement("tr");
    var normalizedStatus = normalizeHistoryStatus(item.status);
    var statusClass =
      normalizedStatus === "success"
        ? "success"
        : normalizedStatus === "error"
          ? "error"
          : normalizedStatus === "paused"
            ? "warning"
            : normalizedStatus === "running"
              ? "warning"
              : "neutral";
    var statusLabel =
      normalizedStatus === "success"
        ? "Sucesso"
        : normalizedStatus === "error"
          ? "Erro"
          : normalizedStatus === "paused"
            ? "Pausado"
            : normalizedStatus === "running"
              ? "Em andamento"
              : "Aviso";
    tr.innerHTML =
      '<td class="mono">' + escapeHtml(item.id) + "</td>" +
      '<td class="mono">' + escapeHtml(item.conversation) + "</td>" +
      '<td><span class="client-tag">' + escapeHtml(formatClientKeyForDisplay(item.client)) + "</span></td>" +
      '<td><span class="status-pill ' + statusClass + '">' + escapeHtml(statusLabel) + "</span></td>" +
      '<td style="color:var(--muted)">' + escapeHtml(item.date) + "</td>" +
      '<td style="color:var(--muted)">' + escapeHtml(item.duration) + "</td>";
    el.historyBody.appendChild(tr);
  });

  if (totalPages > 1) {
    var prevBtn = document.createElement("button");
    prevBtn.textContent = "< Anterior";
    prevBtn.disabled = state.historyPage <= 1;
    prevBtn.addEventListener("click", function () {
      if (state.historyPage > 1) { state.historyPage--; renderHistory(); }
    });

    var nextBtn = document.createElement("button");
    nextBtn.textContent = "Próximo >";
    nextBtn.disabled = state.historyPage >= totalPages;
    nextBtn.addEventListener("click", function () {
      if (state.historyPage < totalPages) { state.historyPage++; renderHistory(); }
    });

    var infoSpan = document.createElement("span");
    infoSpan.className = "page-info";
    infoSpan.textContent = state.historyPage + " / " + totalPages;

    el.historyPagination.appendChild(prevBtn);

    for (var p = 1; p <= totalPages; p++) {
      var pageBtn = document.createElement("button");
      pageBtn.textContent = p;
      if (p === state.historyPage) pageBtn.className = "active";
      pageBtn.addEventListener("click", (function (page) {
        return function () { state.historyPage = page; renderHistory(); };
      })(p));
      el.historyPagination.appendChild(pageBtn);
    }

    el.historyPagination.appendChild(infoSpan);
    el.historyPagination.appendChild(nextBtn);
  }

  updateDashboardStats();
  renderQueueControl();
}

function renderActivity() {
  if (!hasEl("activityFeed")) {
    return;
  }
  el.activityFeed.innerHTML = "";

  if (state.activity.length === 0) {
    var empty = document.createElement("div");
    empty.className = "activity-item";
    empty.innerHTML = '<div class="content"><div class="title">Sem eventos por enquanto</div><div class="desc">As execuções e erros aparecerão aqui.</div></div>';
    el.activityFeed.appendChild(empty);
    if (hasEl("activityPageInfo")) {
      el.activityPageInfo.textContent = "0 / 0";
    }
    if (hasEl("activityPrevBtn")) {
      el.activityPrevBtn.disabled = true;
    }
    if (hasEl("activityNextBtn")) {
      el.activityNextBtn.disabled = true;
    }
    return;
  }

  var totalPages = Math.max(1, Math.ceil(state.activity.length / ACTIVITY_PAGE_SIZE));
  if (state.activityPage < 1) {
    state.activityPage = 1;
  }
  if (state.activityPage > totalPages) {
    state.activityPage = totalPages;
  }

  var start = (state.activityPage - 1) * ACTIVITY_PAGE_SIZE;
  var items = state.activity.slice(start, start + ACTIVITY_PAGE_SIZE);

  items.forEach(function (item) {
    var div = document.createElement("div");
    div.className = "activity-item";
    var type = item.type === "success" ? "success" : item.type === "error" ? "error" : "warning";
    var icon = type === 'success' ? '&#10003;' : type === 'error' ? '&#10007;' : '&#33;';
    div.innerHTML =
      '<span class="dot ' + type + '">' + icon + '</span>' +
      '<div class="content"><div class="title">' + escapeHtml(item.title) + '</div><div class="desc">' + escapeHtml(item.desc) + "</div></div>" +
      '<span class="time">' + escapeHtml(item.time) + "</span>";
    el.activityFeed.appendChild(div);
  });

  if (hasEl("activityPageInfo")) {
    el.activityPageInfo.textContent = state.activityPage + " / " + totalPages;
  }
  if (hasEl("activityPrevBtn")) {
    el.activityPrevBtn.disabled = state.activityPage <= 1;
  }
  if (hasEl("activityNextBtn")) {
    el.activityNextBtn.disabled = state.activityPage >= totalPages;
  }
}

function pushHistory(status, message) {
  var now = new Date();
  var item = {
    id: "RP-" + String(now.getTime()).slice(-6),
    conversation: getConversationId() || "-",
    client: state.previewClientKey || "-",
    status: normalizeHistoryStatus(status),
    message: safeText(message, "-"),
    date: now.toLocaleString("pt-BR"),
    duration: "-",
    requestId: safeText(state.activeRunRequestId, ""),
  };
  state.history.unshift(item);
  state.historyPage = 1;
  writeStorageJson(HISTORY_STORAGE_KEY, state.history.slice(0, 200));
  renderHistory();
  fetchDashboardStats({ silent: true });
  return item.id;
}

function normalizeHistoryStatus(value) {
  var status = safeText(value, "").toLowerCase();
  if (status === "failed") {
    return "error";
  }
  if (status === "running" || status === "pending" || status === "new" || status === "waiting" || status === "in_progress" || status === "warning") {
    return "running";
  }
  if (status === "paused" || status === "skipped") {
    return "paused";
  }
  if (status === "success") {
    return "success";
  }
  if (status === "error") {
    return "error";
  }
  return "neutral";
}

function isHistoryTerminalStatus(status) {
  var normalized = normalizeHistoryStatus(status);
  return normalized === "success" || normalized === "error" || normalized === "paused";
}

function getPendingQueueEntries() {
  return state.history.filter(function (item) {
    return !isHistoryTerminalStatus(item && item.status);
  });
}

function hasPendingRunForClient(clientKey) {
  var normalizedClient = safeText(clientKey, "");
  if (!normalizedClient) {
    return false;
  }

  return getPendingQueueEntries().some(function (entry) {
    return safeText(entry && entry.client, "") === normalizedClient;
  });
}

function renderQueueControl() {
  if (!hasEl("queueList") || !hasEl("queuePendingCount")) {
    return;
  }

  var pending = getPendingQueueEntries();
  el.queuePendingCount.textContent = String(pending.length);
  el.queueList.innerHTML = "";

  if (pending.length === 0) {
    var empty = document.createElement("div");
    empty.className = "queue-empty";
    empty.textContent = "Sem pendências na fila local.";
    el.queueList.appendChild(empty);
    return;
  }

  pending.slice(0, 80).forEach(function (entry) {
    var row = document.createElement("div");
    row.className = "queue-row";
    row.setAttribute("data-history-id", safeText(entry && entry.id, ""));

    var client = formatClientKeyForDisplay(entry && entry.client);
    var conversation = safeText(entry && entry.conversation, "-");
    var requestId = safeText(entry && entry.requestId, "-");
    var status = normalizeHistoryStatus(entry && entry.status);

    row.innerHTML =
      '<div class="queue-main">' +
      '<span class="queue-pill running">' + (status === "running" ? "Em andamento" : "Pendente") + "</span>" +
      '<span class="queue-pill">cliente: ' + escapeHtml(client) + "</span>" +
      '<span class="queue-pill">conversa: ' + escapeHtml(conversation) + "</span>" +
      '<span class="queue-meta">req: ' + escapeHtml(requestId) + "</span>" +
      "</div>" +
      '<button class="queue-remove-btn" type="button" data-remove-id="' + escapeHtml(safeText(entry && entry.id, "")) + '">Remover</button>';

    el.queueList.appendChild(row);
  });
}

function removeQueueEntryByHistoryId(historyId) {
  var needle = safeText(historyId, "");
  if (!needle) {
    return;
  }

  state.history = state.history.filter(function (item) {
    return safeText(item && item.id, "") !== needle;
  });

  writeStorageJson(HISTORY_STORAGE_KEY, state.history.slice(0, 200));
  renderHistory();
  showToast("Item removido da fila local.", "success");
}

function dedupePendingQueue() {
  var seen = new Set();
  var removed = 0;

  state.history = state.history.filter(function (item) {
    var status = normalizeHistoryStatus(item && item.status);
    if (isHistoryTerminalStatus(status)) {
      return true;
    }

    var key =
      safeText(item && item.client, "-") +
      "|" +
      safeText(item && item.conversation, "-");

    if (seen.has(key)) {
      removed += 1;
      return false;
    }

    seen.add(key);
    return true;
  });

  writeStorageJson(HISTORY_STORAGE_KEY, state.history.slice(0, 200));
  renderHistory();
  showToast(
    removed > 0
      ? String(removed) + " duplicata(s) removida(s) da fila local."
      : "Nenhuma duplicata pendente encontrada.",
    removed > 0 ? "success" : "error",
  );
}

function clearPendingQueue() {
  var pendingBefore = getPendingQueueEntries().length;
  if (pendingBefore === 0) {
    showToast("Fila já está vazia.", "error");
    return;
  }

  state.history = state.history.filter(function (item) {
    return isHistoryTerminalStatus(item && item.status);
  });

  state.activeRunRequestId = "";
  state.activeRunStartedAt = 0;
  state.activeRunClientKey = "";
  stopMonitor();
  stopChatMonitor();
  writeStorageJson(HISTORY_STORAGE_KEY, state.history.slice(0, 200));
  renderHistory();
  setStatus("Pendências da fila local foram limpas.", false);
  showToast("Fila pendente limpa com sucesso.", "success");
}

function shouldReplaceHistoryStatus(currentStatus, nextStatus) {
  var current = normalizeHistoryStatus(currentStatus);
  var next = normalizeHistoryStatus(nextStatus);

  if (current === next) {
    return true;
  }

  if (current === "success" && next !== "success") {
    return false;
  }

  if (next === "success") {
    return true;
  }

  if (current === "error" && (next === "running" || next === "neutral")) {
    return false;
  }

  if ((current === "running" || current === "neutral" || current === "paused") && next === "error") {
    return true;
  }

  if (current === "running" && next === "paused") {
    return true;
  }

  return true;
}

function updateHistoryByRequestId(requestId, status, message) {
  var needle = safeText(requestId, "");
  if (!needle) {
    return false;
  }

  var idx = state.history.findIndex(function (item) {
    return safeText(item && item.requestId, "") === needle;
  });
  if (idx < 0) {
    return false;
  }

  var duration = "-";
  if (state.activeRunStartedAt > 0) {
    var elapsedMs = Date.now() - state.activeRunStartedAt;
    if (elapsedMs >= 0) {
      var totalSec = Math.floor(elapsedMs / 1000);
      var min = Math.floor(totalSec / 60);
      var sec = totalSec % 60;
      duration = min > 0 ? (min + "m " + String(sec).padStart(2, "0") + "s") : (sec + "s");
    }
  }

  if (shouldReplaceHistoryStatus(state.history[idx].status, status)) {
    state.history[idx].status = normalizeHistoryStatus(status);
  }
  if (safeText(message, "")) {
    state.history[idx].message = safeText(message, "");
  }
  state.history[idx].duration = duration;

  if (
    safeText(state.activeRunRequestId, "") &&
    safeText(state.activeRunRequestId, "") === needle &&
    isHistoryTerminalStatus(state.history[idx].status)
  ) {
    state.activeRunRequestId = "";
    state.activeRunStartedAt = 0;
    state.activeRunClientKey = "";
  }

  writeStorageJson(HISTORY_STORAGE_KEY, state.history.slice(0, 200));
  renderHistory();
  fetchDashboardStats({ silent: true });

  var finalizedStatus = normalizeHistoryStatus(state.history[idx] && state.history[idx].status);
  if (
    needle &&
    (finalizedStatus === "success" || finalizedStatus === "error" || finalizedStatus === "paused")
  ) {
    fetch("/api/reprocess/executions/finalize-local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_id: needle,
        status: finalizedStatus,
        message: safeText(state.history[idx] && state.history[idx].message, message || ""),
      }),
    })
      .then(function () { return fetchDashboardStats({ silent: true }); })
      .catch(function () { return null; });
  }

  return true;
}

function pushActivity(type, title, desc) {
  state.activity.unshift({
    type: type,
    title: truncateText(title, 90),
    desc: truncateText(desc, 240),
    time: new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
  });
  state.activity = state.activity.slice(0, ACTIVITY_MAX_ITEMS);
  state.activityPage = 1;
  writeStorageJson(ACTIVITY_STORAGE_KEY, state.activity);
  renderActivity();
}

async function readJsonSafe(response) {
  var raw = await response.text();
  try {
    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    return {
      success: false,
      error: "non_json_response",
      message: raw || "Resposta não JSON.",
    };
  }
}

async function loadClients() {
  var attempts = 2;
  var lastError = null;

  for (var attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      var response = await fetch("/api/reprocess/clients");
      var data = await readJsonSafe(response);

      if (!response.ok || !data || !data.success) {
        throw new Error((data && data.message) || "Falha ao carregar clientes.");
      }

      state.clients = Array.isArray(data.clients) ? data.clients : [];
      if (!hasEl("clientSelect")) {
        return;
      }

      el.clientSelect.innerHTML = '<option value="">Detectar automaticamente</option>';

      state.clients.forEach(function (client) {
        var option = document.createElement("option");
        option.value = client.key;
        option.textContent = client.name + (client.key ? " (" + formatClientKeyForDisplay(client.key) + ")" : "");
        el.clientSelect.appendChild(option);
      });

      updateDashboardStats();
      setStatus("Pronto. Cole o link da conversa.", false);
      if (hasEl("previewBtn")) {
        el.previewBtn.disabled = false;
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await wait(500);
      }
    }
  }

  setStatus("Erro ao carregar clientes: " + safeText(lastError && lastError.message, "erro"), true);
  if (hasEl("previewBtn")) {
    el.previewBtn.disabled = true;
  }
}

function maybeReloadClientsIfMissing() {
  if (!hasEl("clientSelect")) {
    return;
  }

  var optionsCount = el.clientSelect.options ? el.clientSelect.options.length : 0;
  if (optionsCount <= 1) {
    loadClients();
  }
}

function parseMessageCount() {
  var value = Number(el.messageCount.value || 1);
  if (!Number.isFinite(value) || value <= 0) {
    return 1;
  }
  return Math.min(Math.floor(value), 20);
}

function formatReceivedAt(body) {
  var createdAt =
    (body.messages && body.messages[0] && Number(body.messages[0].created_at || 0)) ||
    Number(body.created_at || 0);

  if (!createdAt) {
    return "-";
  }

  var date = new Date(createdAt * 1000);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return date.toLocaleString("pt-BR");
}

function renderPauseSummary(pausePreview) {
  if (!hasEl("sPauseStatus") || !hasEl("sPauseDetails")) {
    return;
  }
  var data = pausePreview && typeof pausePreview === "object" ? pausePreview : null;
  var pauseStatus = data && data.pause_status && typeof data.pause_status === "object"
    ? data.pause_status
    : null;

  if (!pauseStatus) {
    el.sPauseStatus.textContent = "-";
    el.sPauseDetails.textContent = "-";
    renderPauseWarning(null);
    if (hasEl("removePauseBtn")) {
      el.removePauseBtn.disabled = true;
    }
    syncExecuteButtonStateFromPreview();
    return;
  }

  var statusLabel = "-";
  if (pauseStatus.paused === true) {
    statusLabel = "PAUSADO";
  } else if (pauseStatus.checked === true) {
    statusLabel = "ATIVO";
  } else {
    statusLabel = "NAO VERIFICADO";
  }

  var table = safeText(pauseStatus.table, "-");
  var column = safeText(pauseStatus.phone_column, "-");
  var matched = safeText(pauseStatus.matched_phone, "-");
  var reason = safeText(pauseStatus.reason, "-");
  var source = safeText(pauseStatus.pause_table_source, "-");

  el.sPauseStatus.textContent = statusLabel;
  el.sPauseDetails.textContent =
    "tabela=" + table +
    " | coluna=" + column +
    " | match=" + matched +
    " | origem=" + source +
    " | reason=" + reason;
  renderPauseWarning(pauseStatus);
  if (hasEl("removePauseBtn")) {
    var canRemove = Boolean(
      pauseStatus.paused === true &&
      state.previewPayload &&
      state.previewClientKey,
    );
    el.removePauseBtn.disabled = !canRemove;
  }

  syncExecuteButtonStateFromPreview();
}

function syncExecuteButtonStateFromPreview() {
  if (!hasEl("executeBtn")) {
    return;
  }

  var hasPreview = Boolean(state.previewPayload && state.previewClientKey);
  var isPaused = Boolean(
    state.pauseStatusPreview &&
      state.pauseStatusPreview.pause_status &&
      state.pauseStatusPreview.pause_status.paused === true,
  );

  el.executeBtn.disabled = !hasPreview || isPaused;
}

async function fetchPauseStatusPreview(options) {
  var opts = options || {};
  var silent = opts.silent === true;
  var payload = opts.payload || state.previewPayload;
  var client = safeText(opts.client || state.previewClientKey, "");

  if (!payload || !client) {
    state.pauseStatusPreview = null;
    renderPauseSummary(null);
    return null;
  }

  try {
    var response = await fetch("/api/reprocess/pause-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client: client,
        payload: payload,
      }),
    });
    var data = await readJsonSafe(response);

    if (!response.ok || !data || !data.success) {
      if (!silent) {
        setStatus(
          normalizeBackendErrorMessage(
            safeText(data && data.message, "Falha ao consultar status de pausa."),
          ),
          true,
        );
      }
      state.pauseStatusPreview = null;
      renderPauseSummary(null);
      return null;
    }

    state.pauseStatusPreview = data;
    renderPauseSummary(data);
    return data;
  } catch (error) {
    if (!silent) {
      setStatus(
        "Erro ao consultar status de pausa: " +
          normalizeBackendErrorMessage(safeText(error && error.message, "erro")),
        true,
      );
    }
    state.pauseStatusPreview = null;
    renderPauseSummary(null);
    return null;
  }
}

function fillSummary(previewData) {
  if (!hasEl("sAccount")) {
    return;
  }
  var item = Array.isArray(previewData) ? previewData[0] : null;
  var body = (item && item.body) || {};
  var firstMessage = (body.messages && body.messages[0]) || {};
  var sender = (body.meta && body.meta.sender) || firstMessage.sender || {};
  var conversationId = body.conversation_id || body.id || "-";

  el.sAccount.textContent = safeText(firstMessage.account_id, "-");
  el.sConversation.textContent = safeText(conversationId, "-");
  el.sContact.textContent = safeText(sender.name, "-");
  el.sPhone.textContent = safeText(sender.phone_number, "-");
  var summaryMessage = safeText(firstMessage.content, "-");
  el.sMessage.innerHTML = '<div class="summary-message" title="' + escapeHtml(summaryMessage) + '">' + escapeHtml(summaryMessage) + "</div>";
  el.sReceived.textContent = formatReceivedAt(body);
  el.sDetected.textContent = formatClientKeyForDisplay(state.previewClientKey);
  el.sWebhook.textContent = safeText(item && item.webhookUrl, "-");
  el.summaryBadge.textContent = conversationId !== "-" ? "#" + conversationId : "-";
  renderPauseSummary(state.pauseStatusPreview);

  var normalizedClientKey = normalizeClientKey(state.previewClientKey);
  var logoPath = COMPANY_LOGOS[normalizedClientKey] || COMPANY_LOGOS[state.previewClientKey];
  if (logoPath) {
    var logoStyle = COMPANY_LOGO_STYLE[normalizedClientKey] || "default";
    el.companyLogoArea.classList.remove("logo-ink-dark");
    if (logoStyle === "ink-dark") {
      el.companyLogoArea.classList.add("logo-ink-dark");
    }
    var fallbackLogo = normalizedClientKey.indexOf("vai-xor") >= 0
      ? "/logos/vaixorartintaslogo.png"
      : "";
    el.companyLogoArea.classList.add("is-visible");
    el.companyLogoImg.alt = "";
    el.companyLogoImg.onerror = function () {
      if (fallbackLogo && el.companyLogoImg.src.indexOf(fallbackLogo) < 0) {
        el.companyLogoImg.src = fallbackLogo;
        return;
      }
      el.companyLogoArea.classList.remove("is-visible");
      el.companyLogoArea.classList.remove("logo-ink-dark");
    };
    if (fallbackLogo) {
      el.companyLogoImg.src = logoPath;
    } else {
      el.companyLogoImg.src = logoPath;
    }

  } else {
    el.companyLogoArea.classList.remove("logo-ink-dark");
    el.companyLogoArea.classList.remove("is-visible");
  }
}

async function removePauseForCurrentPreview() {
  if (!state.previewPayload || !state.previewClientKey) {
    setStatus("Gere o preview antes de remover a pausa.", true);
    return;
  }

  if (state.pauseStatusPreview && state.pauseStatusPreview.pause_status && state.pauseStatusPreview.pause_status.paused !== true) {
    setStatus("Contato nao esta pausado no momento.", true);
    return;
  }

  if (hasEl("removePauseBtn")) {
    el.removePauseBtn.disabled = true;
  }

  setStatus("Removendo contato da tabela de pausa...", false);

  try {
    const response = await fetch("/api/reprocess/pause-remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client: state.previewClientKey,
        payload: state.previewPayload,
      }),
    });
    const data = await readJsonSafe(response);

    if (!response.ok || !data || !data.success) {
      setStatus(
        normalizeBackendErrorMessage(
          safeText(data && data.message, "Falha ao remover contato da pausa."),
        ),
        true,
      );
      pushActivity(
        "error",
        "Falha ao remover pausa",
        normalizeBackendErrorMessage(
          safeText(data && data.message, "Erro desconhecido ao remover pausa."),
        ),
      );
      showToast("Falha ao remover da IA pausada.", "error");
      return;
    }

    const removed = Boolean(data && data.pause_remove && data.pause_remove.removed);
    if (removed) {
      if (
        state.pauseStatusPreview &&
        state.pauseStatusPreview.pause_status &&
        typeof state.pauseStatusPreview.pause_status === "object"
      ) {
        state.pauseStatusPreview.pause_status.paused = false;
        state.pauseStatusPreview.pause_status.checked = true;
        state.pauseStatusPreview.pause_status.reason = "removed_manually";
        state.pauseStatusPreview.pause_status.matched_phone = "";
      }
      setStatus("Contato removido da IA pausada com sucesso.", false);
      pushActivity(
        "success",
        "Contato despausado",
        "Registro removido da tabela de pausa no Supabase.",
      );
      showToast("Contato removido da IA pausada.", "success");
      if (hasEl("sPauseStatus")) {
        el.sPauseStatus.textContent = "REMOVIDO AGORA";
      }
      if (hasEl("sPauseDetails")) {
        el.sPauseDetails.textContent = "Registro removido manualmente via painel.";
      }
      if (hasEl("removePauseBtn")) {
        el.removePauseBtn.textContent = "Removido com sucesso";
      }
      renderPauseSummary(state.pauseStatusPreview);
    } else {
      setStatus("Contato nao encontrado na tabela de pausa.", true);
      pushActivity(
        "warning",
        "Contato nao encontrado",
        "Nenhum registro foi removido da tabela de pausa.",
      );
      showToast("Nenhum registro de pausa encontrado para remover.", "error");
    }

    await fetchPauseStatusPreview({
      silent: true,
      payload: state.previewPayload,
      client: state.previewClientKey,
    });
  } catch (error) {
    var normalizedRemoveError = normalizeBackendErrorMessage(safeText(error && error.message, "erro"));
    setStatus("Erro ao remover pausa: " + normalizedRemoveError, true);
    pushActivity("error", "Erro de rede", normalizedRemoveError);
    showToast("Erro de rede ao remover da IA pausada.", "error");
  } finally {
    renderPauseSummary(state.pauseStatusPreview);
    syncExecuteButtonStateFromPreview();
  }
}

function setPipelineStep(index) {
  if (!el.pipelineSteps) {
    return;
  }

  var steps = el.pipelineSteps.querySelectorAll(".pipeline-step");
  steps.forEach(function (step, i) {
    step.classList.toggle("active", i === index);
    step.classList.toggle("done", i < index);
  });
}

function bounceCounter(node) {
  if (!node) {
    return;
  }
  node.classList.remove("animate-count");
  void node.offsetHeight;
  node.classList.add("animate-count");
}

function setStatCard(selector, value, percent) {
  var valueNode = document.querySelector(selector + " .stat-value");
  var fillNode = document.querySelector(selector + " .stat-bar-fill");
  if (valueNode) {
    valueNode.textContent = String(value);
    bounceCounter(valueNode);
  }
  if (fillNode) {
    var safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
    fillNode.style.width = safePercent + "%";
  }
}

async function fetchDashboardStats(options) {
  var opts = options || {};
  var silent = opts.silent === true;

  try {
    var response = await fetch("/api/reprocess/stats");
    var data = await readJsonSafe(response);

    if (!response.ok || !data || !data.success || !data.stats) {
      if (!silent) {
        setStatus("Falha ao carregar métricas do banco.", true);
      }
      return null;
    }

    state.dashboardStats = data.stats;
    updateDashboardStats();
    return data.stats;
  } catch {
    if (!silent) {
      setStatus("Erro de rede ao carregar métricas do banco.", true);
    }
    return null;
  }
}

function updateDashboardStats() {
  var successCount = 0;
  var errorCount = 0;
  var pendingCount = 0;

  if (state.dashboardStats && typeof state.dashboardStats === "object") {
    successCount = Math.max(0, Number(state.dashboardStats.success_30d || 0));
    errorCount = Math.max(0, Number(state.dashboardStats.failed_30d || 0));
    pendingCount = Math.max(0, Number(state.dashboardStats.pending_now || 0));
  } else {
    state.history.forEach(function (item) {
      var status = safeText(item && item.status, "").toLowerCase();
      if (status === "success") {
        successCount += 1;
        return;
      }
      if (status === "error" || status === "failed") {
        errorCount += 1;
        return;
      }
      pendingCount += 1;
    });
  }

  var total = Math.max(1, successCount + errorCount + pendingCount);
  var successPercent = Math.round((successCount / total) * 100);
  var errorPercent = Math.round((errorCount / total) * 100);
  var pendingPercent = Math.round((pendingCount / total) * 100);
  var clientsCount = Array.isArray(state.clients) ? state.clients.length : 0;
  var uniqueClientsInHistory = state.dashboardStats && typeof state.dashboardStats === "object"
    ? Math.max(0, Number(state.dashboardStats.active_clients_30d || 0))
    : new Set(
      state.history
        .map(function (item) { return safeText(item && item.client, ""); })
        .filter(function (key) { return key && key !== "-"; }),
    ).size;
  var clientsPercent = clientsCount > 0
    ? Math.round(Math.min(100, (uniqueClientsInHistory / clientsCount) * 100))
    : 0;

  setStatCard(".stat-card.success", successCount, successPercent);
  setStatCard(".stat-card.error", errorCount, errorPercent);
  setStatCard(".stat-card.pending", pendingCount, pendingPercent);
  setStatCard(".stat-card.customers", clientsCount, clientsPercent);
}

async function generatePreview() {
  if (!hasEl("conversationUrl") || !hasEl("previewBtn")) {
    return;
  }
  var url = (el.conversationUrl.value || "").trim();
  var selectedClient = (el.clientSelect.value || "").trim();
  var selectedMessageCount = parseMessageCount();

  if (!url) {
    setStatus("Informe o link da conversa.", true);
    return;
  }

  resetPreviewState();
  state.currentConversationUrl = url;
  el.previewBtn.disabled = true;
  setPipelineStep(1);
  startPreviewProgressFlow();
  setStatus("Carregando mensagens da conversa...", false);
  showCards(true);
  setChatPreviewStatus("Carregando conversa original...");
  setPreviewProgress(18, "Buscando mensagens no Chatwoot...");
  await fetchChatMessages({ silent: false, limit: 120, conversationUrl: url });
  setPreviewProgress(30, "Analisando conteúdo e mídias...");
  var prePreviewMediaSignal = detectMediaFromChatMessages(state.chatMessages, selectedMessageCount);
  var prePreviewMediaNotice = buildPrePreviewMediaNotice(prePreviewMediaSignal);
  if (prePreviewMediaNotice) {
    setStatus(prePreviewMediaNotice, false);
    pushActivity("warning", "Mídia detectada antes do preview", prePreviewMediaNotice);
    var confirmMediaPreview = true;
    if (typeof window.openConfirmModal === "function") {
      confirmMediaPreview = await window.openConfirmModal(
        prePreviewMediaNotice + " Deseja continuar com a geração do preview agora?",
      );
    } else {
      confirmMediaPreview = window.confirm(
        prePreviewMediaNotice + " Deseja continuar com a geração do preview agora?",
      );
    }
    if (!confirmMediaPreview) {
      setStatus("Geração do preview cancelada para revisão de mídia.", true);
      pushActivity("warning", "Preview cancelado", "Operador cancelou a geração após aviso de mídia.");
      setPipelineStep(0);
      finishPreviewProgressFlow(true, "Preview cancelado pelo operador.");
      el.previewBtn.disabled = false;
      return;
    }
    setPreviewProgress(42, "Mídia detectada. Preparando enriquecimento por IA...");
    setStatus("Gerando preview no servidor com processamento de mídia...", false);
  } else {
    setPreviewProgress(42, "Gerando preview no servidor...");
    setStatus("Sem mídia detectada na pré-análise. Gerando preview no servidor...", false);
  }

  try {
    var response = await fetch("/api/reprocess/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationUrl: url,
        client: selectedClient || undefined,
        messageCount: selectedMessageCount,
      }),
    });

    var data = await readJsonSafe(response);
    setPreviewProgress(86, "Processando resposta do preview...");
    el.output.textContent = JSON.stringify(data, null, 2);

    if (!response.ok || !Array.isArray(data) || data.length === 0) {
      if (data && typeof data === "object" && !Array.isArray(data)) {
        fillDiagnostic(data);
      }
      throw new Error(
        normalizeBackendErrorMessage(
          safeText(data && data.message, "Falha ao gerar preview."),
        ),
      );
    }

    state.previewPayload = data;
    state.previewOriginalPayload = deepClone(data);
    state.previewClientKey = resolveClientKeyFromPreviewPayload(data, selectedClient);
    var previewItem = getPreviewItem(data);
    state.previewMediaMeta = previewItem && previewItem.preview_meta && previewItem.preview_meta.media
      ? previewItem.preview_meta.media
      : null;

    var clientMeta = state.clients.find(function (client) {
      return client.key === state.previewClientKey;
    });

    el.resolvedClient.value = clientMeta
      ? (clientMeta.name + " (" + formatClientKeyForDisplay(clientMeta.key) + ")")
      : formatClientKeyForDisplay(state.previewClientKey);

    fillSummary(data);
    syncEditedMessageInputFromPayload(state.previewPayload);
    renderMediaStatus(state.previewMediaMeta);
    if (state.previewMediaMeta) {
      var mediaMeta = state.previewMediaMeta;
      var audioCount = Number(mediaMeta.audio_attachments || 0);
      var imageCount = Number(mediaMeta.image_attachments || 0);
      var otherCount = Number(mediaMeta.other_attachments || 0);
      var mediaAiEnabled = Boolean(mediaMeta.media_ai_enabled);

      if (audioCount > 0) {
        pushActivity(
          "warning",
          "Áudio detectado",
          mediaAiEnabled
            ? "Áudio identificado e processado para texto no backend."
            : "Áudio identificado. IA de mídia desligada, usando fallback textual.",
        );
      }
      if (imageCount > 0) {
        pushActivity(
          "warning",
          "Imagem detectada",
          mediaAiEnabled
            ? "Imagem identificada e descrita no contexto da conversa."
            : "Imagem identificada. IA de mídia desligada, usando fallback textual.",
        );
      }
      if (otherCount > 0) {
        pushActivity(
          "warning",
          "Anexo detectado",
          "Anexo(s) genérico(s) detectado(s). Conteúdo foi marcado com fallback no texto.",
        );
      }
    }
    showCards(true);
    el.executeBtn.disabled = !(state.previewPayload && state.previewClientKey);
    var pausePreview = await fetchPauseStatusPreview({
      silent: true,
      payload: data,
      client: state.previewClientKey,
    });
    state.chatNewOutgoingMessages = [];
    setChatBaselineFromMessages(state.chatMessages);
    renderChatMessages();
    if (pausePreview && pausePreview.pause_status && pausePreview.pause_status.paused === true) {
      setPipelineStep(2);
      setStatus("Preview gerado. Contato está pausado no Supabase (verifique no resumo).", true);
      el.executeBtn.disabled = true;
      pushActivity(
        "warning",
        "Contato pausado detectado",
        "Tabela: " + safeText(pausePreview.pause_status.table, "-") + " | Match: " + safeText(pausePreview.pause_status.matched_phone, "-"),
      );
    } else {
      setPipelineStep(2);
      setStatus("Preview gerado. Revise e clique em Reprocessar.", false);
    }
    pushActivity("success", "Preview gerado", "Payload pronto para revisão.");
    finishPreviewProgressFlow(false, "Preview JSON gerado com sucesso.");
  } catch (error) {
    setPipelineStep(0);
    if (!Array.isArray(state.chatMessages) || state.chatMessages.length === 0) {
      showCards(false);
    } else {
      showCards(true);
      setChatPreviewStatus("Preview falhou, mas as mensagens da conversa foram carregadas.");
    }
    var previewErrorMessage = normalizeBackendErrorMessage(safeText(error && error.message, "Falha ao gerar preview."));
    setStatus(previewErrorMessage, true);
    pushActivity("error", "Falha ao gerar preview", previewErrorMessage);
    finishPreviewProgressFlow(true, "Falha ao gerar preview.");
  } finally {
    el.previewBtn.disabled = false;
  }
}

function getConversationId() {
  var item = Array.isArray(state.previewPayload) ? state.previewPayload[0] : null;
  var body = (item && item.body) || {};
  return safeText(body.conversation_id || body.id, "");
}

function setDiagnosticContext(data) {
  var details = (data && data.details) || {};
  var requestId = safeText(details.request_id || data.request_id, "");
  var client = safeText(details.client || state.previewClientKey, "");
  var conversationId = getConversationId();

  if (!requestId && !client && !conversationId) {
    state.lastDiagnosticContext = null;
    el.n8nLookupBtn.disabled = true;
    return;
  }

  state.lastDiagnosticContext = {
    requestId: requestId,
    client: client,
    conversationId: conversationId,
  };
  el.n8nLookupBtn.disabled = false;
  fetchN8nEvents({ silent: true, limit: 30, client: client });
}

function fillN8nDiagnostic(event) {
  if (!hasEl("diagnosticPanel")) {
    return;
  }
  if (!event || typeof event !== "object") {
    return;
  }

  el.diagnosticPanel.classList.add("is-visible");
  applyDiagnosticTone(toTimelineType(event));
  el.dWorkflow.textContent = normalizeLegacyPtBr(safeText(event.workflow_name, "-"));
  el.dNode.textContent = normalizeLegacyPtBr(safeText(event.failed_node, "-"));
  el.dExecution.textContent = normalizeLegacyPtBr(safeText(event.execution_id, "-"));
  el.dFlowMessage.textContent =
    normalizeLegacyPtBr(stripJsonFromText(event.error_description)) ||
    normalizeLegacyPtBr(stripJsonFromText(event.error_message)) ||
    normalizeLegacyPtBr(stripJsonFromText((event.upstream_messages && event.upstream_messages[0]) || "")) ||
    "-";
  el.dUpstream.textContent =
    normalizeLegacyPtBr(stripJsonFromText((event.upstream_messages && event.upstream_messages[0]) || "")) ||
    normalizeLegacyPtBr(stripJsonFromText(event.error_message)) ||
    "-";

  if (event.category) {
    var currentCode = safeText(el.dCode.textContent, "");
    el.dCode.textContent = currentCode === "-" || !currentCode ? event.category : currentCode + " | " + event.category;
  }

  if (event.title) {
    el.dTitle.textContent = normalizeLegacyPtBr(event.title);
  }
  if (event.likely_cause) {
    el.dCause.textContent = normalizeLegacyPtBr(event.likely_cause);
  }
  if (event.suggestion) {
    el.dSuggestion.textContent = normalizeLegacyPtBr(event.suggestion);
  }
}

function fillDiagnostic(errorPayload) {
  if (!hasEl("diagnosticPanel")) {
    return;
  }
  var details = (errorPayload && errorPayload.details) || {};

  el.diagnosticPanel.classList.add("is-visible");
  applyDiagnosticTone("error");
  el.dCode.textContent = normalizeLegacyPtBr(safeText(errorPayload.error, "-"));
  el.dTitle.textContent = normalizeLegacyPtBr(safeText(details.title, "-"));
  el.dCause.textContent = normalizeLegacyPtBr(safeText(details.likely_cause || errorPayload.message, "-"));
  el.dSuggestion.textContent = normalizeLegacyPtBr(safeText(details.suggestion, "-"));
  el.dUpstream.textContent = normalizeLegacyPtBr(stripJsonFromText(details.upstream_message || details.error_cause)) || "-";
  el.dRequest.textContent = normalizeLegacyPtBr(safeText(details.request_id || errorPayload.request_id, "-"));

  setDiagnosticContext(errorPayload);
  fillN8nDiagnostic(details.n8n_event || null);
}

function buildPauseDiagnosticEvent(pauseStatus) {
  var status = pauseStatus && typeof pauseStatus === "object" ? pauseStatus : {};
  var isPaused = Boolean(status.paused);
  var tableName = safeText(status.table, "-");
  var phoneColumn = safeText(status.phone_column, "-");
  var matchedPhone = safeText(status.matched_phone, "-");
  var source = safeText(status.pause_table_source, "-");
  var reason = safeText(status.reason, "-");
  var checked = status.checked === true;

  var title = isPaused ? "IA pausada no Supabase" : "Consulta de pausa no Supabase";
  var category = isPaused ? "supabase_ai_paused" : "supabase_pause_check";
  var cause = isPaused
    ? "Contato localizado na tabela de pausa."
    : checked
      ? "Contato não marcado como pausado."
      : "Consulta de pausa não executada.";
  var suggestion = isPaused
    ? "Remova a pausa no Supabase para permitir o reprocessamento."
    : checked
      ? "Sem bloqueio de pausa para este contato."
      : "Validar configuração de tabela/colunas de pausa.";

  var flowMessage =
    "Tabela: " + tableName +
    " | Coluna: " + phoneColumn +
    " | Telefone encontrado: " + matchedPhone +
    " | Origem tabela: " + source;

  return {
    category: category,
    title: title,
    likely_cause: cause,
    suggestion: suggestion,
    upstream_messages: [flowMessage, "reason=" + reason],
    request_id: null,
    workflow_name: "supabase_pause_check",
    failed_node: null,
    execution_id: null,
    error_description: flowMessage,
  };
}

function fillFlowStatus(event) {
  if (!hasEl("diagnosticPanel")) {
    return;
  }
  if (!event || typeof event !== "object") {
    return;
  }

  var tone = toTimelineType(event);
  if (safeText(event.category, "").toLowerCase() === "webhook_dispatched") {
    tone = "info";
  }

  el.diagnosticPanel.classList.add("is-visible");
  applyDiagnosticTone(tone);
  el.dCode.textContent = safeText(event.category, "flow_status");
  el.dTitle.textContent = safeText(event.title, "Status do fluxo n8n");
  el.dCause.textContent = safeText(event.likely_cause, "-");
  el.dSuggestion.textContent = safeText(event.suggestion, "-");
  el.dUpstream.textContent = (event.upstream_messages && event.upstream_messages[0]) || "-";
  el.dRequest.textContent = safeText(event.request_id, "-");
  el.dWorkflow.textContent = safeText(event.workflow_name, "-");
  el.dNode.textContent = safeText(event.failed_node, "-");
  el.dExecution.textContent = safeText(event.execution_id, "-");
  var mainFlowMessage =
    (event.upstream_messages && event.upstream_messages[0]) ||
    event.error_description ||
    event.error_message ||
    event.likely_cause;
  el.dFlowMessage.textContent = safeText(mainFlowMessage, "-");
}

async function fetchLatestN8nError(options) {
  var opts = options || {};
  var attempts = opts.attempts || 1;
  var delayMs = opts.delayMs || 1000;
  var silent = opts.silent === true;

  if (!state.lastDiagnosticContext) {
    if (!silent) {
      setStatus("Sem contexto para buscar erro n8n.", true);
    }
    return null;
  }

  el.n8nLookupBtn.disabled = true;

  try {
    for (var attempt = 1; attempt <= attempts; attempt += 1) {
      var params = new URLSearchParams();
      if (state.lastDiagnosticContext.requestId) {
        params.set("request_id", state.lastDiagnosticContext.requestId);
      }
      if (state.lastDiagnosticContext.client) {
        params.set("client", state.lastDiagnosticContext.client);
      }
      if (state.lastDiagnosticContext.conversationId) {
        params.set("conversation_id", state.lastDiagnosticContext.conversationId);
      }

      var response = await fetch("/api/reprocess/n8n/errors/latest?" + params.toString());
      var data = await readJsonSafe(response);

      if (response.ok && data && data.success && data.found && data.event) {
        fillN8nDiagnostic(data.event);
        el.dRequest.textContent = safeText((data.event && data.event.request_id) || el.dRequest.textContent, "-");
        if (!silent) {
          setStatus("Diagnóstico atualizado com erro real do n8n.", true);
        }
        return data.event;
      }

      if (attempt < attempts) {
        await wait(delayMs);
      }
    }

    if (!silent) {
      setStatus("Nenhum erro recente de n8n encontrado.", true);
    }
    return null;
  } finally {
    el.n8nLookupBtn.disabled = !state.lastDiagnosticContext;
  }
}

async function fetchLatestN8nStatus(options) {
  var opts = options || {};
  var attempts = opts.attempts || 1;
  var delayMs = opts.delayMs || 1000;
  var silent = opts.silent === true;

  if (!state.lastDiagnosticContext) {
    if (!silent) {
      setStatus("Sem contexto para buscar status n8n.", true);
    }
    return null;
  }

  el.n8nLookupBtn.disabled = true;

  try {
    for (var attempt = 1; attempt <= attempts; attempt += 1) {
      var params = new URLSearchParams();
      if (state.lastDiagnosticContext.requestId) {
        params.set("request_id", state.lastDiagnosticContext.requestId);
      }
      if (state.lastDiagnosticContext.client) {
        params.set("client", state.lastDiagnosticContext.client);
      }
      if (state.lastDiagnosticContext.conversationId) {
        params.set("conversation_id", state.lastDiagnosticContext.conversationId);
      }

      var response = await fetch("/api/reprocess/n8n/status/latest?" + params.toString());
      var data = await readJsonSafe(response);

      if (response.ok && data && data.success && data.found && data.event) {
        var statusCategory = safeText(data.event && data.event.category, "").toLowerCase();
        if (statusCategory !== "webhook_dispatched") {
          fillFlowStatus(data.event);
        }
        if (!silent) {
          setStatus("Status do n8n encontrado.", false);
        }
        return data.event;
      }

      if (attempt < attempts) {
        await wait(delayMs);
      }
    }

    if (!silent) {
      setStatus("Nenhum status recente do n8n encontrado.", true);
    }
    return null;
  } finally {
    el.n8nLookupBtn.disabled = !state.lastDiagnosticContext;
  }
}

async function fetchLatestN8nExecution(options) {
  var opts = options || {};
  var attempts = opts.attempts || 1;
  var delayMs = opts.delayMs || 1000;
  var silent = opts.silent === true;
  var sync = opts.sync !== false;

  if (!state.lastDiagnosticContext) {
    if (!silent) {
      setStatus("Sem contexto para buscar execução n8n.", true);
    }
    return null;
  }

  el.n8nLookupBtn.disabled = true;

  try {
    for (var attempt = 1; attempt <= attempts; attempt += 1) {
      var params = new URLSearchParams();
      if (state.lastDiagnosticContext.requestId) {
        params.set("request_id", state.lastDiagnosticContext.requestId);
      }
      if (state.lastDiagnosticContext.client) {
        params.set("client", state.lastDiagnosticContext.client);
      }
      if (state.lastDiagnosticContext.conversationId) {
        params.set("conversation_id", state.lastDiagnosticContext.conversationId);
      }
      params.set("sync", sync ? "true" : "false");

      var response = await fetch("/api/reprocess/n8n/execution/latest?" + params.toString());
      var data = await readJsonSafe(response);

      if (response.ok && data && data.success && data.found && data.event) {
        fillFlowStatus(data.event);
        if (!silent) {
          setStatus("Execução do n8n localizada.", false);
        }
        return data.event;
      }

      if (attempt < attempts) {
        await wait(delayMs);
      }
    }

    if (hasSuccessEvidenceForActiveRun()) {
      var fallbackEvent = {
        category: "n8n_execution_success_fallback",
        status: "success",
        title: "Execução concluída",
        likely_cause: "Retorno do reprocessamento confirmado no Chatwoot.",
        suggestion: "Se necessário, valide os detalhes finais diretamente no n8n.",
        request_id: safeText(state.lastDiagnosticContext && state.lastDiagnosticContext.requestId, "") || null,
        client: safeText(state.lastDiagnosticContext && state.lastDiagnosticContext.client, "") || null,
        conversation_id: safeText(state.lastDiagnosticContext && state.lastDiagnosticContext.conversationId, "") || null,
        workflow_name: null,
        failed_node: null,
        execution_id: null,
        upstream_messages: ["Execução confirmada por evidência de retorno no Chatwoot."],
      };
      fillFlowStatus(fallbackEvent);
      if (!silent) {
        setStatus("Fluxo confirmado pelo retorno no Chatwoot.", false);
      }
      return fallbackEvent;
    }

    if (!silent) {
      setStatus("Execução ainda não localizada no n8n.", true);
    }
    return null;
  } finally {
    el.n8nLookupBtn.disabled = !state.lastDiagnosticContext;
  }
}

function startPostExecuteMonitor() {
  stopMonitor();
  if (!state.lastDiagnosticContext) {
    return;
  }

  state.monitorStartedAt = Date.now();
  state.monitorRunningTicks = 0;
  state.monitorTimer = setInterval(async function () {
    if (state.monitorBusy) {
      return;
    }

    if (state.activeRunRequestId) {
      var currentHistoryStatus = getHistoryStatusByRequestId(state.activeRunRequestId);
      if (currentHistoryStatus === "success" || currentHistoryStatus === "error") {
        stopMonitor();
        return;
      }
    }

    var elapsed = Date.now() - state.monitorStartedAt;
    if (elapsed > 600000) {
      setPipelineStep(4);
      setStatus("Monitor do fluxo encerrado por timeout (10 min).", true);
      pushActivity("warning", "Monitor encerrado", "Não foi possível confirmar a conclusão do fluxo dentro do tempo limite.");
      showToast("Monitor encerrado por timeout. Consulte o n8n para detalhes.", "error");
      updateHistoryByRequestId(state.activeRunRequestId, "running", "Monitor encerrado por timeout sem status final do n8n.");
      stopMonitor();
      return;
    }

    var forceCompleteAfterMs = getForceCompleteRunningAfterMs(state.activeRunClientKey || state.previewClientKey);
    if (
      state.activeRunStartedAt > 0 &&
      Date.now() - state.activeRunStartedAt >= forceCompleteAfterMs &&
      state.activeRunRequestId &&
      getHistoryStatusByRequestId(state.activeRunRequestId) !== "error"
    ) {
      pushLocalN8nTimelineEvent({
        category: "n8n_execution_success_forced",
        status: "success",
        title: "Execução finalizada (assumida)",
        likely_cause:
          "Fluxo permaneceu em execução por tempo prolongado sem erro explícito. Marcado como concluído no painel.",
        suggestion:
          "Se necessário, valide os detalhes finais diretamente no n8n.",
      });
      setPipelineStep(4);
      setStatus("Reprocessamento marcado como concluído no painel.", false);
      pushActivity(
        "success",
        "Fluxo finalizado (forçado)",
        "Execução em andamento por muito tempo; status ajustado para concluído no painel.",
      );
      updateHistoryByRequestId(
        state.activeRunRequestId,
        "success",
        "Concluído no painel após tempo limite de execução em andamento.",
      );
      showToast("Execução marcada como concluída no painel.", "success");
      stopMonitor();
      return;
    }

    state.monitorBusy = true;
    try {
      var executionEvent = await fetchLatestN8nExecution({ attempts: 1, delayMs: 200, silent: true, sync: true });
      if (executionEvent) {
        if (executionEvent.status === "success") {
          setPipelineStep(4);
          setStatus("Fluxo concluído no n8n.", false);
          pushActivity("success", "Fluxo concluído", safeText(executionEvent.likely_cause, "Execução finalizada."));
          showToast("Reprocessamento concluído no n8n.", "success");
          updateHistoryByRequestId(state.activeRunRequestId, "success", "Fluxo concluído no n8n.");
          stopMonitor();
          return;
        }

        if (executionEvent.status === "error" || executionEvent.status === "failed" || executionEvent.category === "n8n_execution_error") {
          setPipelineStep(4);
          setStatus("Erro no fluxo: " + safeText(executionEvent.title || executionEvent.category, "n8n"), true);
          pushActivity("error", "Erro no fluxo", safeText(executionEvent.likely_cause, "Falha no n8n."));
          showToast("Fluxo finalizado com erro no n8n.", "error");
          updateHistoryByRequestId(state.activeRunRequestId, "error", safeText(executionEvent.likely_cause, "Fluxo finalizado com erro no n8n."));
          stopMonitor();
          return;
        }

        if (executionEvent.status === "running" || executionEvent.status === "new" || executionEvent.status === "waiting") {
          state.monitorRunningTicks += 1;
          if (hasConfirmedChatReturn()) {
            setPipelineStep(4);
            setStatus("Retorno confirmado no Chatwoot. Encerrando monitor.", false);
            updateHistoryByRequestId(state.activeRunRequestId, "success", "Retorno confirmado no Chatwoot.");
            stopMonitor();
            return;
          }
        }
      }

      var errorEvent = await fetchLatestN8nError({ attempts: 1, delayMs: 200, silent: true });
      if (errorEvent) {
        setPipelineStep(4);
        setStatus("Erro no fluxo: " + safeText(errorEvent.title || errorEvent.category, "n8n"), true);
        pushActivity("error", "Erro no fluxo", safeText(errorEvent.error_description || errorEvent.error_message, "Erro no n8n."));
        updateHistoryByRequestId(state.activeRunRequestId, "error", safeText(errorEvent.error_description || errorEvent.error_message, "Erro no n8n."));
        stopMonitor();
        return;
      }

      var statusEvent = await fetchLatestN8nStatus({ attempts: 1, delayMs: 200, silent: true });
      if (statusEvent) {
        if (safeText(statusEvent.category, "").toLowerCase() === "webhook_dispatched") {
          return;
        }
        setStatus("Status do fluxo: " + safeText(statusEvent.title || statusEvent.category, "n8n"), false);
        if (safeText(statusEvent.category, "").toLowerCase().indexOf("error") >= 0) {
          showToast("Fluxo reportou status de erro.", "error");
        }
      }

      if (state.monitorRunningTicks >= 10) {
        setStatus("Fluxo ainda em andamento no n8n. Aguardando conclusão final...", false);
        pushActivity("warning", "Fluxo em andamento", "Execução segue como running por mais tempo que o esperado.");
        updateHistoryByRequestId(state.activeRunRequestId, "running", "Fluxo em andamento no n8n (sem status final ainda).");
        state.monitorRunningTicks = 0;
      }
    } finally {
      state.monitorBusy = false;
    }
  }, 8000);
}

async function executeReprocess() {
  if (!hasEl("executeBtn")) {
    return;
  }
  if (!state.previewPayload || !state.previewClientKey) {
    setStatus("Gere o preview primeiro.", true);
    return;
  }
  if (state.pauseStatusPreview && state.pauseStatusPreview.pause_status && state.pauseStatusPreview.pause_status.paused === true) {
    setStatus("Contato pausado no Supabase. Remova da IA pausada antes de reprocessar.", true);
    showToast("Contato pausado. Reprocessamento bloqueado.", "error");
    renderPauseWarning(state.pauseStatusPreview.pause_status);
    return;
  }
  if (hasPendingRunForClient(state.previewClientKey)) {
    setStatus(
      "Já existe reprocessamento pendente para " +
        formatClientKeyForDisplay(state.previewClientKey) +
        ". Use o Controle de fila para limpar duplicatas antes de enviar outro.",
      true,
    );
    showToast("Cliente já possui reprocessamento pendente.", "error");
    return;
  }

  if (hasActiveRunInProgress()) {
    setStatus("Já existe um reprocessamento em andamento nesta sessão. Aguarde a finalização.", true);
    showToast("Aguarde o reprocessamento atual finalizar antes de iniciar outro.", "error");
    return;
  }

  if (hasEl("editedMessage")) {
    var currentPayloadMessage = extractPreviewMainMessage(state.previewPayload);
    var typedMessage = safeText(el.editedMessage.value, "");
    if (typedMessage && typedMessage !== currentPayloadMessage) {
      state.previewPayload = applyEditedMessageToPayload(state.previewPayload, typedMessage);
      el.output.textContent = JSON.stringify(state.previewPayload, null, 2);
      fillSummary(state.previewPayload);
    }
  }

  el.executeBtn.disabled = true;
  resetDiagnostic();
  state.activeRunRequestId = "";
  state.activeRunStartedAt = 0;
  state.activeRunClientKey = "";
  state.chatNewOutgoingMessages = [];
  await fetchChatMessages({ silent: true, limit: 120, suppressAnimations: true });
  setChatBaselineFromMessages(state.chatMessages);
  renderChatMessages({ suppressAnimations: true });
  setPipelineStep(3);
  el.output.textContent = JSON.stringify(state.previewPayload, null, 2);
  pushActivity("warning", "Reprocessamento iniciado", "Payload em envio para o webhook e monitoramento ativado.");
  showToast("Reprocessamento iniciado. Acompanhe a timeline.", "success");
  setChatPreviewStatus("Reprocesso iniciado. Monitorando novas mensagens no Chatwoot...");
  setStatus("Enviando payload para o webhook...", false);

  try {
    var response = await fetch("/api/reprocess/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client: state.previewClientKey,
        payload: state.previewPayload,
      }),
    });

    var data = await readJsonSafe(response);
    if (state.previewPayload) {
      el.output.textContent = JSON.stringify(state.previewPayload, null, 2);
    }

    if (!response.ok || !data || !data.success) {
      var executeErrorMessage = normalizeBackendErrorMessage(
        safeText(data && data.message, "Falha ao executar."),
      );
      setPipelineStep(4);
      fillDiagnostic(data || {});
      await fetchLatestN8nError({ attempts: 3, delayMs: 1200, silent: true });
      await fetchN8nEvents({ silent: true, limit: 30 });
      await fetchChatMessages({ silent: true, limit: 120, suppressAnimations: true });
      pushHistory("error", executeErrorMessage);
      pushActivity("error", "Falha no reprocessamento", executeErrorMessage);
      setStatus(executeErrorMessage, true);
      setChatPreviewStatus("Reprocesso falhou. Chat mantido para analise.");
      return;
    }

    state.lastDiagnosticContext = {
      requestId: safeText(data.request_id, ""),
      client: state.previewClientKey,
      conversationId: getConversationId(),
    };
    el.n8nLookupBtn.disabled = false;

    if (data.pause_status) {
      fillFlowStatus(buildPauseDiagnosticEvent(data.pause_status));
      if (data.pause_status.paused) {
        pushActivity(
          "warning",
          "Contato encontrado em pausa",
          "Tabela: " +
            safeText(data.pause_status.table, "-") +
            " | Coluna: " +
            safeText(data.pause_status.phone_column, "-") +
            " | Match: " +
            safeText(data.pause_status.matched_phone, "-"),
        );
      }
    }

    if (data.skipped && data.status === "paused") {
      setPipelineStep(4);
      pushHistory("paused", data.message || "Contato pausado");
      pushActivity("warning", "Contato pausado", data.message || "Reprocessamento não enviado.");
      setStatus(data.message || "Contato pausado.", true);
      showToast(data.message || "Contato pausado. Reprocessamento não enviado.", "error");
      state.activeRunRequestId = "";
      state.activeRunStartedAt = 0;
      state.activeRunClientKey = "";
      return;
    }

    state.activeRunRequestId = safeText(data.request_id, "");
    state.activeRunStartedAt = Date.now();
    state.activeRunClientKey = state.previewClientKey;
    state.n8nFilterRequest = state.activeRunRequestId;
    if (hasEl("n8nRequestFilter")) {
      el.n8nRequestFilter.value = state.activeRunRequestId;
    }
    pushHistory("running", "Payload enviado ao webhook. Aguardando conclusão do fluxo.");
    startPostExecuteMonitor();
    startChatPostReprocessMonitor();
    await fetchLatestN8nStatus({ attempts: 2, delayMs: 900, silent: true });
    await fetchN8nEvents({ silent: true, limit: 30, client: state.previewClientKey });

    pushActivity("warning", "Payload enviado ao webhook", data.message || "Webhook recebeu a requisição inicial de reprocessamento.");
    setStatus("Payload enviado ao webhook. Aguardando conclusão final do fluxo no n8n...", false);
    showToast("Reprocessamento iniciado. Aguardando conclusão final.", "success");
  } catch (error) {
    var executeCatchMessage = normalizeBackendErrorMessage(safeText(error && error.message, "Erro ao executar reprocessamento."));
    setPipelineStep(4);
    pushHistory("error", executeCatchMessage);
    pushActivity("error", "Erro de execução", executeCatchMessage);
    setStatus(executeCatchMessage, true);
    showToast(executeCatchMessage, "error");
    state.activeRunRequestId = "";
    state.activeRunStartedAt = 0;
    state.activeRunClientKey = "";
  } finally {
    el.executeBtn.disabled = false;
  }
}

function applyEditedMessageIntoPreview() {
  if (!state.previewPayload) {
    setStatus("Gere o preview antes de editar a mensagem.", true);
    return;
  }
  if (!hasEl("editedMessage")) {
    return;
  }

  var editedText = safeText(el.editedMessage.value, "");
  if (!editedText) {
    setStatus("A mensagem editada não pode ficar vazia.", true);
    return;
  }

  state.previewPayload = applyEditedMessageToPayload(state.previewPayload, editedText);
  el.output.textContent = JSON.stringify(state.previewPayload, null, 2);
  fillSummary(state.previewPayload);
  setStatus("Mensagem editada aplicada ao JSON de envio.", false);
  pushActivity("success", "Mensagem ajustada", "A mensagem a ser reprocessada foi atualizada manualmente.");
}

function restoreEditedMessageFromOriginal() {
  if (!state.previewOriginalPayload) {
    return;
  }

  state.previewPayload = deepClone(state.previewOriginalPayload);
  syncEditedMessageInputFromPayload(state.previewPayload);
  el.output.textContent = JSON.stringify(state.previewPayload, null, 2);
  fillSummary(state.previewPayload);
  setStatus("Mensagem original restaurada no payload.", false);
  pushActivity("warning", "Mensagem restaurada", "O payload voltou para a versão original do preview.");
}

onEl("copyBtn", "click", async function () {
  var text = el.output.textContent || "";
  try {
    await navigator.clipboard.writeText(text);
    el.copyBtn.textContent = "Copiado!";
  } catch {
    el.copyBtn.textContent = "Erro";
  }
  setTimeout(function () {
    el.copyBtn.textContent = "Copiar JSON";
  }, 1800);
});

onEl("conversationUrl", "input", function () {
  resetPreviewState();
  state.currentConversationUrl = (el.conversationUrl.value || "").trim();
});
onEl("clientSelect", "pointerdown", maybeReloadClientsIfMissing);
onEl("clientSelect", "change", function () {
  resetPreviewState();
  fetchN8nEvents({ silent: true, limit: 30 });
});
onEl("messageCount", "input", resetPreviewState);
onEl("previewBtn", "click", generatePreview);
onEl("applyEditedMessageBtn", "click", function () {
  applyEditedMessageIntoPreview();
});
onEl("resetEditedMessageBtn", "click", function () {
  restoreEditedMessageFromOriginal();
});
onEl("executeBtn", "click", async function() {
  if (typeof window.openConfirmModal === "function") {
    var confirmed = await window.openConfirmModal("Deseja reprocessar esta conversa? O payload ser\u00e1 enviado para o webhook da empresa selecionada.");
    if (!confirmed) {
      return;
    }
  }
  executeReprocess();
});
onEl("clearDiagnosticBtn", "click", resetDiagnostic);
onEl("removePauseBtn", "click", async function () {
  var confirmed = await openPauseRemoveModal();
  if (!confirmed) {
    return;
  }
  removePauseForCurrentPreview();
});
onEl("refreshHistory", "click", function () {
  renderHistory();
  setStatus("Histórico local atualizado.", false);
});
onEl("queueDedupeBtn", "click", function () {
  dedupePendingQueue();
});
onEl("queueClearBtn", "click", async function () {
  var confirmed = true;
  if (typeof window.openConfirmModal === "function") {
    confirmed = await window.openConfirmModal(
      "Deseja limpar todas as pendências da fila local?",
    );
  }
  if (!confirmed) {
    return;
  }
  clearPendingQueue();
});
onEl("refreshN8nEventsBtn", "click", function () {
  fetchN8nEvents({ silent: false, limit: 30 });
});
onEl("n8nPrevBtn", "click", function () {
  if (state.n8nPage > 1) {
    state.n8nPage -= 1;
    renderN8nEvents();
  }
});
onEl("n8nNextBtn", "click", function () {
  var totalPages = Math.max(1, Math.ceil(getFilteredN8nEvents().length / N8N_TIMELINE_PAGE_SIZE));
  if (state.n8nPage < totalPages) {
    state.n8nPage += 1;
    renderN8nEvents();
  }
});
onEl("refreshChatPreviewBtn", "click", function () {
  fetchChatMessages({ silent: false, limit: 120 });
});
onEl("n8nTypeFilter", "change", function () {
  state.n8nFilterType = safeText(el.n8nTypeFilter.value, "all").toLowerCase();
  state.n8nPage = 1;
  renderN8nEvents();
});
onEl("n8nRequestFilter", "input", function () {
  state.n8nFilterRequest = safeText(el.n8nRequestFilter.value, "");
  state.n8nPage = 1;
  renderN8nEvents();
});
onEl("clearN8nFiltersBtn", "click", function () {
  state.n8nFilterType = "all";
  state.n8nFilterRequest = "";
  state.n8nPage = 1;
  el.n8nTypeFilter.value = "all";
  el.n8nRequestFilter.value = "";
  renderN8nEvents();
});
onEl("queueList", "click", function (event) {
  var target = event && event.target && event.target.closest
    ? event.target.closest("[data-remove-id]")
    : null;
  if (!target) {
    return;
  }
  removeQueueEntryByHistoryId(target.getAttribute("data-remove-id"));
});
onEl("activityPrevBtn", "click", function () {
  if (state.activityPage > 1) {
    state.activityPage -= 1;
    renderActivity();
  }
});
onEl("activityNextBtn", "click", function () {
  var totalPages = Math.max(1, Math.ceil(state.activity.length / ACTIVITY_PAGE_SIZE));
  if (state.activityPage < totalPages) {
    state.activityPage += 1;
    renderActivity();
  }
});

onEl("n8nLookupBtn", "click", function () {
  fetchLatestN8nExecution({ attempts: 1, delayMs: 200, silent: false, sync: true }).then(function (executionEvent) {
    if (!executionEvent) {
      return fetchLatestN8nStatus({ attempts: 1, delayMs: 200, silent: false });
    }
    return null;
  }).then(function (statusEvent) {
    if (!statusEvent) {
      return fetchLatestN8nError({ attempts: 1, delayMs: 200, silent: false });
    }
    return null;
  });
});

(function init() {
  if (!hasEl("conversationUrl") || !hasEl("clientSelect")) {
    console.error("[reprocessador-dashboard] Elementos essenciais nao encontrados no DOM. Script em modo degradado.");
    return;
  }
  showCards(false);
  resetPreviewState();
  var persistedHistory = readStorageJson(HISTORY_STORAGE_KEY, []);
  if (Array.isArray(persistedHistory)) {
    state.history = persistedHistory.filter(function (item) {
      return item && typeof item === "object";
    }).slice(0, 200);
  }
  var persistedActivity = readStorageJson(ACTIVITY_STORAGE_KEY, []);
  if (Array.isArray(persistedActivity)) {
    state.activity = persistedActivity.filter(function (item) {
      return item && typeof item === "object";
    }).slice(0, ACTIVITY_MAX_ITEMS);
  }
  renderHistory();
  renderActivity();
  el.n8nTypeFilter.value = "all";
  el.n8nRequestFilter.value = "";
  renderN8nEvents();
  el.output.textContent = "{}";
  el.resolvedClient.value = "-";
  if (hasEl("messageCount")) {
    var normalizedCount = parseMessageCount();
    el.messageCount.value = String(normalizedCount > 0 ? normalizedCount : 1);
  }
  fetchN8nEvents({ silent: true, limit: 30 });
  fetchDashboardStats({ silent: true });
  startN8nEventsPolling();
  loadClients();
  window.scrollTo({ top: 0, left: 0, behavior: "auto" });

  if (pauseRemoveModalOk) {
    pauseRemoveModalOk.addEventListener("click", function () {
      closePauseRemoveModal(true);
    });
  }
  if (pauseRemoveModalCancel) {
    pauseRemoveModalCancel.addEventListener("click", function () {
      closePauseRemoveModal(false);
    });
  }
  if (pauseRemoveModal) {
    pauseRemoveModal.addEventListener("click", function (event) {
      var target = event.target;
      if (target && target.getAttribute && target.getAttribute("data-pause-remove-close") === "true") {
        closePauseRemoveModal(false);
      }
    });
  }
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && pauseRemoveModal && pauseRemoveModal.classList.contains("is-open")) {
      closePauseRemoveModal(false);
    }
    if (event.key === "Escape" && imagePreviewModal && imagePreviewModal.classList.contains("is-open")) {
      closeImagePreviewModal();
    }
  });

  if (imagePreviewCloseBtn) {
    imagePreviewCloseBtn.addEventListener("click", closeImagePreviewModal);
  }
  if (imagePreviewModal) {
    imagePreviewModal.addEventListener("click", function (event) {
      var target = event.target;
      if (target && target.getAttribute && target.getAttribute("data-media-preview-close") === "true") {
        closeImagePreviewModal();
      }
    });
  }

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || !target.closest) {
      return;
    }
    var imageButton = target.closest("[data-image-preview-url]");
    if (!imageButton) {
      return;
    }
    event.preventDefault();
    openImagePreviewModal(imageButton.getAttribute("data-image-preview-url"));
  });
})();

(function() {
  var sidebar = document.getElementById('sidebar');
  var toggleBtn = document.getElementById('sidebarToggle');
  var overlay = document.getElementById('sidebarOverlay');
  var navLinks = document.querySelectorAll('.sidebar-nav a[data-page]');
  var SIDEBAR_COLLAPSED_KEY = "ia_infinity_sidebar_collapsed";

  function readSidebarCollapsedPreference() {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  }

  function writeSidebarCollapsedPreference(isCollapsed) {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, isCollapsed ? "1" : "0");
    } catch {}
  }

  function applySidebarCollapsedState(isCollapsed) {
    if (!sidebar || window.innerWidth <= 900) {
      return;
    }
    sidebar.classList.toggle("collapsed", Boolean(isCollapsed));
  }

  function updateToggleIcon() {
    if (!toggleBtn) {
      return;
    }
    if (window.innerWidth <= 900) {
      toggleBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg>';
      return;
    }
    toggleBtn.innerHTML = sidebar && sidebar.classList.contains("collapsed")
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>';
  }

  function guardCollapsedState() {
    if (!sidebar) {
      return;
    }
    if (window.innerWidth <= 900) {
      sidebar.classList.remove("collapsed");
      return;
    }
    applySidebarCollapsedState(readSidebarCollapsedPreference());
  }

  if (toggleBtn && sidebar) {
    toggleBtn.addEventListener('click', function() {
      if (window.innerWidth <= 900) {
        sidebar.classList.toggle('is-open');
        if (overlay) overlay.classList.toggle('is-visible');
      } else {
        sidebar.classList.toggle('collapsed');
        writeSidebarCollapsedPreference(sidebar.classList.contains("collapsed"));
        updateToggleIcon();
      }
    });
  }

  if (overlay) {
    overlay.addEventListener('click', function() {
      sidebar.classList.remove('is-open');
      overlay.classList.remove('is-visible');
    });
  }

  function replayStaggerInside(target) {
    if (!target || !target.querySelectorAll) {
      return;
    }
    target.querySelectorAll('.stagger-fade').forEach(function(node) {
      node.style.animation = 'none';
      void node.offsetHeight;
      node.style.animation = '';
    });
  }

  function runPageEnterAnimation(target) {
    if (!target || !target.classList) {
      return;
    }

    target.classList.remove('page-enter');
    void target.offsetHeight;
    target.classList.add('page-enter');
    replayStaggerInside(target);

    setTimeout(function() {
      target.classList.remove('page-enter');
    }, 260);
  }

  function navigateTo(pageId) {
    if (!pageId) return;
    var normalized = "reprocessador";
    if (pageId === "configuracoes") {
      normalized = "configuracoes";
    } else if (pageId === "ajuda") {
      normalized = "ajuda";
    }

    var routePath = "/reprocessador";
    if (normalized === "configuracoes") {
      routePath = "/configuracoes";
    } else if (normalized === "ajuda") {
      routePath = "/ajuda";
    }
    document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('is-active'); });
    document.querySelectorAll('[data-page]').forEach(function(l) { l.classList.remove('active'); });
    var target = document.getElementById('page-' + normalized);
    if (target) {
      target.classList.add('is-active');
      runPageEnterAnimation(target);
    }
    var navLink = document.querySelector('[data-page="' + normalized + '"]');
    if (navLink) navLink.classList.add('active');
    if (window.innerWidth <= 900) {
      sidebar.classList.remove('is-open');
      if (overlay) overlay.classList.remove('is-visible');
    }
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    var mainArea = document.querySelector(".main-area");
    if (mainArea && typeof mainArea.scrollTo === "function") {
      mainArea.scrollTo({ top: 0, left: 0, behavior: "auto" });
    }
    history.replaceState(null, '', routePath + '#' + normalized);
  }

  navLinks.forEach(function(link) {
    link.addEventListener('click', function(e) {
      e.preventDefault();
      var targetPage = this.getAttribute('data-page');
      navigateTo(targetPage);
    });
    link.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        var targetPage = this.getAttribute('data-page');
        navigateTo(targetPage);
      }
    });
  });

  window.addEventListener('resize', function() {
    guardCollapsedState();
    updateToggleIcon();
  });

  window.addEventListener('hashchange', function() {
    var hash = location.hash.replace('#', '');
    if (hash) navigateTo(hash);
  });

  guardCollapsedState();
  updateToggleIcon();

  var initialHash = location.hash.replace('#', '');
  if (initialHash) {
    navigateTo(initialHash);
  } else if (window.location.pathname === "/configuracoes") {
    navigateTo("configuracoes");
  } else if (window.location.pathname === "/ajuda") {
    navigateTo("ajuda");
  } else {
    navigateTo("reprocessador");
  }

  document.querySelectorAll('.faq-question').forEach(function(q){
    q.addEventListener('click',function(){
      var expanded=this.getAttribute('aria-expanded')==='true';
      document.querySelectorAll('.faq-question').forEach(function(o){o.setAttribute('aria-expanded','false');o.nextElementSibling.setAttribute('aria-hidden','true');});
      if(!expanded){this.setAttribute('aria-expanded','true');this.nextElementSibling.setAttribute('aria-hidden','false');}
    });
  });
  document.querySelectorAll('.help-card-link[data-scroll]').forEach(function(lk){
    lk.addEventListener('click',function(e){
      e.preventDefault();
      var target=document.getElementById(this.getAttribute('data-scroll'));
      if(target){
        var faqQ=target.closest('.faq-item')?target:target.querySelector('.faq-question');
        if(faqQ){faqQ.setAttribute('aria-expanded','true');faqQ.nextElementSibling.setAttribute('aria-hidden','false');}
        setTimeout(function(){target.scrollIntoView({behavior:'smooth',block:'start'});},100);
      }
    });
  });
  document.querySelectorAll('.help-card-link[data-page-nav]').forEach(function(lk){
    lk.addEventListener('click',function(e){
      e.preventDefault();
      var pageId=this.getAttribute('data-page-nav');
      if(typeof navigateTo==='function')navigateTo(pageId);
    });
  });
})();

(function() {
  document.querySelectorAll('.btn-primary').forEach(function(btn) {
    btn.addEventListener('pointermove', function(e) {
      var rect = this.getBoundingClientRect();
      this.style.setProperty('--mx', ((e.clientX - rect.left) / rect.width * 100) + '%');
      this.style.setProperty('--my', ((e.clientY - rect.top) / rect.height * 100) + '%');
    });
  });
})();

function fireConfetti(count) {
  count = count || 30;
  var colors = ['var(--accent)', 'var(--success)', 'var(--error)', 'var(--warning)'];
  for (var i = 0; i < count; i++) {
    var piece = document.createElement('div');
    piece.className = 'confetti-piece';
    var color = colors[Math.floor(Math.random() * colors.length)];
    var left = Math.random() * 100;
    var size = 4 + Math.random() * 6;
    var delay = Math.random() * 0.5;
    var duration = 1.5 + Math.random() * 1;
    piece.style.cssText = 'left:' + left + '%;bottom:-10px;width:' + size + 'px;height:' + size + 'px;background:' + color + ';border-radius:' + (Math.random() > 0.5 ? '50%' : '2px') + ';animation-delay:' + delay + 's;animation-duration:' + duration + 's';
    document.body.appendChild(piece);
    setTimeout(function(p) { p.remove(); }, (delay + duration) * 1000 + 100, piece);
  }
}

})();

