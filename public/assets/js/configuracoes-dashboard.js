(() => {
"use strict";

var state = {
  companies: [],
  supabaseTables: [],
  filteredTables: [],
  activeCompanyIndex: -1,
  confirmResolver: null,
};

var el = {};
[
  "companiesContainer",
  "addCompanyBtn",
  "addManyCompaniesBtn",
  "saveCompaniesBtn",
  "reloadCompaniesBtn",
  "configStatusBar",
  "configStatusText",
  "saveFeedback",
  "schemaInput",
  "loadTablesBtn",
  "tableFilterInput",
  "tableTargetCompanySelect",
  "supabaseTablesList",
  "supabaseTablesDatalist",
  "tablesCount",
  "confirmModal",
  "confirmModalMessage",
  "confirmModalOk",
  "confirmModalCancel",
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

function safeText(value, fallback) {
  var text = String(value == null ? "" : value).trim();
  return text || fallback;
}

function setStatus(message, isError) {
  if (!hasEl("configStatusText") || !hasEl("configStatusBar")) {
    return;
  }
  el.configStatusText.textContent = message;
  el.configStatusBar.style.animation = "none";
  el.configStatusBar.classList.remove("is-visible", "is-error");
  void el.configStatusBar.offsetHeight;
  if (isError) {
    el.configStatusBar.classList.add("is-error");
  } else {
    el.configStatusBar.classList.add("is-visible");
  }
}

function setSaveFeedback(message, type) {
  if (!hasEl("saveFeedback")) {
    return;
  }
  el.saveFeedback.textContent = safeText(message, "");
  el.saveFeedback.classList.remove("success", "error");
  if (type === "success") {
    el.saveFeedback.classList.add("success");
  } else if (type === "error") {
    el.saveFeedback.classList.add("error");
  }
}

function closeConfirmModal(result) {
  if (hasEl("confirmModal")) {
    el.confirmModal.classList.remove("is-open");
    el.confirmModal.setAttribute("aria-hidden", "true");
  }

  if (typeof state.confirmResolver === "function") {
    var resolver = state.confirmResolver;
    state.confirmResolver = null;
    resolver(Boolean(result));
  }
}

function openConfirmModal(message) {
  if (!el.confirmModal || !el.confirmModalMessage) {
    return Promise.resolve(window.confirm(String(message || "Deseja continuar?")));
  }

  if (typeof state.confirmResolver === "function") {
    state.confirmResolver(false);
    state.confirmResolver = null;
  }

  el.confirmModalMessage.textContent = safeText(message, "Deseja continuar?");
  el.confirmModal.classList.add("is-open");
  el.confirmModal.setAttribute("aria-hidden", "false");

  return new Promise(function (resolve) {
    state.confirmResolver = resolve;
  });
}

async function readJsonSafe(response) {
  var raw = await response.text();
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {
      success: false,
      error: "non_json_response",
      message: raw || "Resposta não JSON.",
    };
  }
}

function makeEmptyCompany() {
  return {
    nome: "",
    url_webhook: "",
    tabela: "",
    chatwoot_account_ids: [],
  };
}

function renderCompanies() {
  if (!hasEl("companiesContainer")) {
    return;
  }
  el.companiesContainer.innerHTML = "";

  if (!Array.isArray(state.companies) || state.companies.length === 0) {
    el.companiesContainer.innerHTML = '<div class="config-empty"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:block;margin:0 auto 6px;opacity:0.3"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>Nenhuma empresa cadastrada.<br>Clique em <strong>Nova empresa</strong> para adicionar.</div>';
    renderTableTargetOptions();
    return;
  }

  state.companies.forEach(function (company, index) {
    var row = document.createElement("div");
    row.className = "config-row" + (state.activeCompanyIndex === index ? " is-active" : "");
    row.setAttribute("data-company-row-index", String(index));
    var accountIdsText = Array.isArray(company.chatwoot_account_ids)
      ? company.chatwoot_account_ids.join(",")
      : safeText(company.chatwoot_account_ids, "");
    row.innerHTML = '<div class="config-row-head"><span class="config-row-title">' + escapeHtml(company.nome || ('Empresa #' + (index + 1))) + '</span><button class="mini-btn danger" data-action="remove" data-index="' + index + '"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> Remover</button></div><div class="config-row-grid"><div class="field"><label>Nome</label><input data-field="nome" data-index="' + index + '" value="' + escapeHtml(company.nome || '') + '" placeholder="Ex: Akila"></div><div class="field"><label>Webhook URL</label><input data-field="url_webhook" data-index="' + index + '" value="' + escapeHtml(company.url_webhook || '') + '" placeholder="https://webhooks-n8n.app/webhook/..."></div><div class="field"><label>Account IDs Chatwoot</label><input data-field="chatwoot_account_ids" data-index="' + index + '" value="' + escapeHtml(accountIdsText) + '" placeholder="Ex: 20,26"></div><div class="field full"><label>Tabela de pausa (Supabase)</label><input list="supabaseTablesDatalist" data-field="tabela" data-index="' + index + '" value="' + escapeHtml(company.tabela || '') + '" placeholder="Ex: REPROCESSAMENTO - ASTRO - DADOS CONVERSA_pausar"></div></div>';
    el.companiesContainer.appendChild(row);
  });

  renderTableTargetOptions();
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function updateCompanyField(index, field, value) {
  var idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= state.companies.length) {
    return;
  }
  if (!["nome", "url_webhook", "tabela", "chatwoot_account_ids"].includes(field)) {
    return;
  }
  if (field === "chatwoot_account_ids") {
    state.companies[idx].chatwoot_account_ids = String(value || "")
      .split(",")
      .map(function (item) { return item.trim(); })
      .filter(Boolean)
      .map(function (item) { return Number(item); })
      .filter(function (item) { return Number.isInteger(item) && item > 0; });
    return;
  }
  state.companies[idx][field] = String(value || "");
}

function removeCompany(index) {
  var idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= state.companies.length) {
    return;
  }
  state.companies.splice(idx, 1);
  if (state.activeCompanyIndex >= state.companies.length) {
    state.activeCompanyIndex = state.companies.length - 1;
  }
  renderCompanies();
}

function setActiveCompanyIndex(index) {
  var idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= state.companies.length) {
    state.activeCompanyIndex = -1;
  } else {
    state.activeCompanyIndex = idx;
  }

  var rows = el.companiesContainer.querySelectorAll(".config-row");
  rows.forEach(function (row) {
    var rowIndex = Number(row.getAttribute("data-company-row-index"));
    if (rowIndex === state.activeCompanyIndex) {
      row.classList.add("is-active");
    } else {
      row.classList.remove("is-active");
    }
  });

  if (el.tableTargetCompanySelect && state.activeCompanyIndex >= 0) {
    el.tableTargetCompanySelect.value = String(state.activeCompanyIndex);
  }
}

function renderTableTargetOptions() {
  if (!el.tableTargetCompanySelect) {
    return;
  }
  el.tableTargetCompanySelect.innerHTML = "";
  if (!Array.isArray(state.companies) || state.companies.length === 0) {
    var empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "Sem empresas";
    el.tableTargetCompanySelect.appendChild(empty);
    return;
  }

  state.companies.forEach(function (company, index) {
    var option = document.createElement("option");
    option.value = String(index);
    option.textContent = safeText(company.nome, "Empresa #" + (index + 1));
    el.tableTargetCompanySelect.appendChild(option);
  });

  if (state.activeCompanyIndex >= 0 && state.activeCompanyIndex < state.companies.length) {
    el.tableTargetCompanySelect.value = String(state.activeCompanyIndex);
  }
}

async function loadCompanies() {
  if (!hasEl("companiesContainer")) {
    return;
  }
  try {
    var response = await fetch("/api/config/empresas");
    var data = await readJsonSafe(response);
    if (!response.ok || !data || !data.success) {
      throw new Error((data && data.message) || "Falha ao carregar empresas.");
    }
    state.companies = Array.isArray(data.empresas) ? data.empresas : [];
    if (state.activeCompanyIndex < 0 && state.companies.length > 0) {
      state.activeCompanyIndex = 0;
    }
    renderCompanies();
    setSaveFeedback("", "");
    setStatus("Configurações carregadas.", false);
  } catch (error) {
    setStatus("Erro ao carregar empresas: " + safeText(error && error.message, "erro"), true);
    setSaveFeedback("", "");
  }
}

function collectCompaniesFromUi() {
  var rows = el.companiesContainer.querySelectorAll(".config-row");
  var companies = [];

  rows.forEach(function (row) {
    var nome = safeText(row.querySelector('[data-field="nome"]') && row.querySelector('[data-field="nome"]').value, "");
    var url = safeText(row.querySelector('[data-field="url_webhook"]') && row.querySelector('[data-field="url_webhook"]').value, "");
    var tabela = safeText(row.querySelector('[data-field="tabela"]') && row.querySelector('[data-field="tabela"]').value, "");
    var accountIdsRaw = safeText(row.querySelector('[data-field="chatwoot_account_ids"]') && row.querySelector('[data-field="chatwoot_account_ids"]').value, "");
    var accountIds = accountIdsRaw
      .split(",")
      .map(function (item) { return item.trim(); })
      .filter(Boolean)
      .map(function (item) { return Number(item); })
      .filter(function (item) { return Number.isInteger(item) && item > 0; });

    companies.push({
      nome: nome,
      url_webhook: url,
      tabela: tabela,
      chatwoot_account_ids: accountIds,
    });
  });

  return companies;
}

async function saveCompanies() {
  if (!hasEl("companiesContainer")) {
    return;
  }
  try {
    setSaveFeedback("Salvando configuracao de empresas...", "");
    var payload = {
      empresas: collectCompaniesFromUi(),
    };

    var response = await fetch("/api/config/empresas", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    var data = await readJsonSafe(response);
    if (!response.ok || !data || !data.success) {
      throw new Error((data && data.message) || "Falha ao salvar empresas.");
    }
    state.companies = Array.isArray(data.empresas) ? data.empresas : [];
    renderCompanies();
    setStatus("Configuracao de empresas salva com sucesso.", false);
    setSaveFeedback("Configuracao salva com sucesso.", "success");
  } catch (error) {
    setStatus("Erro ao salvar: " + safeText(error && error.message, "erro"), true);
    setSaveFeedback("Falha ao salvar: " + safeText(error && error.message, "erro"), "error");
  }
}

async function loadSupabaseTables() {
  if (!hasEl("schemaInput")) {
    return;
  }
  var schema = safeText(el.schemaInput.value, "public");

  try {
    var response = await fetch(
      "/api/reprocess/supabase/tables?schema=" +
        encodeURIComponent(schema) +
        "&include_all=true",
    );
    var data = await readJsonSafe(response);
    if (!response.ok || !data || !data.success) {
      throw new Error((data && data.message) || "Falha ao carregar tabelas.");
    }
    state.supabaseTables = Array.isArray(data.tables) ? data.tables : [];
    applyTableFilter();
    setStatus("Tabelas do Supabase carregadas.", false);
  } catch (error) {
    setStatus("Erro ao carregar tabelas: " + safeText(error && error.message, "erro"), true);
  }
}

function applyTableFilter() {
  if (!hasEl("tableFilterInput")) {
    return;
  }
  var needle = safeText(el.tableFilterInput.value, "").toLowerCase();
  if (!needle) {
    state.filteredTables = state.supabaseTables.slice();
  } else {
    state.filteredTables = state.supabaseTables.filter(function (tableName) {
      return String(tableName || "").toLowerCase().indexOf(needle) >= 0;
    });
  }
  renderSupabaseTables();
}

function renderSupabaseTables() {
  if (!hasEl("supabaseTablesList")) {
    return;
  }
  el.supabaseTablesList.innerHTML = "";
  if (!Array.isArray(state.filteredTables) || state.filteredTables.length === 0) {
    el.supabaseTablesList.innerHTML = '<div class="config-empty"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:block;margin:0 auto 6px;opacity:0.3"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>Nenhuma tabela encontrada para este filtro.</div>';
    renderTablesDatalist();
    if (el.tablesCount) el.tablesCount.textContent = "0";
    return;
  }

  state.filteredTables.forEach(function (tableName) {
    var item = document.createElement("div");
    item.className = "table-item";
    var shortName = tableName.length > 25 ? tableName.substring(0, 22) + "..." : tableName;
    item.innerHTML = '<span class="table-icon">DB</span><span class="table-name" title="' + escapeHtml(tableName) + '">' + escapeHtml(shortName) + '</span><button data-action="pick-table" data-table="' + escapeHtml(tableName) + '"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.66V20a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5.34"/><polygon points="18 2 22 6 12 16 8 16 8 12 18 2"/></svg> Vincular</button>';
    el.supabaseTablesList.appendChild(item);
  });

  if (el.tablesCount) el.tablesCount.textContent = String(state.filteredTables.length);
  renderTablesDatalist();
}

function renderTablesDatalist() {
  if (!el.supabaseTablesDatalist) {
    return;
  }
  el.supabaseTablesDatalist.innerHTML = "";
  (Array.isArray(state.supabaseTables) ? state.supabaseTables : []).forEach(function (tableName) {
    var opt = document.createElement("option");
    opt.value = tableName;
    el.supabaseTablesDatalist.appendChild(opt);
  });
}

function getFocusedTableInput() {
  var active = document.activeElement;
  if (!active) {
    return null;
  }
  if (active.matches && active.matches('input[data-field="tabela"]')) {
    return active;
  }
  return null;
}

function applySelectedTable(tableName) {
  var targetInput = getFocusedTableInput();
  if (!targetInput && el.tableTargetCompanySelect && el.tableTargetCompanySelect.value !== "") {
    var pickedIndex = Number(el.tableTargetCompanySelect.value);
    if (Number.isInteger(pickedIndex) && pickedIndex >= 0 && pickedIndex < state.companies.length) {
      targetInput = el.companiesContainer.querySelector(
        'input[data-field="tabela"][data-index="' + pickedIndex + '"]',
      );
      setActiveCompanyIndex(pickedIndex);
    }
  }
  if (!targetInput && state.activeCompanyIndex >= 0) {
    targetInput = el.companiesContainer.querySelector(
      'input[data-field="tabela"][data-index="' + state.activeCompanyIndex + '"]',
    );
  }

  if (!targetInput) {
    setStatus("Selecione uma empresa e depois clique em 'Usar' na tabela.", true);
    return;
  }

  targetInput.value = tableName;
  var index = Number(targetInput.getAttribute("data-index"));
  if (Number.isInteger(index) && state.companies[index]) {
    state.companies[index].tabela = tableName;
  }
  setStatus("Tabela aplicada na empresa selecionada.", false);
  setSaveFeedback("Tabela aplicada. Clique em 'Salvar configuracao' para persistir.", "");
}

onEl("addCompanyBtn", "click", async function () {
  var confirmed = await openConfirmModal("Deseja adicionar uma nova empresa?");
  if (!confirmed) {
    return;
  }
  state.companies.push(makeEmptyCompany());
  state.activeCompanyIndex = state.companies.length - 1;
  renderCompanies();
  setStatus("Nova empresa adicionada. Preencha os campos e salve.", false);
});

if (hasEl("addManyCompaniesBtn")) {
  onEl("addManyCompaniesBtn", "click", async function () {
    var confirmed = await openConfirmModal("Deseja adicionar 5 empresas de uma vez?");
    if (!confirmed) {
      return;
    }
    for (var i = 0; i < 5; i += 1) {
      state.companies.push(makeEmptyCompany());
    }
    state.activeCompanyIndex = state.companies.length - 1;
    renderCompanies();
    setStatus("5 empresas adicionadas. Preencha os campos e salve.", false);
  });
}

onEl("saveCompaniesBtn", "click", saveCompanies);
onEl("reloadCompaniesBtn", "click", loadCompanies);
onEl("loadTablesBtn", "click", loadSupabaseTables);
onEl("tableFilterInput", "input", applyTableFilter);
onEl("tableTargetCompanySelect", "change", function () {
  var idx = Number(el.tableTargetCompanySelect.value);
  if (Number.isInteger(idx)) {
    setActiveCompanyIndex(idx);
  }
});

onEl("companiesContainer", "input", function (event) {
  var target = event.target;
  if (!target || !target.matches) {
    return;
  }
  if (!target.matches("input[data-field][data-index]")) {
    return;
  }
  updateCompanyField(
    target.getAttribute("data-index"),
    target.getAttribute("data-field"),
    target.value,
  );
});

onEl("companiesContainer", "click", async function (event) {
  var target = event.target;
  if (!target || !target.closest) {
    return;
  }
  var removeButton = target.closest('[data-action="remove"]');
  if (removeButton) {
    var confirmed = await openConfirmModal("Deseja remover esta empresa?");
    if (!confirmed) {
      return;
    }
    removeCompany(removeButton.getAttribute("data-index"));
    setStatus("Empresa removida. Clique em salvar para persistir.", false);
    return;
  }

  var row = target.closest ? target.closest("[data-company-row-index]") : null;
  if (row) {
    setActiveCompanyIndex(row.getAttribute("data-company-row-index"));
  }
});

onEl("companiesContainer", "focusin", function (event) {
  var target = event.target;
  if (!target || !target.closest) {
    return;
  }
  var row = target.closest("[data-company-row-index]");
  if (row) {
    setActiveCompanyIndex(row.getAttribute("data-company-row-index"));
  }
});

onEl("supabaseTablesList", "click", function (event) {
  var target = event.target;
  if (!target || !target.closest) {
    return;
  }
  var actionButton = target.closest('[data-action="pick-table"]');
  if (!actionButton) {
    return;
  }
  applySelectedTable(actionButton.getAttribute("data-table"));
});

if (hasEl("confirmModalOk")) {
  onEl("confirmModalOk", "click", function () {
    closeConfirmModal(true);
  });
}

if (hasEl("confirmModalCancel")) {
  onEl("confirmModalCancel", "click", function () {
    closeConfirmModal(false);
  });
}

if (hasEl("confirmModal")) {
  onEl("confirmModal", "click", function (event) {
    var target = event.target;
    if (target && target.getAttribute && target.getAttribute("data-modal-close") === "true") {
      closeConfirmModal(false);
    }
  });
}

(function init() {
  if (!hasEl("companiesContainer")) {
    console.error("[configuracoes-dashboard] Elementos essenciais nao encontrados no DOM. Script em modo degradado.");
    return;
  }
  setSaveFeedback("", "");
  loadCompanies();
  loadSupabaseTables();
})();

})();

