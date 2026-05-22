var state = {
  companies: [],
  supabaseTables: [],
  filteredTables: [],
  activeCompanyIndex: -1,
};

var el = {};
[
  "companiesContainer",
  "addCompanyBtn",
  "saveCompaniesBtn",
  "reloadCompaniesBtn",
  "statusBar",
  "statusText",
  "saveFeedback",
  "schemaInput",
  "loadTablesBtn",
  "tableFilterInput",
  "tableTargetCompanySelect",
  "supabaseTablesList",
  "supabaseTablesDatalist",
].forEach(function (id) {
  el[id] = document.getElementById(id);
});

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

function setSaveFeedback(message, type) {
  el.saveFeedback.textContent = safeText(message, "");
  el.saveFeedback.classList.remove("success", "error");
  if (type === "success") {
    el.saveFeedback.classList.add("success");
  } else if (type === "error") {
    el.saveFeedback.classList.add("error");
  }
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
  };
}

function renderCompanies() {
  el.companiesContainer.innerHTML = "";

  if (!Array.isArray(state.companies) || state.companies.length === 0) {
    var empty = document.createElement("div");
    empty.className = "config-empty";
    empty.textContent = "Nenhuma empresa cadastrada.";
    el.companiesContainer.appendChild(empty);
    return;
  }

  state.companies.forEach(function (company, index) {
    var row = document.createElement("div");
    row.className = "config-row" + (state.activeCompanyIndex === index ? " is-active" : "");
    row.setAttribute("data-company-row-index", String(index));
    row.innerHTML =
      '<div class="config-row-head">' +
      '<span class="config-row-title">Empresa #' + (index + 1) + "</span>" +
      '<button class="mini-btn danger" data-action="remove" data-index="' + index + '">Remover</button>' +
      "</div>" +
      '<div class="config-row-grid">' +
      '<div class="field"><label>Nome</label><input data-field="nome" data-index="' + index + '" value="' + escapeHtml(company.nome || "") + '" /></div>' +
      '<div class="field"><label>URL do webhook</label><input data-field="url_webhook" data-index="' + index + '" value="' + escapeHtml(company.url_webhook || "") + '" /></div>' +
      '<div class="field"><label>Tabela do Supabase</label><input list="supabaseTablesDatalist" data-field="tabela" data-index="' + index + '" value="' + escapeHtml(company.tabela || "") + '" /></div>' +
      "</div>";
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
  if (!["nome", "url_webhook", "tabela"].includes(field)) {
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

    companies.push({
      nome: nome,
      url_webhook: url,
      tabela: tabela,
    });
  });

  return companies;
}

async function saveCompanies() {
  try {
    setSaveFeedback("Salvando empresas.json...", "");
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
    setStatus("empresas.json salvo com sucesso.", false);
    setSaveFeedback("Arquivo salvo com sucesso.", "success");
  } catch (error) {
    setStatus("Erro ao salvar: " + safeText(error && error.message, "erro"), true);
    setSaveFeedback("Falha ao salvar: " + safeText(error && error.message, "erro"), "error");
  }
}

async function loadSupabaseTables() {
  var schema = safeText(el.schemaInput.value, "public");

  try {
    var response = await fetch("/api/reprocess/supabase/tables?schema=" + encodeURIComponent(schema));
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
  el.supabaseTablesList.innerHTML = "";
  if (!Array.isArray(state.filteredTables) || state.filteredTables.length === 0) {
    var empty = document.createElement("div");
    empty.className = "config-empty";
    empty.textContent = "Nenhuma tabela encontrada para esse filtro.";
    el.supabaseTablesList.appendChild(empty);
    return;
  }

  state.filteredTables.forEach(function (tableName) {
    var item = document.createElement("div");
    item.className = "table-item";
    item.innerHTML =
      '<span class="table-name">' + escapeHtml(tableName) + "</span>" +
      '<button data-action="pick-table" data-table="' + escapeHtml(tableName) + '">Usar</button>';
    el.supabaseTablesList.appendChild(item);
  });

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
  setSaveFeedback("Tabela aplicada. Clique em 'Salvar empresas.json' para persistir.", "");
}

el.addCompanyBtn.addEventListener("click", function () {
  state.companies.push(makeEmptyCompany());
  state.activeCompanyIndex = state.companies.length - 1;
  renderCompanies();
});

el.saveCompaniesBtn.addEventListener("click", saveCompanies);
el.reloadCompaniesBtn.addEventListener("click", loadCompanies);
el.loadTablesBtn.addEventListener("click", loadSupabaseTables);
el.tableFilterInput.addEventListener("input", applyTableFilter);
el.tableTargetCompanySelect.addEventListener("change", function () {
  var idx = Number(el.tableTargetCompanySelect.value);
  if (Number.isInteger(idx)) {
    setActiveCompanyIndex(idx);
  }
});

el.companiesContainer.addEventListener("input", function (event) {
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

el.companiesContainer.addEventListener("click", function (event) {
  var target = event.target;
  if (!target || !target.matches) {
    return;
  }
  if (target.getAttribute("data-action") === "remove") {
    removeCompany(target.getAttribute("data-index"));
    return;
  }

  var row = target.closest ? target.closest("[data-company-row-index]") : null;
  if (row) {
    setActiveCompanyIndex(row.getAttribute("data-company-row-index"));
  }
});

el.companiesContainer.addEventListener("focusin", function (event) {
  var target = event.target;
  if (!target || !target.closest) {
    return;
  }
  var row = target.closest("[data-company-row-index]");
  if (row) {
    setActiveCompanyIndex(row.getAttribute("data-company-row-index"));
  }
});

el.supabaseTablesList.addEventListener("click", function (event) {
  var target = event.target;
  if (!target || !target.matches) {
    return;
  }
  if (target.getAttribute("data-action") !== "pick-table") {
    return;
  }
  applySelectedTable(target.getAttribute("data-table"));
});

(function init() {
  setSaveFeedback("", "");
  loadCompanies();
  loadSupabaseTables();
})();
