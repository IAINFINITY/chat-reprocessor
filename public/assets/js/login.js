(() => {
"use strict";

var STORAGE_THEME = "cw-theme-v3";

var loginToggle = document.getElementById("loginThemeToggle");
var loginToggleIcon = document.getElementById("loginThemeIcon");
var loginLogo = document.getElementById("loginLogo");
var loginForm = document.getElementById("loginForm");
var loginBtn = document.getElementById("loginBtn");
var loginEmail = document.getElementById("loginEmail");
var loginPassword = document.getElementById("loginPassword");
var loginError = document.getElementById("loginError");
var forgotLink = document.getElementById("forgotPasswordLink");
var forgotModal = document.getElementById("forgotModal");
var forgotModalOk = document.getElementById("forgotModalOk");
var toastNotice = document.getElementById("toastNotice");
var togglePasswordBtn = document.getElementById("togglePasswordBtn");
var passwordEyeIcon = document.getElementById("passwordEyeIcon");
var loginBtnDefaultText = loginBtn ? loginBtn.textContent : "Entrar";
var MIN_AUTH_LOADING_MS = 900;
var csrfToken = "";

function getStorage(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function setStorage(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

function safeText(value, fallback) {
  var text = String(value == null ? "" : value).trim();
  return text || fallback || "";
}

function readNextUrl() {
  var params = new URLSearchParams(window.location.search);
  var next = safeText(params.get("next"), "/reprocessador");
  if (!next.startsWith("/") || next.startsWith("/login")) {
    return "/reprocessador";
  }
  return next;
}

function setLogoSrc(isDark) {
  if (!loginLogo) {
    return;
  }
  loginLogo.src = "/logos/iainfinityclarologo.svg";
}

function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  setStorage(STORAGE_THEME, theme);
  var isDark = theme === "dark";
  if (loginToggleIcon) {
    loginToggleIcon.textContent = isDark ? "\u263E" : "\u2600";
  }
  setLogoSrc(isDark);
}

function setError(message) {
  if (!loginError) {
    return;
  }
  loginError.textContent = safeText(message, "");
}

function showToast(message, type) {
  if (!toastNotice) {
    return;
  }

  var kind = safeText(type, "success").toLowerCase();
  toastNotice.innerHTML =
    (kind === "success"
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>') +
    '<span>' + safeText(message, "Operação concluída.") + '</span>';

  toastNotice.classList.remove("is-success", "is-error", "is-visible");
  toastNotice.classList.add(kind === "error" ? "is-error" : "is-success");
  void toastNotice.offsetHeight;
  toastNotice.classList.add("is-visible");

  setTimeout(function () {
    toastNotice.classList.remove("is-visible");
  }, 3200);
}

async function readJsonSafe(response) {
  var raw = await response.text();
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function checkExistingSession() {
  try {
    var response = await fetch("/api/auth/session", {
      method: "GET",
      headers: { "Cache-Control": "no-store" },
    });
    var data = await readJsonSafe(response);
    csrfToken = safeText(data && data.csrf_token, csrfToken);
    if (response.ok && data && data.success && data.authenticated) {
      window.location.replace(readNextUrl());
      return true;
    }
  } catch {}
  return false;
}

function setLoading(enabled) {
  if (!loginBtn) {
    return;
  }
  loginBtn.classList.toggle("loading", enabled === true);
  loginBtn.disabled = enabled === true;
  loginBtn.textContent = enabled === true ? "Autenticando..." : loginBtnDefaultText;
}

async function doLogin(event) {
  if (event && typeof event.preventDefault === "function") {
    event.preventDefault();
  }

  var username = safeText(loginEmail && loginEmail.value, "");
  var password = String(loginPassword && loginPassword.value || "");

  if (!username || !password) {
    if (loginEmail) {
      loginEmail.classList.toggle("is-error", !username);
    }
    if (loginPassword) {
      loginPassword.classList.toggle("is-error", !password);
    }
    setError("Preencha e-mail e senha para acessar.");
    return;
  }

  setError("");
  if (loginEmail) {
    loginEmail.classList.remove("is-error");
  }
  if (loginPassword) {
    loginPassword.classList.remove("is-error");
  }

  if (!csrfToken) {
    await checkExistingSession();
  }

  var startedAt = Date.now();
  var keepLoadingUntilRedirect = false;
  setLoading(true);
  try {
    var response = await fetch("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify({ username: username, password: password }),
    });

    var data = await readJsonSafe(response);
    if (!response.ok || !data || !data.success) {
      var elapsedError = Date.now() - startedAt;
      if (elapsedError < MIN_AUTH_LOADING_MS) {
        await new Promise(function (resolve) {
          setTimeout(resolve, MIN_AUTH_LOADING_MS - elapsedError);
        });
      }
      setError(safeText(data && data.message, "Falha no login. Verifique e-mail e senha."));
      showToast("Falha ao autenticar.", "error");
      return;
    }

    var elapsedSuccess = Date.now() - startedAt;
    if (elapsedSuccess < MIN_AUTH_LOADING_MS) {
      await new Promise(function (resolve) {
        setTimeout(resolve, MIN_AUTH_LOADING_MS - elapsedSuccess);
      });
    }

    keepLoadingUntilRedirect = true;
    showToast("Acesso liberado.", "success");
    window.location.replace(readNextUrl());
  } catch (error) {
    var elapsedCatch = Date.now() - startedAt;
    if (elapsedCatch < MIN_AUTH_LOADING_MS) {
      await new Promise(function (resolve) {
        setTimeout(resolve, MIN_AUTH_LOADING_MS - elapsedCatch);
      });
    }
    setError("Erro de rede ao autenticar.");
    showToast("Erro de rede: " + safeText(error && error.message, "erro"), "error");
  } finally {
    if (!keepLoadingUntilRedirect) {
      setLoading(false);
    }
  }
}

function closeForgotModal() {
  if (!forgotModal) {
    return;
  }
  forgotModal.classList.remove("is-open");
  forgotModal.setAttribute("aria-hidden", "true");
}

function openForgotModal(event) {
  if (event && typeof event.preventDefault === "function") {
    event.preventDefault();
  }
  if (!forgotModal) {
    return;
  }
  forgotModal.classList.add("is-open");
  forgotModal.setAttribute("aria-hidden", "false");
}

function initTheme() {
  var saved = getStorage(STORAGE_THEME);
  setTheme(saved === "light" ? "light" : "dark");

  if (loginToggle) {
    loginToggle.addEventListener("click", function () {
      var current = document.documentElement.getAttribute("data-theme");
      var next = current === "dark" ? "light" : "dark";
      document.body.classList.add("theme-flash");
      setTheme(next);
      setTimeout(function () {
        document.body.classList.remove("theme-flash");
      }, 280);
    });
  }
}

function initLoginForm() {
  if (loginForm) {
    loginForm.addEventListener("submit", doLogin);
  }

  [loginEmail, loginPassword].forEach(function (node) {
    if (!node) {
      return;
    }
    node.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        doLogin(event);
      }
    });
    node.addEventListener("input", function () {
      node.classList.remove("is-error");
      setError("");
    });
  });

  if (forgotLink) {
    forgotLink.addEventListener("click", openForgotModal);
  }
  if (forgotModalOk) {
    forgotModalOk.addEventListener("click", closeForgotModal);
  }
  if (forgotModal) {
    forgotModal.querySelectorAll("[data-modal-close]").forEach(function (node) {
      node.addEventListener("click", closeForgotModal);
    });
    forgotModal.addEventListener("click", function (event) {
      if (event.target === forgotModal) {
        closeForgotModal();
      }
    });
  }

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && forgotModal && forgotModal.classList.contains("is-open")) {
      closeForgotModal();
    }
  });

  if (togglePasswordBtn && loginPassword) {
      togglePasswordBtn.addEventListener("click", function () {
      var isHidden = loginPassword.type === "password";
      loginPassword.type = isHidden ? "text" : "password";
      togglePasswordBtn.setAttribute("aria-pressed", isHidden ? "true" : "false");
      togglePasswordBtn.setAttribute("aria-label", isHidden ? "Ocultar senha" : "Mostrar senha");
      if (passwordEyeIcon) {
        passwordEyeIcon.innerHTML = isHidden
          ? '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"></path><circle cx="12" cy="12" r="3"></circle>'
          : '<path d="M17.94 17.94A10.94 10.94 0 0 1 12 19C5 19 1 12 1 12a21.77 21.77 0 0 1 5.06-6.94M9.9 4.24A10.93 10.93 0 0 1 12 5c7 0 11 7 11 7a21.74 21.74 0 0 1-3.06 4.44M1 1l22 22"></path>';
      }
    });
  }
}

(async function init() {
  var loginPage = document.querySelector(".login-page");
  if (loginPage) {
    loginPage.classList.add("auth-checking");
  }

  initTheme();
  initLoginForm();
  var redirected = await checkExistingSession();
  if (!redirected && loginPage) {
    loginPage.classList.remove("auth-checking");
  }
})();

})();
