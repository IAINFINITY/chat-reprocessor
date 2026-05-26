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
  activityExpanded: false,
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
  "n8nEventsFeed",
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
].forEach(function (id) {
  el[id] = document.getElementById(id);
});

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

function wait(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function safeText(value, fallback) {
  var text = String(value == null ? "" : value).trim();
  return text || fallback;
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
    el.mediaStatusBar.classList.remove("is-visible", "is-error");
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

function syncEditedMessageInputFromPayload(payload) {
  if (!hasEl("editedMessage")) {
    return;
  }
  el.editedMessage.value = extractPreviewMainMessage(payload);
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
        '<div class="content">' + escapeHtml(safeText(message.content, "[sem texto]")) + "</div>";

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
      '<div class="content">' + escapeHtml(safeText(message.content, "[sem texto]")) + "</div>";

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

function getFilteredN8nEvents() {
  var events = Array.isArray(state.n8nEvents) ? state.n8nEvents : [];
  var filtered = events.filter(function (event) {
    return (
      matchesTypeFilter(event, state.n8nFilterType) &&
      matchesRequestFilter(event, state.n8nFilterRequest)
    );
  });

  return collapseTimelineNoise(filtered).slice(0, 30);
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
  var merged = state.localN8nEvents.concat(serverEvents);
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
    return;
  }

  filteredEvents.slice(0, 15).forEach(function (event) {
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
}

async function fetchN8nEvents(options) {
  var opts = options || {};
  var silent = opts.silent === true;
  var limit = Number(opts.limit || 30);
  var client = opts.client || getN8nTimelineClient();
  var params = new URLSearchParams();
  params.set("limit", String(Math.max(5, Math.min(limit, 100))));
  if (client) {
    params.set("client", client);
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
    var localEvents = Array.isArray(state.localN8nEvents) ? state.localN8nEvents : [];
    var combined = localEvents.concat(incoming);
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
  }, 15000);
}

function resetDiagnostic() {
  if (!hasEl("diagnosticPanel")) {
    return;
  }
  el.diagnosticPanel.classList.remove("is-visible");
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

function resetPreviewState() {
  state.previewPayload = null;
  state.previewOriginalPayload = null;
  state.previewMediaMeta = null;
  state.previewClientKey = "";
  state.pauseStatusPreview = null;
  el.executeBtn.disabled = true;
  resetDiagnostic();
  el.companyLogoArea.classList.remove("is-visible");
  state.currentConversationUrl = "";
  resetChatState();
  renderPauseSummary(null);
  renderMediaStatus(null);
  if (hasEl("editedMessage")) {
    el.editedMessage.value = "";
  }
  setChatPreviewStatus("Aguardando preview da conversa...");
  setPipelineStep(0);
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
    var statusClass = item.status === "success" ? "success" : item.status === "error" ? "error" : "warning";
    var statusLabel = item.status === "success" ? "Sucesso" : item.status === "error" ? "Erro" : "Aviso";
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
}

var ACTIVITY_INITIAL = 5;

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
    return;
  }

  var limit = state.activityExpanded ? state.activity.length : ACTIVITY_INITIAL;
  var items = state.activity.slice(0, limit);

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

  if (state.activity.length > ACTIVITY_INITIAL) {
    var wrap = document.createElement("div");
    wrap.className = "show-more-wrap";

    var btn = document.createElement("button");
    btn.className = "show-more-btn" + (state.activityExpanded ? " expanded" : "");
    btn.innerHTML = state.activityExpanded
      ? 'Mostrar menos <span class="arrow">&#9650;</span>'
      : 'Ver mais (' + (state.activity.length - ACTIVITY_INITIAL) + ') <span class="arrow">&#9660;</span>';
    btn.addEventListener("click", function () {
      state.activityExpanded = !state.activityExpanded;
      renderActivity();
    });

    wrap.appendChild(btn);
    el.activityFeed.appendChild(wrap);
  }
}

function pushHistory(status, message) {
  var now = new Date();
  var item = {
    id: "RP-" + String(now.getTime()).slice(-6),
    conversation: getConversationId() || "-",
    client: state.previewClientKey || "-",
    status: status,
    date: now.toLocaleString("pt-BR"),
    duration: "-",
    requestId: safeText(state.activeRunRequestId, ""),
  };
  state.history.unshift(item);
  state.historyPage = 1;
  writeStorageJson(HISTORY_STORAGE_KEY, state.history.slice(0, 200));
  renderHistory();
  return item.id;
}

function normalizeHistoryStatus(value) {
  var status = safeText(value, "").toLowerCase();
  if (status === "failed") {
    return "error";
  }
  if (status === "running" || status === "pending" || status === "new" || status === "waiting") {
    return "warning";
  }
  if (status === "success") {
    return "success";
  }
  if (status === "error") {
    return "error";
  }
  return "warning";
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

  if (current === "error" && next === "warning") {
    return false;
  }

  if (current === "warning" && next === "error") {
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
  state.history[idx].duration = duration;
  writeStorageJson(HISTORY_STORAGE_KEY, state.history.slice(0, 200));
  renderHistory();
  return true;
}

function pushActivity(type, title, desc) {
  state.activity.unshift({
    type: type,
    title: title,
    desc: desc,
    time: new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
  });
  state.activity = state.activity.slice(0, 200);
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
        setStatus(safeText(data && data.message, "Falha ao consultar status de pausa."), true);
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
      setStatus("Erro ao consultar status de pausa: " + safeText(error && error.message, "erro"), true);
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

function updateDashboardStats() {
  var successCount = 0;
  var errorCount = 0;
  var pendingCount = 0;

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

  var total = Math.max(1, successCount + errorCount + pendingCount);
  var successPercent = Math.round((successCount / total) * 100);
  var errorPercent = Math.round((errorCount / total) * 100);
  var pendingPercent = Math.round((pendingCount / total) * 100);
  var clientsCount = Array.isArray(state.clients) ? state.clients.length : 0;
  var uniqueClientsInHistory = new Set(
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

  if (!url) {
    setStatus("Informe o link da conversa.", true);
    return;
  }

  resetPreviewState();
  state.currentConversationUrl = url;
  el.previewBtn.disabled = true;
  setPipelineStep(1);
  setStatus("Gerando preview no servidor...", false);
  showCards(true);
  setChatPreviewStatus("Carregando conversa original...");
  await fetchChatMessages({ silent: false, limit: 120, conversationUrl: url });

  try {
    var response = await fetch("/api/reprocess/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationUrl: url,
        client: selectedClient || undefined,
        messageCount: parseMessageCount(),
      }),
    });

    var data = await readJsonSafe(response);
    el.output.textContent = JSON.stringify(data, null, 2);

    if (!response.ok || !Array.isArray(data) || data.length === 0) {
      if (data && typeof data === "object" && !Array.isArray(data)) {
        fillDiagnostic(data);
      }
      throw new Error((data && data.message) || "Falha ao gerar preview.");
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
  } catch (error) {
    setPipelineStep(0);
    if (!Array.isArray(state.chatMessages) || state.chatMessages.length === 0) {
      showCards(false);
    } else {
      showCards(true);
      setChatPreviewStatus("Preview falhou, mas as mensagens da conversa foram carregadas.");
    }
    setStatus(error.message, true);
    pushActivity("error", "Falha ao gerar preview", error.message);
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

  el.diagnosticPanel.classList.add("is-visible");
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
        fillFlowStatus(data.event);
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
      updateHistoryByRequestId(state.activeRunRequestId, "warning", "Monitor encerrado por timeout sem status final do n8n.");
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
        updateHistoryByRequestId(state.activeRunRequestId, "warning", "Fluxo em andamento no n8n (sem status final ainda).");
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
      setPipelineStep(4);
      fillDiagnostic(data || {});
      await fetchLatestN8nError({ attempts: 3, delayMs: 1200, silent: true });
      await fetchN8nEvents({ silent: true, limit: 30 });
      await fetchChatMessages({ silent: true, limit: 120, suppressAnimations: true });
      pushHistory("error", safeText(data && data.message, "Falha ao executar."));
      pushActivity("error", "Falha no reprocessamento", safeText(data && data.message, "Erro desconhecido."));
      setStatus(safeText(data && data.message, "Falha ao executar."), true);
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
      pushHistory("warning", data.message || "Contato pausado");
      pushActivity("warning", "Contato pausado", data.message || "Reprocessamento não enviado.");
      setStatus(data.message || "Contato pausado.", true);
      showToast(data.message || "Contato pausado. Reprocessamento não enviado.", "error");
      return;
    }

    state.activeRunRequestId = safeText(data.request_id, "");
    state.activeRunStartedAt = Date.now();
    state.n8nFilterRequest = state.activeRunRequestId;
    if (hasEl("n8nRequestFilter")) {
      el.n8nRequestFilter.value = state.activeRunRequestId;
    }
    pushHistory("warning", "Payload enviado ao webhook. Aguardando conclusão do fluxo.");
    startPostExecuteMonitor();
    startChatPostReprocessMonitor();
    await fetchLatestN8nStatus({ attempts: 2, delayMs: 900, silent: true });
    await fetchN8nEvents({ silent: true, limit: 30, client: state.previewClientKey });

    pushActivity("success", "Reprocessamento enviado", data.message || "Webhook recebeu o payload inicial.");
    setStatus("Reprocessamento enviado com sucesso. Aguardando conclusão do fluxo no n8n...", false);
    showToast("Reprocessamento enviado com sucesso.", "success");
  } catch (error) {
    setPipelineStep(4);
    pushHistory("error", error.message);
    pushActivity("error", "Erro de execução", error.message);
    setStatus(error.message, true);
    showToast(error.message, "error");
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
onEl("refreshHistory", "click", function () {
  renderHistory();
  setStatus("Histórico local atualizado.", false);
});
onEl("refreshN8nEventsBtn", "click", function () {
  fetchN8nEvents({ silent: false, limit: 30 });
});
onEl("refreshChatPreviewBtn", "click", function () {
  fetchChatMessages({ silent: false, limit: 120 });
});
onEl("n8nTypeFilter", "change", function () {
  state.n8nFilterType = safeText(el.n8nTypeFilter.value, "all").toLowerCase();
  renderN8nEvents();
});
onEl("n8nRequestFilter", "input", function () {
  state.n8nFilterRequest = safeText(el.n8nRequestFilter.value, "");
  renderN8nEvents();
});
onEl("clearN8nFiltersBtn", "click", function () {
  state.n8nFilterType = "all";
  state.n8nFilterRequest = "";
  el.n8nTypeFilter.value = "all";
  el.n8nRequestFilter.value = "";
  renderN8nEvents();
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
    }).slice(0, 200);
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
  startN8nEventsPolling();
  loadClients();
  window.scrollTo({ top: 0, left: 0, behavior: "auto" });
})();

/* ── Sidebar toggle & page navigation ── */
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
    var normalized = pageId === "configuracoes" ? "configuracoes" : "reprocessador";
    var routePath = normalized === "configuracoes" ? "/configuracoes" : "/reprocessador";
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
  } else {
    navigateTo("reprocessador");
  }
})();

/* ── Ripple effect on primary buttons ── */
(function() {
  document.querySelectorAll('.btn-primary').forEach(function(btn) {
    btn.addEventListener('pointermove', function(e) {
      var rect = this.getBoundingClientRect();
      this.style.setProperty('--mx', ((e.clientX - rect.left) / rect.width * 100) + '%');
      this.style.setProperty('--my', ((e.clientY - rect.top) / rect.height * 100) + '%');
    });
  });
})();

/* ── Confetti helper ── */
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

