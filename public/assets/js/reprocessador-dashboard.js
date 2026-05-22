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
  "summarySection",
  "previewSection",
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

function stopMonitor() {
  if (state.monitorTimer) {
    clearInterval(state.monitorTimer);
    state.monitorTimer = null;
  }
  state.monitorBusy = false;
  state.monitorStartedAt = 0;
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
  el.executeBtn.disabled = true;
  resetDiagnostic();
}

function showCards(hasData) {
  el.summarySection.style.display = hasData ? "block" : "none";
  el.previewSection.style.display = hasData ? "block" : "none";
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
}

async function generatePreview() {
  var url = (el.conversationUrl.value || "").trim();
  var selectedClient = (el.clientSelect.value || "").trim();

  if (!url) {
    setStatus("Informe o link da conversa.", true);
    return;
  }

  resetPreviewState();
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
    setStatus("Preview gerado. Revise e clique em Reprocessar.", false);
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
  el.dFlowMessage.textContent = safeText(event.likely_cause, "-");
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
      pushHistory("error", safeText(data && data.message, "Falha ao executar."));
      pushActivity("error", "Falha no reprocessamento", safeText(data && data.message, "Erro desconhecido."));
      setStatus(safeText(data && data.message, "Falha ao executar."), true);
      return;
    }

    state.lastDiagnosticContext = {
      requestId: safeText(data.request_id, ""),
      client: state.previewClientKey,
      conversationId: getConversationId(),
    };
    el.n8nLookupBtn.disabled = false;

    if (data.pause_status) {
      fillFlowStatus(data.pause_status);
    }

    if (data.skipped && data.status === "paused") {
      pushHistory("warning", data.message || "Contato pausado");
      pushActivity("warning", "Contato pausado", data.message || "Reprocessamento não enviado.");
      setStatus(data.message || "Contato pausado.", true);
      return;
    }

    startPostExecuteMonitor();
    await fetchLatestN8nStatus({ attempts: 2, delayMs: 900, silent: true });

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
el.clientSelect.addEventListener("change", resetPreviewState);
el.messageCount.addEventListener("input", resetPreviewState);
el.previewBtn.addEventListener("click", generatePreview);
el.executeBtn.addEventListener("click", executeReprocess);
el.clearDiagnosticBtn.addEventListener("click", resetDiagnostic);
el.refreshHistory.addEventListener("click", function () {
  renderHistory();
  setStatus("Histórico local atualizado.", false);
});

el.n8nLookupBtn.addEventListener("click", function () {
  fetchLatestN8nStatus({ attempts: 1, delayMs: 200, silent: false }).then(function (statusEvent) {
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
  el.output.textContent = "{}";
  el.resolvedClient.value = "-";
  loadClients();
})();
