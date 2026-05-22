var state = {
  clients: [],
  previewPayload: null,
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
  n8nEventsTimer: null,
  n8nEventsFingerprint: "",
  n8nFilterType: "all",
  n8nFilterRequest: "",
  currentConversationUrl: "",
  pauseStatusPreview: null,
  chatMessages: [],
  chatBaselineIds: [],
  chatNewOutgoingMessages: [],
  chatMonitorTimer: null,
  chatMonitorStartedAt: 0,
  chatMonitorBusy: false,
};

var el = {};
[
  "conversationUrl",
  "clientSelect",
  "resolvedClient",
  "messageCount",
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
  "summarySection",
  "previewSection",
  "chatPreviewSection",
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
  "statSuccess",
  "statErrors",
  "statPending",
  "statClients",
].forEach(function (id) {
  el[id] = document.getElementById(id);
});

function wait(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function safeText(value, fallback) {
  var text = String(value == null ? "" : value).trim();
  return text || fallback;
}

function setStatus(message, isError) {
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
  el.chatPreviewStatus.textContent = message;
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
  state.chatBaselineIds = [];
  state.chatNewOutgoingMessages = [];
  el.chatReprocessBadge.textContent = "0";
  renderChatMessages();
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

function renderChatMessages() {
  el.chatPreviewList.innerHTML = "";
  el.chatReprocessList.innerHTML = "";

  if (!Array.isArray(state.chatMessages) || state.chatMessages.length === 0) {
    var empty = document.createElement("div");
    empty.className = "chat-bubble";
    empty.innerHTML = '<div class="content">Nenhuma mensagem carregada.</div>';
    el.chatPreviewList.appendChild(empty);
  } else {
    state.chatMessages.slice(-60).forEach(function (message) {
      var bubble = document.createElement("div");
      var direction = safeText(message.direction, "unknown").toLowerCase();
      var classes = ["chat-bubble"];
      if (direction === "outbound") classes.push("outbound");
      if (direction === "private") classes.push("private");
      if (state.chatNewOutgoingMessages.some(function (m) { return getChatMessageKey(m) === getChatMessageKey(message); })) {
        classes.push("reprocess-new");
      }

      bubble.className = classes.join(" ");
      bubble.innerHTML =
        '<div class="meta">' +
        '<span>' + escapeHtml(safeText(message.sender_name, direction === "outbound" ? "Atendimento" : "Contato")) + "</span>" +
        '<span>' + escapeHtml(formatChatTime(message.created_at_iso)) + "</span>" +
        "</div>" +
        '<div class="content">' + escapeHtml(safeText(message.content, "[sem texto]")) + "</div>";
      el.chatPreviewList.appendChild(bubble);
    });
  }

  if (!Array.isArray(state.chatNewOutgoingMessages) || state.chatNewOutgoingMessages.length === 0) {
    var noNew = document.createElement("div");
    noNew.className = "chat-bubble";
    noNew.innerHTML = '<div class="content">Nenhuma nova mensagem outbound detectada ainda.</div>';
    el.chatReprocessList.appendChild(noNew);
    el.chatReprocessBadge.textContent = "0";
    return;
  }

  state.chatNewOutgoingMessages.slice(-20).forEach(function (message) {
    var bubble = document.createElement("div");
    bubble.className = "chat-bubble outbound reprocess-new";
    bubble.innerHTML =
      '<div class="meta">' +
      '<span>' + escapeHtml(safeText(message.sender_name, "Atendimento")) + "</span>" +
      '<span>' + escapeHtml(formatChatTime(message.created_at_iso)) + "</span>" +
      "</div>" +
      '<div class="content">' + escapeHtml(safeText(message.content, "[sem texto]")) + "</div>";
    el.chatReprocessList.appendChild(bubble);
  });

  el.chatReprocessBadge.textContent = String(state.chatNewOutgoingMessages.length);
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

    state.chatMessages = Array.isArray(data.messages) ? data.messages : [];
    renderChatMessages();
    setChatPreviewStatus("Preview do chat atualizado.");
    return data;
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
      const data = await fetchChatMessages({ silent: true, limit: 120 });
      if (!data) {
        return;
      }

      const newOutgoing = detectNewOutgoingMessages(state.chatMessages);
      if (newOutgoing.length > 0) {
        state.chatNewOutgoingMessages = newOutgoing;
        renderChatMessages();
        setChatPreviewStatus("Novas mensagens enviadas pelo reprocesso detectadas.");
        pushActivity("success", "Mensagens enviadas", "Chatwoot recebeu novas mensagens outbound.");
        stopChatMonitor();
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

  if (status === "success" || category.indexOf("success") >= 0 || category === "webhook_dispatched") {
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

function getFilteredN8nEvents() {
  var events = Array.isArray(state.n8nEvents) ? state.n8nEvents : [];
  return events.filter(function (event) {
    return (
      matchesTypeFilter(event, state.n8nFilterType) &&
      matchesRequestFilter(event, state.n8nFilterRequest)
    );
  }).slice(0, 30);
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

function renderN8nEvents() {
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

    var title = safeText(event.title || event.category, "Evento n8n");
    var desc = safeText(event.likely_cause || event.error_description || event.error_message, "-");
    var when = formatTimelineTime(event.received_at);
    var workflow = safeText(event.workflow_name, "-");
    var node = safeText(event.failed_node, "-");
    var execution = safeText(event.execution_id, "-");
    var requestId = safeText(event.request_id, "-");

    item.innerHTML =
      '<div class="head">' +
      '<span class="title">' + title + '</span>' +
      '<span class="meta">' + when + "</span>" +
      "</div>" +
      '<div class="desc">' + desc + "</div>" +
      '<div class="tags">' +
      '<span class="timeline-tag ' + type + '">' + safeText(event.category, "status") + "</span>" +
      '<span class="timeline-tag">workflow: ' + workflow + "</span>" +
      '<span class="timeline-tag">node: ' + node + "</span>" +
      '<span class="timeline-tag">exec: ' + execution + "</span>" +
      '<span class="timeline-tag">req: ' + requestId + "</span>" +
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
    var fingerprint = buildN8nEventsFingerprint(incoming);
    if (fingerprint === state.n8nEventsFingerprint) {
      return;
    }

    state.n8nEvents = incoming;
    state.n8nEventsFingerprint = fingerprint;
    renderN8nEvents();
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
  el.n8nLookupBtn.disabled = true;
  stopMonitor();
}

function resetPreviewState() {
  state.previewPayload = null;
  state.previewClientKey = "";
  state.pauseStatusPreview = null;
  el.executeBtn.disabled = true;
  resetDiagnostic();
  state.currentConversationUrl = "";
  resetChatState();
  renderPauseSummary(null);
  setChatPreviewStatus("Aguardando preview da conversa...");
}

function showCards(hasData) {
  el.summarySection.style.display = hasData ? "block" : "none";
  el.previewSection.style.display = hasData ? "block" : "none";
  el.chatPreviewSection.style.display = hasData ? "block" : "none";
}

var PER_PAGE = 5;

function renderHistory() {
  el.historyBody.innerHTML = "";
  el.historyPagination.innerHTML = "";

  if (state.history.length === 0) {
    var empty = document.createElement("tr");
    empty.innerHTML = '<td colspan="6" style="padding:24px;text-align:center;color:var(--muted);font-size:.85rem">Nenhum reprocessamento ainda nesta sessão.</td>';
    el.historyBody.appendChild(empty);
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
      '<td class="mono">' + item.id + "</td>" +
      '<td class="mono">' + item.conversation + "</td>" +
      '<td><span class="client-tag">' + item.client + "</span></td>" +
      '<td><span class="status-pill ' + statusClass + '">' + statusLabel + "</span></td>" +
      '<td style="color:var(--muted)">' + item.date + "</td>" +
      '<td style="color:var(--muted)">' + item.duration + "</td>";
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
}

var ACTIVITY_INITIAL = 5;

function renderActivity() {
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
    div.innerHTML =
      '<span class="dot ' + type + '"></span>' +
      '<div class="content"><div class="title">' + item.title + '</div><div class="desc">' + item.desc + "</div></div>" +
      '<span class="time">' + item.time + "</span>";
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
    message: message || "",
  };
  state.history.unshift(item);
  state.historyPage = 1;
  renderHistory();
}

function pushActivity(type, title, desc) {
  state.activity.unshift({
    type: type,
    title: title,
    desc: desc,
    time: new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
  });
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
  try {
    var response = await fetch("/api/reprocess/clients");
    var data = await response.json();

    if (!response.ok || !data || !data.success) {
      throw new Error((data && data.message) || "Falha ao carregar clientes.");
    }

    state.clients = Array.isArray(data.clients) ? data.clients : [];
    el.clientSelect.innerHTML = '<option value="">Detectar automaticamente</option>';

    state.clients.forEach(function (client) {
      var option = document.createElement("option");
      option.value = client.key;
      option.textContent = client.name + (client.key ? " (" + client.key + ")" : "");
      el.clientSelect.appendChild(option);
    });

    setStatus("Pronto. Cole o link da conversa.", false);
  } catch (error) {
    setStatus("Erro ao carregar clientes: " + error.message, true);
    el.previewBtn.disabled = true;
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
  var item = Array.isArray(previewData) ? previewData[0] : null;
  var body = (item && item.body) || {};
  var firstMessage = (body.messages && body.messages[0]) || {};
  var sender = (body.meta && body.meta.sender) || firstMessage.sender || {};
  var conversationId = body.conversation_id || body.id || "-";

  el.sAccount.textContent = safeText(firstMessage.account_id, "-");
  el.sConversation.textContent = safeText(conversationId, "-");
  el.sContact.textContent = safeText(sender.name, "-");
  el.sPhone.textContent = safeText(sender.phone_number, "-");
  el.sMessage.textContent = safeText(firstMessage.content, "-");
  el.sReceived.textContent = formatReceivedAt(body);
  el.sDetected.textContent = safeText(state.previewClientKey, "-");
  el.sWebhook.textContent = safeText(item && item.webhookUrl, "-");
  el.summaryBadge.textContent = conversationId !== "-" ? "#" + conversationId : "-";
  renderPauseSummary(state.pauseStatusPreview);
}

async function generatePreview() {
  var url = (el.conversationUrl.value || "").trim();
  var selectedClient = (el.clientSelect.value || "").trim();

  if (!url) {
    setStatus("Informe o link da conversa.", true);
    return;
  }

  resetPreviewState();
  state.currentConversationUrl = url;
  el.previewBtn.disabled = true;
  setStatus("Gerando preview no servidor...", false);

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
    state.previewClientKey = selectedClient;

    if (!state.previewClientKey) {
      var payloadWebhook = safeText(data[0] && data[0].webhookUrl, "").toLowerCase();
      var matched = state.clients.find(function (client) {
        return safeText(client.webhook_url, "").toLowerCase() === payloadWebhook;
      });
      state.previewClientKey = matched ? matched.key : "";
    }

    var clientMeta = state.clients.find(function (client) {
      return client.key === state.previewClientKey;
    });

    el.resolvedClient.value = clientMeta ? clientMeta.name + " (" + clientMeta.key + ")" : state.previewClientKey || "-";

    fillSummary(data);
    showCards(true);
    el.executeBtn.disabled = !(state.previewPayload && state.previewClientKey);
    var pausePreview = await fetchPauseStatusPreview({
      silent: true,
      payload: data,
      client: state.previewClientKey,
    });
    state.chatNewOutgoingMessages = [];
    await fetchChatMessages({ silent: true, limit: 120, conversationUrl: url });
    setChatBaselineFromMessages(state.chatMessages);
    renderChatMessages();
    if (pausePreview && pausePreview.pause_status && pausePreview.pause_status.paused === true) {
      setStatus("Preview gerado. Contato está pausado no Supabase (verifique no resumo).", true);
      pushActivity(
        "warning",
        "Contato pausado detectado",
        "Tabela: " + safeText(pausePreview.pause_status.table, "-") + " | Match: " + safeText(pausePreview.pause_status.matched_phone, "-"),
      );
    } else {
      setStatus("Preview gerado. Revise e clique em Reprocessar.", false);
    }
    pushActivity("success", "Preview gerado", "Payload pronto para revisão.");
  } catch (error) {
    showCards(false);
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
  if (!event || typeof event !== "object") {
    return;
  }

  el.diagnosticPanel.classList.add("is-visible");
  el.dWorkflow.textContent = safeText(event.workflow_name, "-");
  el.dNode.textContent = safeText(event.failed_node, "-");
  el.dExecution.textContent = safeText(event.execution_id, "-");
  el.dFlowMessage.textContent =
    safeText(event.error_description, "") ||
    safeText(event.error_message, "") ||
    ((event.upstream_messages && event.upstream_messages[0]) || "-");
  el.dUpstream.textContent =
    ((event.upstream_messages && event.upstream_messages[0]) || "") ||
    safeText(event.error_message, "-");

  if (event.category) {
    var currentCode = safeText(el.dCode.textContent, "");
    el.dCode.textContent = currentCode === "-" || !currentCode ? event.category : currentCode + " | " + event.category;
  }

  if (event.title) {
    el.dTitle.textContent = event.title;
  }
  if (event.likely_cause) {
    el.dCause.textContent = event.likely_cause;
  }
  if (event.suggestion) {
    el.dSuggestion.textContent = event.suggestion;
  }
}

function fillDiagnostic(errorPayload) {
  var details = (errorPayload && errorPayload.details) || {};

  el.diagnosticPanel.classList.add("is-visible");
  el.dCode.textContent = safeText(errorPayload.error, "-");
  el.dTitle.textContent = safeText(details.title, "-");
  el.dCause.textContent = safeText(details.likely_cause || errorPayload.message, "-");
  el.dSuggestion.textContent = safeText(details.suggestion, "-");
  el.dUpstream.textContent = safeText(details.upstream_message || details.error_cause, "-");
  el.dRequest.textContent = safeText(details.request_id || errorPayload.request_id, "-");

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
  state.monitorTimer = setInterval(async function () {
    if (state.monitorBusy) {
      return;
    }

    var elapsed = Date.now() - state.monitorStartedAt;
    if (elapsed > 180000) {
      stopMonitor();
      return;
    }

    state.monitorBusy = true;
    try {
      var executionEvent = await fetchLatestN8nExecution({ attempts: 1, delayMs: 200, silent: true, sync: true });
      if (executionEvent) {
        if (executionEvent.status === "success") {
          setStatus("Fluxo concluido no n8n.", false);
          pushActivity("success", "Fluxo concluído", safeText(executionEvent.likely_cause, "Execução finalizada."));
          stopMonitor();
          return;
        }

        if (executionEvent.status === "error" || executionEvent.status === "failed" || executionEvent.category === "n8n_execution_error") {
          setStatus("Erro no fluxo: " + safeText(executionEvent.title || executionEvent.category, "n8n"), true);
          pushActivity("error", "Erro no fluxo", safeText(executionEvent.likely_cause, "Falha no n8n."));
          stopMonitor();
          return;
        }
      }

      var errorEvent = await fetchLatestN8nError({ attempts: 1, delayMs: 200, silent: true });
      if (errorEvent) {
        setStatus("Erro no fluxo: " + safeText(errorEvent.title || errorEvent.category, "n8n"), true);
        pushActivity("error", "Erro no fluxo", safeText(errorEvent.error_description || errorEvent.error_message, "Erro no n8n."));
        stopMonitor();
        return;
      }

      var statusEvent = await fetchLatestN8nStatus({ attempts: 1, delayMs: 200, silent: true });
      if (statusEvent) {
        setStatus("Status do fluxo: " + safeText(statusEvent.title || statusEvent.category, "n8n"), false);
      }
    } finally {
      state.monitorBusy = false;
    }
  }, 8000);
}

async function executeReprocess() {
  if (!state.previewPayload || !state.previewClientKey) {
    setStatus("Gere o preview primeiro.", true);
    return;
  }

  el.executeBtn.disabled = true;
  resetDiagnostic();
  state.chatNewOutgoingMessages = [];
  await fetchChatMessages({ silent: true, limit: 120 });
  setChatBaselineFromMessages(state.chatMessages);
  renderChatMessages();
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
    el.output.textContent = JSON.stringify(data, null, 2);

    if (!response.ok || !data || !data.success) {
      fillDiagnostic(data || {});
      await fetchLatestN8nError({ attempts: 3, delayMs: 1200, silent: true });
      await fetchN8nEvents({ silent: true, limit: 30 });
      await fetchChatMessages({ silent: true, limit: 120 });
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
      pushHistory("warning", data.message || "Contato pausado");
      pushActivity("warning", "Contato pausado", data.message || "Reprocessamento não enviado.");
      setStatus(data.message || "Contato pausado.", true);
      return;
    }

    startPostExecuteMonitor();
    startChatPostReprocessMonitor();
    await fetchLatestN8nStatus({ attempts: 2, delayMs: 900, silent: true });
    await fetchN8nEvents({ silent: true, limit: 30, client: state.previewClientKey });

    pushHistory("success", data.message || "Reprocessamento enviado com sucesso.");
    pushActivity("success", "Reprocessamento enviado", data.message || "Webhook recebeu o payload.");
    setStatus(data.message || "Reprocessamento enviado com sucesso.", false);
  } catch (error) {
    pushHistory("error", error.message);
    pushActivity("error", "Erro de execução", error.message);
    setStatus(error.message, true);
  } finally {
    el.executeBtn.disabled = false;
  }
}

el.copyBtn.addEventListener("click", async function () {
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

el.conversationUrl.addEventListener("input", resetPreviewState);
el.clientSelect.addEventListener("change", function () {
  resetPreviewState();
  fetchN8nEvents({ silent: true, limit: 30 });
});
el.messageCount.addEventListener("input", resetPreviewState);
el.previewBtn.addEventListener("click", generatePreview);
el.executeBtn.addEventListener("click", executeReprocess);
el.clearDiagnosticBtn.addEventListener("click", resetDiagnostic);
el.refreshHistory.addEventListener("click", function () {
  renderHistory();
  setStatus("Histórico local atualizado.", false);
});
el.refreshN8nEventsBtn.addEventListener("click", function () {
  fetchN8nEvents({ silent: false, limit: 30 });
});
el.refreshChatPreviewBtn.addEventListener("click", function () {
  fetchChatMessages({ silent: false, limit: 120 });
});
el.n8nTypeFilter.addEventListener("change", function () {
  state.n8nFilterType = safeText(el.n8nTypeFilter.value, "all").toLowerCase();
  renderN8nEvents();
});
el.n8nRequestFilter.addEventListener("input", function () {
  state.n8nFilterRequest = safeText(el.n8nRequestFilter.value, "");
  renderN8nEvents();
});
el.clearN8nFiltersBtn.addEventListener("click", function () {
  state.n8nFilterType = "all";
  state.n8nFilterRequest = "";
  el.n8nTypeFilter.value = "all";
  el.n8nRequestFilter.value = "";
  renderN8nEvents();
});

el.n8nLookupBtn.addEventListener("click", function () {
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
  showCards(false);
  resetPreviewState();
  renderHistory();
  renderActivity();
  el.n8nTypeFilter.value = "all";
  el.n8nRequestFilter.value = "";
  renderN8nEvents();
  el.output.textContent = "{}";
  el.resolvedClient.value = "-";
  fetchN8nEvents({ silent: true, limit: 30 });
  startN8nEventsPolling();
  loadClients();
})();
