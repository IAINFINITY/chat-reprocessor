(() => {
"use strict";

const logoutBtn = document.getElementById("logoutBtn");
const confirmModal = document.getElementById("confirmModal");
const confirmMessage = document.getElementById("confirmModalMessage");
const confirmOk = document.getElementById("confirmModalOk");
const confirmCancel = document.getElementById("confirmModalCancel");

let resolver = null;

function safeText(value, fallback) {
  const text = String(value == null ? "" : value).trim();
  return text || fallback;
}

async function readJsonSafe(response) {
  const raw = await response.text();
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function closeConfirmModal(result) {
  if (confirmModal) {
    confirmModal.classList.remove("is-open");
    confirmModal.setAttribute("aria-hidden", "true");
  }
  if (typeof resolver === "function") {
    const current = resolver;
    resolver = null;
    current(Boolean(result));
  }
}

function openConfirmModal(message) {
  if (!confirmModal || !confirmMessage) {
    return Promise.resolve(window.confirm(safeText(message, "Deseja continuar?")));
  }
  if (typeof resolver === "function") {
    resolver(false);
    resolver = null;
  }
  confirmMessage.textContent = safeText(message, "Deseja continuar?");
  confirmModal.classList.add("is-open");
  confirmModal.setAttribute("aria-hidden", "false");
  return new Promise((resolve) => {
    resolver = resolve;
  });
}

async function enforceClientSession() {
  try {
    const response = await fetch("/api/auth/temp/session", {
      method: "GET",
      headers: { "Cache-Control": "no-store" },
    });
    const data = await readJsonSafe(response);
    if (!response.ok || !data?.success) {
      return;
    }
    if (data.temp_auth_enabled && !data.authenticated) {
      const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      window.location.replace(`/login?next=${encodeURIComponent(next)}`);
    }
  } catch {
    return;
  }
}

async function logout() {
  const confirmed = await openConfirmModal("Tem certeza que deseja sair?");
  if (!confirmed) {
    return;
  }
  try {
    await fetch("/api/auth/temp/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  } catch {
    return;
  }
  window.location.replace("/login");
}

function setupConfirmModalHandlers() {
  if (confirmOk) {
    confirmOk.addEventListener("click", () => closeConfirmModal(true));
  }
  if (confirmCancel) {
    confirmCancel.addEventListener("click", () => closeConfirmModal(false));
  }
  if (confirmModal) {
    confirmModal.addEventListener("click", (event) => {
      const target = event.target;
      if (target && target.getAttribute && target.getAttribute("data-modal-close") === "true") {
        closeConfirmModal(false);
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && confirmModal.classList.contains("is-open")) {
        closeConfirmModal(false);
      }
    });
  }
}

window.openConfirmModal = openConfirmModal;
window.closeConfirmModal = closeConfirmModal;

function init() {
  enforceClientSession();
  setupConfirmModalHandlers();
  if (logoutBtn) {
    logoutBtn.addEventListener("click", logout);
  }
}

init();
})();
