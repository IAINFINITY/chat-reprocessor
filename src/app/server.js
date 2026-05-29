import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createChatwootClient } from "../clients/chatwootClient.js";
import { assertRequiredConfig, getConfig, loadEnvFile } from "../config/config.js";
import { resolveConversationIdentity } from "../domain/idParser.js";
import {
  buildReprocessPreview,
  executeReprocessWebhook,
  previewPauseStatus,
  removePauseStatus,
  ReprocessApiError,
  testWebhookConnection,
} from "../api/reprocessApi.js";
import {
  configureN8nEventStore,
  getLatestN8nExecutionEvent,
  getLatestN8nErrorEvent,
  listRecentN8nEvents,
  getLatestN8nStatusEvent,
  registerN8nExecutionEvent,
  registerN8nErrorEvent,
  registerN8nStatusEvent,
  registerWebhookDispatchEvent,
} from "../stores/n8nErrorStore.js";
import {
  configureAuthAuditStore,
  getAuthAuditStats,
  listAuthAuditEvents,
  registerAuthAuditEvent,
} from "../stores/authAuditStore.js";
import { getReprocessClient, listReprocessClients } from "../domain/reprocessClients.js";
import { reprocessConversation } from "../api/reprocessConversation.js";
import { listSupabaseExposedTables } from "../clients/supabaseClient.js";
import { createSupabaseAdminClient } from "../clients/supabaseClient.js";
import { findWebhookMappingByAccountName } from "../domain/webhookResolver.js";
import { inspectPauseConfigForClient } from "../services/pauseChecker.js";
import {
  reconcileExecutionFromN8n,
  scheduleExecutionReconciliation,
} from "../services/n8nExecutionTracker.js";
import {
  readCompaniesConfig,
  writeCompaniesConfig,
} from "../services/companyConfigStore.js";

loadEnvFile();

const config = getConfig();
assertRequiredConfig(config);
configureN8nEventStore({
  filePath: config.n8nEventStorePath,
  maxEvents: config.n8nEventStoreMaxEvents,
});
configureAuthAuditStore();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDirPath = path.resolve(__dirname, "..", "..", "public");
const indexHtmlPath = path.resolve(publicDirPath, "pages", "index.html");
const loginHtmlPath = path.resolve(publicDirPath, "pages", "login.html");
const reprocessadorHtmlPath = path.resolve(publicDirPath, "pages", "reprocessador.html");
const configuracoesHtmlPath = path.resolve(publicDirPath, "pages", "configuracoes.html");
const STATIC_CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const authFailedAttempts = new Map();
const authCredentialFailedAttempts = new Map();
const authSessionStore = new Map();
const AUTH_WINDOW_MS = 10 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 10;
const AUTH_CREDENTIAL_MAX_ATTEMPTS = 8;
const AUTH_BLOCK_MS = 15 * 60 * 1000;
const AUTH_REVOKED_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;
const AUTH_MIN_FAILURE_RESPONSE_MS = 650;
const AUTH_CSRF_COOKIE_NAME = "ia_auth_csrf";
const AUTH_CSRF_HEADER_NAME = "x-csrf-token";
const AUTH_MEMORY_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const AUTH_ROLE_LEVELS = Object.freeze({
  operator: 10,
  admin: 20,
});

function getClientIp(req) {
  const xForwardedFor = req.headers["x-forwarded-for"];
  if (Array.isArray(xForwardedFor) && xForwardedFor.length > 0) {
    return String(xForwardedFor[0] || "").split(",")[0].trim() || "unknown";
  }

  if (typeof xForwardedFor === "string") {
    return String(xForwardedFor).split(",")[0].trim() || "unknown";
  }

  return String(req.socket?.remoteAddress || "").trim() || "unknown";
}

function normalizeAuthRole(role) {
  const normalized = String(role || "").trim().toLowerCase();
  if (normalized in AUTH_ROLE_LEVELS) {
    return normalized;
  }
  return "operator";
}

function getAuthRoleLevel(role) {
  const normalizedRole = normalizeAuthRole(role);
  return Number(AUTH_ROLE_LEVELS[normalizedRole] || AUTH_ROLE_LEVELS.operator);
}

function hasRequiredAuthRole(currentRole, requiredRole) {
  return getAuthRoleLevel(currentRole) >= getAuthRoleLevel(requiredRole);
}

function getRequestPath(req) {
  return String(req.url || "/").split("?")[0] || "/";
}

function registerAuthAudit(req, payload = {}) {
  try {
    return registerAuthAuditEvent({
      ...payload,
      ip: payload.ip || getClientIp(req),
      user_agent: payload.user_agent || String(req.headers["user-agent"] || "").slice(0, 360),
      request_path: payload.request_path || getRequestPath(req),
      request_method: payload.request_method || String(req.method || "GET").toUpperCase(),
    });
  } catch {
    return null;
  }
}

function safeEquals(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");

  if (a.length !== b.length) {
    return timingSafeEqual(a, a) && false;
  }

  return timingSafeEqual(a, b);
}

function parseCookieHeader(req) {
  const rawCookie = req.headers.cookie;
  const header = Array.isArray(rawCookie) ? rawCookie[0] : rawCookie;
  const result = {};
  const source = String(header || "");

  if (!source) {
    return result;
  }

  const parts = source.split(";");
  for (const part of parts) {
    const [rawName, ...rawValue] = part.split("=");
    const name = String(rawName || "").trim();
    if (!name) {
      continue;
    }
    const value = rawValue.join("=").trim();
    try {
      result[name] = decodeURIComponent(value);
    } catch {
      result[name] = value;
    }
  }

  return result;
}

function readHeaderValue(req, name) {
  const raw = req.headers[String(name || "").toLowerCase()];
  if (Array.isArray(raw) && raw.length > 0) {
    return String(raw[0] || "").trim();
  }
  return String(raw || "").trim();
}

function appendSetCookie(res, cookie) {
  const nextCookie = String(cookie || "").trim();
  if (!nextCookie) {
    return;
  }

  const current = res.getHeader("Set-Cookie");
  if (!current) {
    res.setHeader("Set-Cookie", nextCookie);
    return;
  }

  if (Array.isArray(current)) {
    res.setHeader("Set-Cookie", [...current, nextCookie]);
    return;
  }

  res.setHeader("Set-Cookie", [String(current), nextCookie]);
}

function getAuthCsrfCookie(req) {
  const cookies = parseCookieHeader(req);
  return String(cookies[AUTH_CSRF_COOKIE_NAME] || "").trim();
}

function buildAuthCsrfCookie(token, req, { clear = false } = {}) {
  const secure =
    String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https" ||
    Boolean(req.socket?.encrypted);

  const parts = [`${AUTH_CSRF_COOKIE_NAME}=${encodeURIComponent(clear ? "" : token)}`];
  parts.push("Path=/");
  parts.push("SameSite=Lax");
  if (secure) {
    parts.push("Secure");
  }

  if (clear) {
    parts.push("Max-Age=0");
  } else {
    parts.push("Max-Age=28800");
  }

  return parts.join("; ");
}

function ensureAuthCsrfCookie(req, res) {
  const current = getAuthCsrfCookie(req);
  if (current) {
    return current;
  }

  const token = randomBytes(24).toString("hex");
  appendSetCookie(res, buildAuthCsrfCookie(token, req));
  return token;
}

function enforceAuthCsrf(req, res) {
  const cookieToken = getAuthCsrfCookie(req);
  const headerToken = readHeaderValue(req, AUTH_CSRF_HEADER_NAME);

  if (!cookieToken || !headerToken || !safeEquals(cookieToken, headerToken)) {
    json(res, 403, {
      success: false,
      error: "invalid_csrf_token",
      message: "Token CSRF inválido. Recarregue a página e tente novamente.",
    });
    return false;
  }

  return true;
}

async function waitForAuthFailureWindow(startedAtMs) {
  const elapsed = Date.now() - Number(startedAtMs || 0);
  const remaining = AUTH_MIN_FAILURE_RESPONSE_MS - elapsed;
  if (remaining <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, remaining));
}

function getAuthSessionTtlMs(config) {
  const hours = Number(config?.authSessionTtlHours || 8);
  if (!Number.isFinite(hours) || hours <= 0) {
    return 8 * 60 * 60 * 1000;
  }
  return Math.floor(hours * 60 * 60 * 1000);
}

function getAuthCookieName(config) {
  return String(config?.authCookieName || "ia_auth_session").trim() || "ia_auth_session";
}

function buildAuthSessionSecret(config) {
  return String(config?.authSessionSecret || "").trim();
}

function createAuthSessionToken(config, sessionData = {}) {
  const secret = buildAuthSessionSecret(config);
  const now = Date.now();
  const sid = String(sessionData.sid || randomBytes(16).toString("hex")).trim();
  const payload = {
    sid,
    sub: String(sessionData.user_id || sessionData.sub || ""),
    email: String(sessionData.email || ""),
    role: String(sessionData.role || "operator"),
    iat: now,
    exp: now + getAuthSessionTtlMs(config),
    nonce: randomBytes(12).toString("hex"),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");
  return `${encodedPayload}.${signature}`;
}

function verifyAuthSessionToken(token, config) {
  const secret = buildAuthSessionSecret(config);
  if (!secret) {
    return null;
  }

  const parts = String(token || "").split(".");
  if (parts.length !== 2) {
    return null;
  }

  const encodedPayload = parts[0];
  const receivedSignature = parts[1];
  if (!encodedPayload || !receivedSignature) {
    return null;
  }

  const expectedSignature = createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");
  if (!safeEquals(receivedSignature, expectedSignature)) {
    return null;
  }

  let payload = null;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  const exp = Number(payload?.exp || 0);
  const sid = String(payload?.sid || "");
  const sub = String(payload?.sub || "");
  const email = String(payload?.email || "");
  if (!Number.isFinite(exp) || exp <= Date.now()) {
    return null;
  }
  if (!sid || !sub || !email) {
    return null;
  }

  return payload;
}

function buildAuthCookie(token, req, config, { clear = false } = {}) {
  const secure =
    String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https" ||
    Boolean(req.socket?.encrypted);
  const cookieName = getAuthCookieName(config);
  const parts = [`${cookieName}=${encodeURIComponent(clear ? "" : token)}`];
  parts.push("Path=/");
  parts.push("HttpOnly");
  parts.push("SameSite=Lax");
  if (secure) {
    parts.push("Secure");
  }
  if (clear) {
    parts.push("Max-Age=0");
  } else {
    parts.push(`Max-Age=${Math.floor(getAuthSessionTtlMs(config) / 1000)}`);
  }
  return parts.join("; ");
}

function isAuthPublicPath(pathname) {
  if (pathname === "/login" || pathname === "/health") {
    return true;
  }

  if (
    pathname === "/api/auth/login" ||
    pathname === "/api/auth/session" ||
    pathname === "/api/auth/logout" ||
    pathname === "/api/auth/health"
  ) {
    return true;
  }

  if (
    pathname === "/api/reprocess/n8n/error-callback" ||
    pathname === "/api/reprocess/n8n/status-callback"
  ) {
    return true;
  }

  if (
    pathname.startsWith("/assets/") ||
    pathname.startsWith("/logos/") ||
    pathname === "/favicon.ico"
  ) {
    return true;
  }

  return false;
}

async function authenticateSupabasePassword(config, email, password) {
  const supabaseUrl = String(config?.supabaseUrl || "").trim().replace(/\/+$/, "");
  const anonKey = String(config?.supabaseAnonKey || "").trim();

  const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: anonKey,
    },
    body: JSON.stringify({
      email,
      password,
    }),
  });

  const raw = await response.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = {};
  }

  if (!response.ok) {
    return {
      ok: false,
      statusCode: response.status,
      message: String(data?.msg || data?.error_description || data?.error || "Falha de autenticação no Supabase."),
    };
  }

  return {
    ok: true,
    user: data?.user || null,
  };
}

async function checkUserAllowed(config, email) {
  const adminClient = createSupabaseAdminClient(config);
  if (!adminClient) {
    return {
      allowed: false,
      reason: "supabase_not_configured",
    };
  }

  const table = String(config?.authAllowedUsersTable || "REPROCESSAMENTO - allowed_users").trim();
  const emailColumn = String(config?.authAllowedUsersEmailColumn || "email").trim();
  const activeColumn = String(config?.authAllowedUsersActiveColumn || "active").trim();

  const { data, error } = await adminClient
    .from(table)
    .select(`${emailColumn},${activeColumn},role`)
    .eq(emailColumn, email)
    .limit(1)
    .maybeSingle();

  if (error) {
    return {
      allowed: false,
      reason: "allowlist_lookup_failed",
      message: error.message || "Falha ao validar allowlist.",
    };
  }

  if (!data) {
    return {
      allowed: false,
      reason: "user_not_in_allowlist",
    };
  }

  const active = Boolean(data?.[activeColumn] === true || String(data?.[activeColumn] || "").toLowerCase() === "true");
  if (!active) {
    return {
      allowed: false,
      reason: "user_inactive",
    };
  }

  return {
    allowed: true,
    role: String(data?.role || "operator"),
  };
}

function isHtmlNavigationRequest(req) {
  const accept = String(req.headers.accept || "");
  return accept.includes("text/html");
}

function cleanExpiredAuthSessions(now = Date.now()) {
  for (const [sid, session] of authSessionStore.entries()) {
    if (!session || typeof session !== "object") {
      authSessionStore.delete(sid);
      continue;
    }

    const expiresAtMs = Number(session.expiresAtMs || 0);
    const revokedAtMs = Number(session.revokedAtMs || 0);
    if (expiresAtMs > 0 && expiresAtMs <= now) {
      authSessionStore.delete(sid);
      continue;
    }

    if (revokedAtMs > 0 && now - revokedAtMs > AUTH_REVOKED_SESSION_RETENTION_MS) {
      authSessionStore.delete(sid);
    }
  }
}

function getRequestProtocol(req) {
  const rawProto = req.headers["x-forwarded-proto"];
  if (Array.isArray(rawProto) && rawProto.length > 0) {
    return String(rawProto[0] || "http").split(",")[0].trim().toLowerCase() || "http";
  }
  if (typeof rawProto === "string") {
    return String(rawProto).split(",")[0].trim().toLowerCase() || "http";
  }
  return req.socket?.encrypted ? "https" : "http";
}

function getRequestHost(req) {
  const rawForwardedHost = req.headers["x-forwarded-host"];
  if (Array.isArray(rawForwardedHost) && rawForwardedHost.length > 0) {
    return String(rawForwardedHost[0] || "").split(",")[0].trim();
  }
  if (typeof rawForwardedHost === "string" && rawForwardedHost.trim()) {
    return String(rawForwardedHost).split(",")[0].trim();
  }
  const rawHost = req.headers.host;
  if (Array.isArray(rawHost) && rawHost.length > 0) {
    return String(rawHost[0] || "").trim();
  }
  return String(rawHost || "").trim();
}

function getExpectedRequestOrigin(req) {
  const host = getRequestHost(req);
  const protocol = getRequestProtocol(req);
  if (!host) {
    return "";
  }
  return `${protocol}://${host}`.toLowerCase();
}

function extractOriginFromUrlish(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  try {
    return new URL(raw).origin.toLowerCase();
  } catch {
    return "";
  }
}

function resolveRequestSourceOrigin(req) {
  const rawOrigin = req.headers.origin;
  const originHeader = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
  const parsedOrigin = extractOriginFromUrlish(originHeader);
  if (parsedOrigin) {
    return parsedOrigin;
  }

  const rawReferer = req.headers.referer;
  const refererHeader = Array.isArray(rawReferer) ? rawReferer[0] : rawReferer;
  return extractOriginFromUrlish(refererHeader);
}

function validateRequestOrigin(req) {
  const expectedOrigin = getExpectedRequestOrigin(req);
  const sourceOrigin = resolveRequestSourceOrigin(req);

  if (!expectedOrigin || !sourceOrigin) {
    return {
      ok: false,
      code: "origin_missing",
      message: "Origin/Referer ausente na requisição.",
    };
  }

  if (!safeEquals(sourceOrigin, expectedOrigin)) {
    return {
      ok: false,
      code: "origin_mismatch",
      message: "Origin/Referer inválido para este host.",
      details: {
        expected: expectedOrigin,
        received: sourceOrigin,
      },
    };
  }

  return { ok: true };
}

function enforceAuthOrigin(req, res) {
  const validation = validateRequestOrigin(req);
  if (validation.ok) {
    return true;
  }

  const payload = {
    success: false,
    error: "invalid_request_origin",
    message: "Origem da requisição não autorizada.",
    details: {
      reason: validation.code,
    },
  };

  if (validation.details) {
    payload.details = {
      ...payload.details,
      ...validation.details,
    };
  }

  json(res, 403, payload);
  return false;
}

function getAuthSessionRecord(sid) {
  const safeSid = String(sid || "").trim();
  if (!safeSid) {
    return null;
  }

  cleanExpiredAuthSessions();
  const record = authSessionStore.get(safeSid);
  if (!record) {
    return null;
  }

  if (Number(record.revokedAtMs || 0) > 0) {
    return null;
  }

  if (Number(record.expiresAtMs || 0) <= Date.now()) {
    authSessionStore.delete(safeSid);
    return null;
  }

  return record;
}

function registerAuthSession(req, payload) {
  const sid = String(payload?.sid || "").trim();
  if (!sid) {
    return;
  }

  authSessionStore.set(sid, {
    sid,
    sub: String(payload?.sub || ""),
    email: String(payload?.email || "").toLowerCase(),
    role: String(payload?.role || "operator"),
    issuedAtMs: Number(payload?.iat || Date.now()),
    expiresAtMs: Number(payload?.exp || 0),
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    revokedAtMs: 0,
    ip: getClientIp(req),
    userAgent: String(req.headers["user-agent"] || "").slice(0, 512),
  });
}

function revokeAuthSession(sid) {
  const safeSid = String(sid || "").trim();
  if (!safeSid) {
    return;
  }

  const existing = authSessionStore.get(safeSid);
  if (!existing) {
    return;
  }

  authSessionStore.set(safeSid, {
    ...existing,
    revokedAtMs: Date.now(),
    updatedAtMs: Date.now(),
  });
}

function revokeSessionsByEmail(email) {
  const targetEmail = String(email || "").trim().toLowerCase();
  if (!targetEmail) {
    return;
  }

  cleanExpiredAuthSessions();
  for (const [sid, session] of authSessionStore.entries()) {
    if (!session || typeof session !== "object") {
      continue;
    }
    if (String(session.email || "").toLowerCase() !== targetEmail) {
      continue;
    }
    authSessionStore.set(sid, {
      ...session,
      revokedAtMs: Date.now(),
      updatedAtMs: Date.now(),
    });
  }
}

function resolveAuthSessionPayloadFromRequest(req, config) {
  const cookies = parseCookieHeader(req);
  const cookieName = getAuthCookieName(config);
  const token = String(cookies[cookieName] || "").trim();
  if (!token) {
    return null;
  }
  return verifyAuthSessionToken(token, config);
}

function readAuthSessionFromRequest(req, config) {
  const payload = resolveAuthSessionPayloadFromRequest(req, config);
  if (!payload) {
    return null;
  }

  const sid = String(payload?.sid || "").trim();
  const record = getAuthSessionRecord(sid);
  if (!record) {
    return null;
  }

  if (
    !safeEquals(String(record.sub || ""), String(payload.sub || "")) ||
    !safeEquals(String(record.email || "").toLowerCase(), String(payload.email || "").toLowerCase())
  ) {
    return null;
  }

  authSessionStore.set(sid, {
    ...record,
    updatedAtMs: Date.now(),
  });

  return payload;
}

function getAttemptEntry(store, key) {
  const now = Date.now();
  const safeKey = String(key || "").trim();
  if (!safeKey) {
    return null;
  }

  const cached = store.get(safeKey);
  if (!cached) {
    return null;
  }

  if (cached.blockedUntilMs && cached.blockedUntilMs > now) {
    return cached;
  }

  if (cached.windowStartedAtMs + cached.windowMs <= now) {
    store.delete(safeKey);
    return null;
  }

  return cached;
}

function cleanExpiredAttemptStore(store, now = Date.now()) {
  for (const [key, entry] of store.entries()) {
    if (!entry || typeof entry !== "object") {
      store.delete(key);
      continue;
    }

    const blockedUntilMs = Number(entry.blockedUntilMs || 0);
    const windowStartedAtMs = Number(entry.windowStartedAtMs || 0);
    const windowMs = Number(entry.windowMs || AUTH_WINDOW_MS);
    const windowExpired = windowStartedAtMs > 0 && windowStartedAtMs + windowMs <= now;
    const blockExpired = blockedUntilMs > 0 && blockedUntilMs <= now;

    if (windowExpired && (blockedUntilMs <= 0 || blockExpired)) {
      store.delete(key);
    }
  }
}

function registerFailure(store, key, maxAttempts = AUTH_MAX_ATTEMPTS) {
  const now = Date.now();
  const safeKey = String(key || "").trim();
  if (!safeKey) {
    return null;
  }

  const existing = getAttemptEntry(store, safeKey);

  const entry = existing
    ? {
        ...existing,
        attempts: Number(existing.attempts || 0) + 1,
      }
    : {
        attempts: 1,
        windowStartedAtMs: now,
        windowMs: AUTH_WINDOW_MS,
        blockedUntilMs: 0,
      };

  if (entry.attempts >= maxAttempts) {
    entry.blockedUntilMs = now + AUTH_BLOCK_MS;
  }

  store.set(safeKey, entry);
  return entry;
}

function clearFailure(store, key) {
  const safeKey = String(key || "").trim();
  if (!safeKey) {
    return;
  }
  store.delete(safeKey);
}

function normalizeCredentialKey(username) {
  return String(username || "").trim().toLowerCase();
}

function getAuthAttemptEntry(clientIp) {
  return getAttemptEntry(authFailedAttempts, clientIp);
}

function getAuthCredentialAttemptEntry(username) {
  return getAttemptEntry(authCredentialFailedAttempts, normalizeCredentialKey(username));
}

function registerAuthFailure(clientIp) {
  return registerFailure(authFailedAttempts, clientIp, AUTH_MAX_ATTEMPTS);
}

function registerAuthCredentialFailure(username) {
  return registerFailure(
    authCredentialFailedAttempts,
    normalizeCredentialKey(username),
    AUTH_CREDENTIAL_MAX_ATTEMPTS,
  );
}

function clearAuthFailures(clientIp) {
  clearFailure(authFailedAttempts, clientIp);
}

function clearAuthCredentialFailures(username) {
  clearFailure(authCredentialFailedAttempts, normalizeCredentialKey(username));
}

function getAuthRuntimeStats() {
  cleanExpiredAuthSessions();
  cleanExpiredAttemptStore(authFailedAttempts);
  cleanExpiredAttemptStore(authCredentialFailedAttempts);

  let activeSessions = 0;
  let revokedSessions = 0;
  for (const session of authSessionStore.values()) {
    if (!session || typeof session !== "object") {
      continue;
    }
    if (Number(session.revokedAtMs || 0) > 0) {
      revokedSessions += 1;
    } else {
      activeSessions += 1;
    }
  }

  return {
    active_sessions: activeSessions,
    revoked_sessions: revokedSessions,
    tracked_ip_limits: authFailedAttempts.size,
    tracked_credential_limits: authCredentialFailedAttempts.size,
  };
}

setInterval(() => {
  cleanExpiredAuthSessions();
  cleanExpiredAttemptStore(authFailedAttempts);
  cleanExpiredAttemptStore(authCredentialFailedAttempts);
}, AUTH_MEMORY_CLEANUP_INTERVAL_MS).unref();

function writeAuthUnauthorizedJson(res, statusCode, message) {
  const payload = JSON.stringify(
    {
      success: false,
      error: "auth_required",
      message,
    },
    null,
    2,
  );

  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function writeAuthForbiddenRoleJson(res, requiredRole) {
  return json(res, 403, {
    success: false,
    error: "insufficient_role",
    message: "Você não possui permissão para esta ação.",
    required_role: normalizeAuthRole(requiredRole),
  });
}

function enforceRouteRole(req, res, config, requiredRole) {
  if (!config?.authEnabled) {
    return { ok: true, session: null };
  }

  const session = readAuthSessionFromRequest(req, config);
  if (!session) {
    writeAuthUnauthorizedJson(res, 401, "Autenticação obrigatória para acessar este recurso.");
    return { ok: false, session: null };
  }

  const role = normalizeAuthRole(session.role);
  const targetRole = normalizeAuthRole(requiredRole);
  if (!hasRequiredAuthRole(role, targetRole)) {
    registerAuthAudit(req, {
      event_type: "authorization",
      outcome: "denied",
      reason: "insufficient_role",
      email: String(session.email || "").toLowerCase(),
      role,
      session_id: String(session.sid || ""),
      details: {
        required_role: targetRole,
      },
    });
    writeAuthForbiddenRoleJson(res, targetRole);
    return { ok: false, session };
  }

  return { ok: true, session };
}

function enforceFixedAuth(req, res, requestUrl, config) {
  const pathname = requestUrl.pathname;
  if (isAuthPublicPath(pathname)) {
    return true;
  }

  if (!config?.authSessionSecret || !config?.supabaseUrl || !config?.supabaseAnonKey || !config?.supabaseServiceRoleKey) {
    json(res, 500, {
      success: false,
      error: "auth_misconfigured",
      message: "AUTH_ENABLED=true, mas variáveis de autenticação não foram definidas corretamente.",
    });
    return false;
  }

  const clientIp = getClientIp(req);
  const sessionPayload = readAuthSessionFromRequest(req, config);
  if (sessionPayload) {
    clearAuthFailures(clientIp);
    return true;
  }

  if (isHtmlNavigationRequest(req)) {
    const next = `${requestUrl.pathname}${requestUrl.search || ""}${requestUrl.hash || ""}`;
    const location = `/login?next=${encodeURIComponent(next || "/reprocessador")}`;
    res.writeHead(302, {
      Location: location,
      "Cache-Control": "no-store",
    });
    res.end();
    return false;
  }

  writeAuthUnauthorizedJson(res, 401, "Autenticação obrigatória para acessar este ambiente.");
  return false;
}

function enforceAuth(req, res, requestUrl, config) {
  if (!config?.authEnabled) {
    return true;
  }
  return enforceFixedAuth(req, res, requestUrl, config);
}

function toApiErrorResponse(error) {
  if (error instanceof ReprocessApiError) {
    return {
      statusCode: error.statusCode || 400,
      body: {
        success: false,
        error: error.code,
        message: error.message,
        details: error.details || null,
      },
    };
  }

  if (error?.statusCode && Number.isInteger(error.statusCode)) {
    return {
      statusCode: error.statusCode,
      body: {
        success: false,
        error: "request_error",
        message: error?.message || "Erro de requisicao.",
      },
    };
  }

  return {
    statusCode: 500,
    body: {
      success: false,
      error: "internal_error",
      message: error?.message || "Erro interno nao identificado.",
    },
  };
}

function json(res, statusCode, body) {
  const payload = JSON.stringify(body, null, 2);

  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });

  res.end(payload);
}

function html(res, statusCode, content) {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(content),
  });

  res.end(content);
}

function getStaticContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return STATIC_CONTENT_TYPES[extension] || "application/octet-stream";
}

function tryServeStaticAsset(req, res, pathname) {
  if (req.method !== "GET" || pathname === "/") {
    return false;
  }

  let decodedPathname = pathname;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    return false;
  }

  const relativePath = decodedPathname.replace(/^\/+/, "");
  if (!relativePath || relativePath.includes("\0")) {
    return false;
  }

  const absolutePath = path.resolve(publicDirPath, relativePath);
  const publicPrefix = `${publicDirPath}${path.sep}`;
  if (!absolutePath.startsWith(publicPrefix)) {
    return false;
  }

  if (!existsSync(absolutePath)) {
    return false;
  }

  let stats;
  try {
    stats = statSync(absolutePath);
  } catch {
    return false;
  }

  if (!stats.isFile()) {
    return false;
  }

  const buffer = readFileSync(absolutePath);
  res.writeHead(200, {
    "Content-Type": getStaticContentType(absolutePath),
    "Content-Length": buffer.length,
    "Cache-Control": "no-store",
  });
  res.end(buffer);
  return true;
}

function getRequestUrl(req) {
  const host = req.headers.host || "localhost";
  const rawPath = req.url || "/";
  return new URL(rawPath, `http://${host}`);
}

function resolveSafeNextPath(rawNext) {
  const next = String(rawNext || "").trim();
  if (!next) {
    return "/reprocessador";
  }

  if (!next.startsWith("/") || next.startsWith("//")) {
    return "/reprocessador";
  }

  if (next.startsWith("/login")) {
    return "/reprocessador";
  }

  return next;
}

function isAuthSessionRoute(req, pathname) {
  return req.method === "GET" && pathname === "/api/auth/session";
}

function isAuthLoginRoute(req, pathname) {
  return req.method === "POST" && pathname === "/api/auth/login";
}

function isAuthLogoutRoute(req, pathname) {
  return req.method === "POST" && pathname === "/api/auth/logout";
}

async function readJsonBody(req) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    totalBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      const error = new Error("Payload JSON excede o limite de 1MB.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");

  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("Body JSON invalido.");
    error.statusCode = 400;
    throw error;
  }
}

function extractConversationIdFromExecuteInput(input) {
  const normalizedPayload = Array.isArray(input?.payload) ? input.payload[0] : input?.payload;
  const webhookBody = normalizedPayload?.body || normalizedPayload || {};
  return String(webhookBody?.conversation_id || webhookBody?.id || "").trim();
}

function enrichApiErrorWithN8nEvent(apiBody, fallback = {}) {
  if (!apiBody || typeof apiBody !== "object") {
    return;
  }

  if (apiBody.details?.n8n_event) {
    return;
  }

  const details = apiBody.details || {};
  const requestId = String(details.request_id || fallback.requestId || "").trim();
  const client = String(details.client || fallback.client || "").trim().toLowerCase();
  const conversationId = String(fallback.conversationId || "").trim();

  if (!requestId && !client && !conversationId) {
    return;
  }

  const event = getLatestN8nErrorEvent({
    requestId,
    client,
    conversationId,
  });

  if (!event) {
    return;
  }

  apiBody.details = {
    ...details,
    n8n_event: event,
  };
}

function validateN8nCallbackSecret(req, config) {
  const expectedSecret = String(config.n8nErrorCallbackSecret || "").trim();
  if (!expectedSecret) {
    return true;
  }

  const headerName = String(config.n8nErrorCallbackHeader || "x-n8n-error-secret")
    .trim()
    .toLowerCase();
  const rawValue = req.headers[headerName];
  const receivedSecret = Array.isArray(rawValue) ? rawValue[0] : rawValue;

  return String(receivedSecret || "").trim() === expectedSecret;
}

function isStaleRunningExecutionEvent(event, maxAgeMs = 45000) {
  if (!event || String(event?.event_type || "") !== "execution") {
    return false;
  }

  const status = String(event?.status || "").trim().toLowerCase();
  if (status !== "running" && status !== "new" && status !== "waiting") {
    return false;
  }

  const ts = Date.parse(String(event?.received_at || ""));
  if (!Number.isFinite(ts)) {
    return false;
  }

  return Date.now() - ts > maxAgeMs;
}

function normalizeChatPreviewContent(message) {
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

function extractMessageAttachments(message) {
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

function resolveAttachmentSourceUrl(attachment, baseUrl) {
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

function guessAttachmentMimeType(attachment) {
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

function normalizeConversationMessagesForPreview(messagesResponse, options = {}) {
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
      content: normalizeChatPreviewContent(message),
      created_at: createdAtSec || null,
      created_at_iso: createdAtSec
        ? new Date(createdAtSec * 1000).toISOString()
        : null,
    };
  });
}

function mapProfileAccounts(profile) {
  const accounts = Array.isArray(profile?.accounts) ? profile.accounts : [];

  return accounts.map((account) => {
    const accountId = Number(account?.id || 0);
    const accountName = account?.name || `Conta ${accountId}`;
    const mapping = findWebhookMappingByAccountName(accountName);

    return {
      account_id: accountId,
      nome: accountName,
      role: account?.role || null,
      webhook_configurado: Boolean(mapping),
      empresa_mapeada: mapping?.nome || null,
    };
  });
}

const server = createServer(async (req, res) => {
  const requestUrl = getRequestUrl(req);
  const pathname = requestUrl.pathname;

  if (!enforceAuth(req, res, requestUrl, config)) {
    return;
  }

  if (tryServeStaticAsset(req, res, pathname)) {
    return;
  }

  if (req.method === "GET" && pathname === "/login") {
    ensureAuthCsrfCookie(req, res);
    const hasSession = Boolean(readAuthSessionFromRequest(req, config));
    if (hasSession) {
      const nextPath = resolveSafeNextPath(requestUrl.searchParams.get("next"));
      res.writeHead(302, {
        Location: nextPath,
        "Cache-Control": "no-store",
      });
      res.end();
      return;
    }

    try {
      const content = readFileSync(loginHtmlPath, "utf8");
      return html(res, 200, content);
    } catch {
      return json(res, 500, {
        error: "login_unavailable",
        message: "Nao foi possivel carregar public/pages/login.html",
      });
    }
  }

  if (isAuthSessionRoute(req, pathname)) {
    const csrfToken = ensureAuthCsrfCookie(req, res);
    let authSession = readAuthSessionFromRequest(req, config);

    if (config.authEnabled && authSession?.email) {
      const allowResult = await checkUserAllowed(
        config,
        String(authSession.email || "").trim().toLowerCase(),
      );

      if (!allowResult.allowed) {
        if (allowResult.reason === "allowlist_lookup_failed") {
        return json(res, 200, {
          success: true,
          auth_enabled: true,
          auth_mode: "fixed",
          authenticated: true,
            session: {
              email: String(authSession.email || ""),
            role: String(authSession.role || "operator"),
            exp: Number(authSession.exp || 0),
          },
          warning: "allowlist_check_temporarily_unavailable",
          csrf_token: csrfToken,
        });
      }

        if (authSession?.sid) {
          revokeAuthSession(authSession.sid);
        }
        registerAuthAudit(req, {
          event_type: "session_revoked",
          outcome: "success",
          reason: "allowlist_revoked",
          email: String(authSession?.email || "").toLowerCase(),
          role: normalizeAuthRole(authSession?.role),
          session_id: String(authSession?.sid || ""),
        });
        res.setHeader("Set-Cookie", buildAuthCookie("", req, config, { clear: true }));
        return json(res, 200, {
          success: true,
          auth_enabled: true,
          auth_mode: "fixed",
          authenticated: false,
          session: null,
          reason: "allowlist_revoked",
          csrf_token: csrfToken,
        });
      }

      const resolvedRole = String(allowResult.role || "operator");
      if (resolvedRole && resolvedRole !== String(authSession.role || "")) {
        if (authSession?.sid) {
          revokeAuthSession(authSession.sid);
        }

        const rotatedToken = createAuthSessionToken(config, {
          user_id: String(authSession.sub || "").trim(),
          email: String(authSession.email || "").trim().toLowerCase(),
          role: resolvedRole,
        });
        const rotatedPayload = verifyAuthSessionToken(rotatedToken, config);
        if (rotatedPayload) {
          registerAuthSession(req, rotatedPayload);
          res.setHeader("Set-Cookie", buildAuthCookie(rotatedToken, req, config));
          registerAuthAudit(req, {
            event_type: "session_rotated",
            outcome: "success",
            reason: "role_updated_from_allowlist",
            email: String(rotatedPayload?.email || "").toLowerCase(),
            role: normalizeAuthRole(rotatedPayload?.role),
            session_id: String(rotatedPayload?.sid || ""),
          });
          authSession = rotatedPayload;
        }
      }
    }

    const authenticated = config.authEnabled ? Boolean(authSession) : true;
    return json(res, 200, {
      success: true,
      auth_enabled: Boolean(config.authEnabled),
      auth_mode: config.authEnabled ? "fixed" : "disabled",
      authenticated,
      csrf_token: csrfToken,
      session: authSession
        ? {
            email: String(authSession.email || ""),
            role: String(authSession.role || "operator"),
            exp: Number(authSession.exp || 0),
          }
        : null,
    });
  }

  if (req.method === "GET" && pathname === "/api/auth/health") {
    const authSession = readAuthSessionFromRequest(req, config);
    const auditStats = getAuthAuditStats();
    return json(res, 200, {
      success: true,
      auth_enabled: Boolean(config.authEnabled),
      auth_mode: config.authEnabled ? "fixed" : "disabled",
      authenticated: Boolean(authSession),
      has_auth_session_secret: Boolean(String(config.authSessionSecret || "").trim()),
      has_supabase_url: Boolean(String(config.supabaseUrl || "").trim()),
      has_supabase_anon_key: Boolean(String(config.supabaseAnonKey || "").trim()),
      has_supabase_service_role_key: Boolean(String(config.supabaseServiceRoleKey || "").trim()),
      allowlist: {
        table: String(config.authAllowedUsersTable || "REPROCESSAMENTO - allowed_users"),
        email_column: String(config.authAllowedUsersEmailColumn || "email"),
        active_column: String(config.authAllowedUsersActiveColumn || "active"),
      },
      signup_control: {
        mode: String(config.authSignupBlockMode || "unknown"),
        evidence_note: String(config.authSignupEvidenceNote || "") || null,
      },
      rate_limit: {
        ip_max_attempts: AUTH_MAX_ATTEMPTS,
        credential_max_attempts: AUTH_CREDENTIAL_MAX_ATTEMPTS,
        block_ms: AUTH_BLOCK_MS,
        window_ms: AUTH_WINDOW_MS,
      },
      audit: auditStats,
      runtime: getAuthRuntimeStats(),
    });
  }

  if (req.method === "GET" && pathname === "/api/auth/audit") {
    const roleCheck = enforceRouteRole(req, res, config, "admin");
    if (!roleCheck.ok) {
      return;
    }

    const limit = Number(requestUrl.searchParams.get("limit") || 50);
    const eventType = requestUrl.searchParams.get("event_type") || "";
    const outcome = requestUrl.searchParams.get("outcome") || "";
    const email = requestUrl.searchParams.get("email") || "";
    const events = listAuthAuditEvents({
      limit,
      eventType,
      outcome,
      email,
    });

    return json(res, 200, {
      success: true,
      total: events.length,
      events,
    });
  }

  if (isAuthLoginRoute(req, pathname)) {
    if (!enforceAuthOrigin(req, res)) {
      return;
    }
    if (!enforceAuthCsrf(req, res)) {
      return;
    }

    const clientIp = getClientIp(req);
    const attemptEntry = getAuthAttemptEntry(clientIp);
    const now = Date.now();
    if (attemptEntry?.blockedUntilMs && attemptEntry.blockedUntilMs > now) {
      registerAuthAudit(req, {
        event_type: "login",
        outcome: "failed",
        reason: "ip_rate_limited",
      });
      return json(res, 429, {
        success: false,
        error: "auth_login_blocked",
        message: "Muitas tentativas de login. Aguarde alguns minutos e tente novamente.",
      });
    }

    const startedAtMs = Date.now();
    try {
      const input = await readJsonBody(req);
      const username = String(input?.username || input?.email || "").trim().toLowerCase();
      const password = String(input?.password || "");
      const credentialAttemptEntry = getAuthCredentialAttemptEntry(username);
      if (credentialAttemptEntry?.blockedUntilMs && credentialAttemptEntry.blockedUntilMs > now) {
        registerAuthAudit(req, {
          event_type: "login",
          outcome: "failed",
          reason: "credential_rate_limited",
          email: username || null,
        });
        return json(res, 429, {
          success: false,
          error: "auth_login_blocked",
          message: "Muitas tentativas de login. Aguarde alguns minutos e tente novamente.",
        });
      }

      if (!username || !password) {
        registerAuthFailure(clientIp);
        registerAuthCredentialFailure(username);
        registerAuthAudit(req, {
          event_type: "login",
          outcome: "failed",
          reason: "missing_credentials",
          email: username || null,
        });
        await waitForAuthFailureWindow(startedAtMs);
        return json(res, 400, {
          success: false,
          error: "invalid_credentials",
          message: "Credenciais inválidas.",
        });
      }

      const authResult = await authenticateSupabasePassword(config, username, password);
      if (!authResult.ok) {
        registerAuthFailure(clientIp);
        registerAuthCredentialFailure(username);
        registerAuthAudit(req, {
          event_type: "login",
          outcome: "failed",
          reason: "invalid_credentials",
          email: username,
        });
        await waitForAuthFailureWindow(startedAtMs);
        return json(res, 401, {
          success: false,
          error: "invalid_credentials",
          message: "Credenciais inválidas.",
        });
      }

      const allowResult = await checkUserAllowed(config, username);
      if (!allowResult.allowed) {
        registerAuthFailure(clientIp);
        registerAuthCredentialFailure(username);
        registerAuthAudit(req, {
          event_type: "login",
          outcome: "failed",
          reason: "allowlist_denied",
          email: username,
          details: {
            allow_reason: String(allowResult.reason || "unknown"),
          },
        });
        await waitForAuthFailureWindow(startedAtMs);
        return json(res, 401, {
          success: false,
          error: "invalid_credentials",
          message: "Credenciais inválidas.",
        });
      }

      clearAuthFailures(clientIp);
      clearAuthCredentialFailures(username);
      revokeSessionsByEmail(username);
      const token = createAuthSessionToken(config, {
        user_id: authResult.user?.id || "",
        email: username,
        role: allowResult.role || "operator",
      });
      const payload = verifyAuthSessionToken(token, config);
      if (!payload) {
        registerAuthAudit(req, {
          event_type: "login",
          outcome: "failed",
          reason: "session_token_issue",
          email: username,
          details: {
            stage: "payload_verification",
          },
        });
        return json(res, 500, {
          success: false,
          error: "auth_session_issue",
          message: "Não foi possível iniciar a sessão.",
        });
      }
      registerAuthSession(req, payload);
      registerAuthAudit(req, {
        event_type: "login",
        outcome: "success",
        reason: "authenticated",
        email: username,
        role: normalizeAuthRole(allowResult.role || "operator"),
        session_id: String(payload.sid || ""),
      });
      const cookie = buildAuthCookie(token, req, config);
      res.setHeader("Set-Cookie", cookie);
      return json(res, 200, {
        success: true,
        message: "Autenticado com sucesso.",
        auth_mode: "fixed",
      });
    } catch (error) {
      await waitForAuthFailureWindow(startedAtMs);
      registerAuthAudit(req, {
        event_type: "login",
        outcome: "failed",
        reason: "internal_error",
      });
      return json(res, 500, {
        success: false,
        error: "auth_login_failed",
        message: "Falha ao processar login.",
      });
    }
  }

  if (isAuthLogoutRoute(req, pathname)) {
    if (!enforceAuthOrigin(req, res)) {
      return;
    }
    if (!enforceAuthCsrf(req, res)) {
      return;
    }
    const sessionPayload = resolveAuthSessionPayloadFromRequest(req, config);
    if (sessionPayload?.sid) {
      revokeAuthSession(sessionPayload.sid);
    }
    registerAuthAudit(req, {
      event_type: "logout",
      outcome: "success",
      reason: "user_logout",
      email: String(sessionPayload?.email || "").toLowerCase() || null,
      role: sessionPayload?.role ? normalizeAuthRole(sessionPayload.role) : null,
      session_id: String(sessionPayload?.sid || ""),
    });
    res.setHeader("Set-Cookie", buildAuthCookie("", req, config, { clear: true }));
    appendSetCookie(res, buildAuthCsrfCookie("", req, { clear: true }));
    return json(res, 200, {
      success: true,
      message: "Sessao encerrada.",
    });
  }

  if (req.method === "GET" && pathname === "/") {
    res.writeHead(302, {
      Location: "/reprocessador",
      "Cache-Control": "no-store",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && pathname === "/reprocessador") {
    try {
      const content = readFileSync(reprocessadorHtmlPath, "utf8");
      return html(res, 200, content);
    } catch {
      return json(res, 500, {
        error: "reprocessador_unavailable",
        message: "Nao foi possivel carregar public/pages/reprocessador.html",
      });
    }
  }

  if (req.method === "GET" && pathname === "/ajuda") {
    try {
      const content = readFileSync(reprocessadorHtmlPath, "utf8");
      return html(res, 200, content);
    } catch {
      return json(res, 500, {
        error: "ajuda_unavailable",
        message: "Nao foi possivel carregar public/pages/reprocessador.html",
      });
    }
  }

  if (req.method === "GET" && pathname === "/configuracoes") {
    try {
      const content = readFileSync(configuracoesHtmlPath, "utf8");
      return html(res, 200, content);
    } catch {
      return json(res, 500, {
        error: "configuracoes_unavailable",
        message: "Nao foi possivel carregar public/pages/configuracoes.html",
      });
    }
  }

  if (req.method === "GET" && pathname === "/empresas") {
    try {
      const client = createChatwootClient({
        baseUrl: config.chatwootBaseUrl,
        apiAccessToken: config.chatwootApiToken,
      });
      const profile = await client.getProfile();

      return json(res, 200, { empresas: mapProfileAccounts(profile) });
    } catch (error) {
      return json(res, 500, {
        error: "empresas_unavailable",
        message: error.message,
      });
    }
  }

  if (req.method === "POST" && pathname === "/conversation-context") {
    try {
      const input = await readJsonBody(req);
      const identity = resolveConversationIdentity(input, config.chatwootBaseUrl);

      const chatwootClient = createChatwootClient({
        baseUrl: identity.baseUrl,
        apiAccessToken: config.chatwootApiToken,
      });

      const [conversation, profile] = await Promise.all([
        chatwootClient.getConversation(identity.accountId, identity.conversationId),
        chatwootClient.getProfile(),
      ]);

      const accountId = Number(identity.accountId);
      const inboxId = Number(conversation?.inbox_id || 0);
      const profileAccounts = mapProfileAccounts(profile);
      const matchedAccount = profileAccounts.find((item) => item.account_id === accountId) || null;

      return json(res, 200, {
        account_id: accountId,
        account_nome: matchedAccount?.nome || null,
        conversation_id: Number(identity.conversationId),
        inbox_id: inboxId,
        status: conversation?.status || null,
        webhook_configurado: Boolean(matchedAccount?.webhook_configurado),
        empresa_mapeada: matchedAccount?.empresa_mapeada || null,
      });
    } catch (error) {
      return json(res, 400, {
        error: "conversation_context_failed",
        message: error.message,
      });
    }
  }

  if (req.method === "GET" && pathname === "/health") {
    return json(res, 200, { ok: true, service: "chatwoot-reprocess-helper" });
  }

  if (req.method === "POST" && pathname === "/api/reprocess/chatwoot/messages") {
    try {
      const input = await readJsonBody(req);
      const conversationUrl = String(input?.conversationUrl || input?.conversation_url || "").trim();
      const limit = Math.max(1, Math.min(Number(input?.limit || 80), 200));

      if (!conversationUrl) {
        return json(res, 400, {
          success: false,
          error: "invalid_link",
          message: "Informe o link da conversa para carregar o preview visual.",
        });
      }

      const identity = resolveConversationIdentity(
        { chat_url: conversationUrl },
        config.chatwootBaseUrl,
      );
      const chatwootClient = createChatwootClient({
        baseUrl: identity.baseUrl,
        apiAccessToken: config.chatwootApiToken,
      });

      const messagesResponse = await chatwootClient.getConversationMessages(
        identity.accountId,
        identity.conversationId,
      );
      const normalized = normalizeConversationMessagesForPreview(messagesResponse, {
        baseUrl: identity.baseUrl,
        conversationUrl,
      });
      const sliced = normalized.slice(Math.max(0, normalized.length - limit));

      return json(res, 200, {
        success: true,
        account_id: identity.accountId,
        conversation_id: identity.conversationId,
        total: normalized.length,
        messages: sliced,
      });
    } catch (error) {
      return json(res, 502, {
        success: false,
        error: "chatwoot_messages_fetch_failed",
        message: error?.message || "Falha ao consultar mensagens no Chatwoot.",
      });
    }
  }

  if (req.method === "GET" && pathname === "/api/reprocess/chatwoot/media") {
    try {
      const conversationUrl = String(requestUrl.searchParams.get("conversationUrl") || "").trim();
      const messageId = Number(requestUrl.searchParams.get("messageId") || 0);
      const attachmentIndex = Number(requestUrl.searchParams.get("attachmentIndex") || 0);

      if (!conversationUrl || !Number.isInteger(messageId) || messageId <= 0) {
        return json(res, 400, {
          success: false,
          error: "invalid_media_request",
          message: "Informe conversationUrl, messageId e attachmentIndex validos.",
        });
      }

      const identity = resolveConversationIdentity(
        { chat_url: conversationUrl },
        config.chatwootBaseUrl,
      );
      const chatwootClient = createChatwootClient({
        baseUrl: identity.baseUrl,
        apiAccessToken: config.chatwootApiToken,
      });
      const messagesResponse = await chatwootClient.getConversationMessages(
        identity.accountId,
        identity.conversationId,
      );
      const payload = Array.isArray(messagesResponse?.payload) ? messagesResponse.payload : [];
      const targetMessage = payload.find((message) => Number(message?.id || 0) === messageId);

      if (!targetMessage) {
        return json(res, 404, {
          success: false,
          error: "media_message_not_found",
          message: "Mensagem de mídia não encontrada na conversa.",
        });
      }

      const attachments = extractMessageAttachments(targetMessage);
      const targetAttachment = attachments[attachmentIndex];
      if (!targetAttachment) {
        return json(res, 404, {
          success: false,
          error: "media_attachment_not_found",
          message: "Anexo não encontrado para esta mensagem.",
        });
      }

      const sourceUrl = resolveAttachmentSourceUrl(targetAttachment, identity.baseUrl);
      if (!sourceUrl) {
        return json(res, 404, {
          success: false,
          error: "media_url_unavailable",
          message: "URL de mídia indisponível no payload do Chatwoot.",
        });
      }

      const upstream = await fetch(sourceUrl, {
        method: "GET",
        headers: {
          api_access_token: config.chatwootApiToken,
        },
      });

      if (!upstream.ok) {
        const errorText = await upstream.text();
        return json(res, 502, {
          success: false,
          error: "media_fetch_failed",
          message: `Falha ao baixar mídia do Chatwoot (${upstream.status}).`,
          details: {
            status_code: upstream.status,
            response_excerpt: String(errorText || "").slice(0, 240),
          },
        });
      }

      const mimeType =
        String(upstream.headers.get("content-type") || "").trim() ||
        guessAttachmentMimeType(targetAttachment);
      const contentLength = String(upstream.headers.get("content-length") || "").trim();
      const buffer = Buffer.from(await upstream.arrayBuffer());

      res.writeHead(200, {
        "Content-Type": mimeType,
        "Content-Length": contentLength || String(buffer.length),
        "Cache-Control": "no-store",
      });
      res.end(buffer);
      return;
    } catch (error) {
      return json(res, 502, {
        success: false,
        error: "chatwoot_media_proxy_failed",
        message: error?.message || "Falha ao carregar mídia via proxy do Chatwoot.",
      });
    }
  }

  if (req.method === "GET" && pathname === "/api/reprocess/clients") {
    try {
      return json(res, 200, {
        success: true,
        clients: listReprocessClients(),
      });
    } catch (error) {
      return json(res, 500, {
        success: false,
        error: "clients_list_failed",
        message: error?.message || "Falha ao carregar lista de clientes.",
      });
    }
  }

  if (req.method === "GET" && pathname === "/api/reprocess/supabase/tables") {
    try {
      const schema = requestUrl.searchParams.get("schema") || "public";
      const includeAll =
        String(requestUrl.searchParams.get("include_all") || "").trim().toLowerCase() === "true";
      const result = await listSupabaseExposedTables(config, schema, {
        tablePrefix: config.supabaseManagedTablePrefix,
        managedOnly: !includeAll,
      });

      if (!result.ok) {
        return json(res, 400, {
          success: false,
          error: result.error,
          message: result.message,
          details: {
            status_code: result.status_code || null,
            response_excerpt: result.response_excerpt || null,
          },
        });
      }

      return json(res, 200, {
        success: true,
        schema: result.schema,
        managed_prefix: result.managed_prefix || null,
        managed_only: Boolean(result.managed_only),
        total_all: Number(result.total_all || result.total || 0),
        managed_total: Number(result.managed_total || 0),
        total: result.total,
        tables: result.tables,
      });
    } catch (error) {
      return json(res, 502, {
        success: false,
        error: "supabase_list_tables_failed",
        message: error?.message || "Falha ao consultar metadados do Supabase.",
      });
    }
  }

  if (req.method === "GET" && pathname === "/api/reprocess/supabase/pause-mappings") {
    try {
      const clientFilter = String(requestUrl.searchParams.get("client") || "")
        .trim()
        .toLowerCase();
      const allClients = listReprocessClients();
      const targetClients = clientFilter
        ? allClients.filter((client) => String(client.key || "").toLowerCase() === clientFilter)
        : allClients;

      if (clientFilter && targetClients.length === 0) {
        return json(res, 404, {
          success: false,
          error: "client_not_found",
          message: `Cliente '${clientFilter}' nao encontrado.`,
        });
      }

      const mappings = await Promise.all(
        targetClients.map(async (clientSummary) => {
          const clientConfig = getReprocessClient(clientSummary.key);
          if (!clientConfig) {
            return {
              client: clientSummary.key,
              name: clientSummary.name,
              pause_table: null,
              source: "unavailable",
              reason: "client_config_not_found",
              pause_schema: "public",
              pause_table_suffix: "pausar",
              pause_lookup_columns: [],
            };
          }

          const inspected = await inspectPauseConfigForClient({
            clientConfig,
            config,
          });
          return inspected;
        }),
      );

      return json(res, 200, {
        success: true,
        total: mappings.length,
        mappings,
      });
    } catch (error) {
      return json(res, 502, {
        success: false,
        error: "supabase_pause_mapping_failed",
        message: error?.message || "Falha ao resolver tabelas de pausa por cliente.",
      });
    }
  }

  if (req.method === "POST" && pathname === "/api/reprocess/preview") {
    try {
      const input = await readJsonBody(req);
      const preview = await buildReprocessPreview({ input, config });
      return json(res, 200, preview);
    } catch (error) {
      const formatted = toApiErrorResponse(error);
      return json(res, formatted.statusCode, formatted.body);
    }
  }

  if (req.method === "POST" && pathname === "/api/reprocess/execute") {
    let input = {};

    try {
      input = await readJsonBody(req);
      const result = await executeReprocessWebhook({ input, config });

      if (result?.success && result?.request_id) {
        const conversationId =
          String(result?.conversation_id || "").trim() ||
          extractConversationIdFromExecuteInput(input);
        const client = String(result?.client || input?.client || "")
          .trim()
          .toLowerCase();
        const requestContext = {
          requestId: String(result.request_id || "").trim(),
          client,
          conversationId,
        };

        registerWebhookDispatchEvent({
          request_id: requestContext.requestId,
          client: requestContext.client,
          conversation_id: requestContext.conversationId,
          httpStatusCode: result?.webhook_http_status || null,
        });

        scheduleExecutionReconciliation({
          config,
          context: requestContext,
          onEvent: (event) => {
            registerN8nExecutionEvent(event);
          },
          onFailure: (error) => {
            registerN8nStatusEvent({
              category: "n8n_execution_lookup_failed",
              title: "Falha ao consultar execucao no n8n",
              likely_cause: error?.message || "Falha nao identificada ao consultar API do n8n.",
              suggestion: "Validar N8N_API_BASE_URL/N8N_API_KEY e disponibilidade da API do n8n.",
              request_id: requestContext.requestId,
              client: requestContext.client,
              conversation_id: requestContext.conversationId || null,
            });
          },
        });
      }

      return json(res, 200, result);
    } catch (error) {
      const formatted = toApiErrorResponse(error);
      enrichApiErrorWithN8nEvent(formatted.body, {
        requestId: String(formatted.body?.details?.request_id || "").trim(),
        client: String(formatted.body?.details?.client || input?.client || "")
          .trim()
          .toLowerCase(),
        conversationId: extractConversationIdFromExecuteInput(input),
      });
      return json(res, formatted.statusCode, formatted.body);
    }
  }

  if (req.method === "POST" && pathname === "/api/reprocess/test-connection") {
    try {
      const input = await readJsonBody(req);
      const result = await testWebhookConnection({ input });
      return json(res, 200, result);
    } catch (error) {
      const formatted = toApiErrorResponse(error);
      return json(res, formatted.statusCode, formatted.body);
    }
  }

  if (req.method === "POST" && pathname === "/api/reprocess/n8n/error-callback") {
    if (!validateN8nCallbackSecret(req, config)) {
      return json(res, 401, {
        success: false,
        error: "unauthorized_n8n_callback",
        message: "Callback n8n sem segredo valido.",
      });
    }

    try {
      const input = await readJsonBody(req);
      const hintedClient = String(requestUrl.searchParams.get("client") || "")
        .trim()
        .toLowerCase();
      const normalizedInput =
        hintedClient && input && typeof input === "object" && !Array.isArray(input)
          ? { ...input, client: input.client || hintedClient }
          : input;
      const event = registerN8nErrorEvent(normalizedInput);

      return json(res, 200, {
        success: true,
        message: "Evento de erro n8n recebido.",
        event,
      });
    } catch (error) {
      return json(res, 400, {
        success: false,
        error: "invalid_n8n_callback_payload",
        message: error?.message || "Payload invalido para callback de erro n8n.",
      });
    }
  }

  if (req.method === "GET" && pathname === "/api/reprocess/n8n/errors/latest") {
    const client = requestUrl.searchParams.get("client") || "";
    const requestId = requestUrl.searchParams.get("request_id") || "";
    const conversationId = requestUrl.searchParams.get("conversation_id") || "";
    const event = getLatestN8nErrorEvent({
      client,
      requestId,
      conversationId,
    });

    return json(res, 200, {
      success: true,
      found: Boolean(event),
      event: event || null,
    });
  }

  if (req.method === "POST" && pathname === "/api/reprocess/n8n/status-callback") {
    if (!validateN8nCallbackSecret(req, config)) {
      return json(res, 401, {
        success: false,
        error: "unauthorized_n8n_callback",
        message: "Callback n8n sem segredo valido.",
      });
    }

    try {
      const input = await readJsonBody(req);
      const hintedClient = String(requestUrl.searchParams.get("client") || "")
        .trim()
        .toLowerCase();
      const normalizedInput =
        hintedClient && input && typeof input === "object" && !Array.isArray(input)
          ? { ...input, client: input.client || hintedClient }
          : input;
      const event = registerN8nStatusEvent(normalizedInput);

      return json(res, 200, {
        success: true,
        message: "Evento de status n8n recebido.",
        event,
      });
    } catch (error) {
      return json(res, 400, {
        success: false,
        error: "invalid_n8n_callback_payload",
        message: error?.message || "Payload invalido para callback de status n8n.",
      });
    }
  }

  if (req.method === "GET" && pathname === "/api/reprocess/n8n/status/latest") {
    const client = requestUrl.searchParams.get("client") || "";
    const requestId = requestUrl.searchParams.get("request_id") || "";
    const conversationId = requestUrl.searchParams.get("conversation_id") || "";
    const event = getLatestN8nStatusEvent({
      client,
      requestId,
      conversationId,
    });

    return json(res, 200, {
      success: true,
      found: Boolean(event),
      event: event || null,
    });
  }

  if (req.method === "GET" && pathname === "/api/config/empresas") {
    const roleCheck = enforceRouteRole(req, res, config, "operator");
    if (!roleCheck.ok) {
      return;
    }

    try {
      const result = readCompaniesConfig();
      return json(res, 200, {
        success: true,
        file_path: result.file_path,
        total: result.empresas.length,
        empresas: result.empresas,
      });
    } catch (error) {
      return json(res, 500, {
        success: false,
        error: "companies_read_failed",
        message: error?.message || "Falha ao ler empresas.json.",
      });
    }
  }

  if (req.method === "PUT" && pathname === "/api/config/empresas") {
    const roleCheck = enforceRouteRole(req, res, config, "admin");
    if (!roleCheck.ok) {
      return;
    }

    try {
      const input = await readJsonBody(req);
      const result = writeCompaniesConfig(input);
      return json(res, 200, {
        success: true,
        message: "Empresas salvas com sucesso.",
        file_path: result.file_path,
        total: result.total,
        empresas: result.empresas,
      });
    } catch (error) {
      return json(res, 400, {
        success: false,
        error: "companies_write_failed",
        message: error?.message || "Falha ao salvar empresas.json.",
      });
    }
  }

  if (req.method === "POST" && pathname === "/api/reprocess/pause-status") {
    try {
      const input = await readJsonBody(req);
      const result = await previewPauseStatus({ input, config });
      return json(res, 200, result);
    } catch (error) {
      const formatted = toApiErrorResponse(error);
      return json(res, formatted.statusCode, formatted.body);
    }
  }

  if (req.method === "POST" && pathname === "/api/reprocess/pause-remove") {
    try {
      const input = await readJsonBody(req);
      const result = await removePauseStatus({ input, config });
      return json(res, 200, result);
    } catch (error) {
      const formatted = toApiErrorResponse(error);
      return json(res, formatted.statusCode, formatted.body);
    }
  }

  if (req.method === "GET" && pathname === "/api/reprocess/n8n/execution/latest") {
    const client = requestUrl.searchParams.get("client") || "";
    const requestId = requestUrl.searchParams.get("request_id") || "";
    const conversationId = requestUrl.searchParams.get("conversation_id") || "";
    const sync = String(requestUrl.searchParams.get("sync") || "").toLowerCase() === "true";

    let event = getLatestN8nExecutionEvent({
      client,
      requestId,
      conversationId,
    });

    if (sync && (requestId || client || conversationId)) {
      let reconciled = null;
      try {
        reconciled = await reconcileExecutionFromN8n({
          config,
          context: {
            requestId,
            client,
            conversationId,
          },
          lookbackLimit: config.n8nExecutionLookbackLimit,
        });

        if (reconciled.ok && reconciled.event) {
          event = registerN8nExecutionEvent(reconciled.event);
        } else if (!event) {
          registerN8nStatusEvent({
            category: "n8n_execution_not_found",
            title: "Execucao ainda nao localizada no n8n",
            likely_cause: "A execucao pode ainda nao ter sido indexada na API do n8n.",
            suggestion: "Tentar novamente em alguns segundos.",
            request_id: requestId || null,
            client: client || null,
            conversation_id: conversationId || null,
          });
        }
      } catch (error) {
        registerN8nStatusEvent({
          category: "n8n_execution_lookup_failed",
          title: "Falha ao consultar execucao no n8n",
          likely_cause: error?.message || "Falha nao identificada ao consultar API do n8n.",
          suggestion: "Validar variaveis de ambiente da API do n8n e tentar novamente.",
          request_id: requestId || null,
          client: client || null,
          conversation_id: conversationId || null,
        });
      }

      if (
        !reconciled?.ok &&
        isStaleRunningExecutionEvent(event)
      ) {
        event = null;
      }
    }

    return json(res, 200, {
      success: true,
      found: Boolean(event),
      event: event || null,
    });
  }

  if (req.method === "GET" && pathname === "/api/reprocess/n8n/events") {
    const client = requestUrl.searchParams.get("client") || "";
    const limit = Number(requestUrl.searchParams.get("limit") || 20);
    const events = listRecentN8nEvents({
      client,
      limit,
    });

    return json(res, 200, {
      success: true,
      total: events.length,
      events,
    });
  }

  if (req.method === "POST" && pathname === "/reprocess") {
    try {
      const input = await readJsonBody(req);
      const output = await reprocessConversation({ input, config });
      return json(res, 200, output);
    } catch (error) {
      return json(res, 400, {
        error: "reprocess_failed",
        message: error.message,
      });
    }
  }

  return json(res, 404, {
    error: "not_found",
      message:
      "Use GET /, GET /login, GET /reprocessador, GET /ajuda, GET /configuracoes, GET /empresas, GET /health, GET /api/auth/health, GET /api/auth/audit, GET /api/auth/session, POST /api/auth/login, POST /api/auth/logout, GET /api/config/empresas, PUT /api/config/empresas, GET /api/reprocess/clients, GET /api/reprocess/supabase/tables, GET /api/reprocess/supabase/pause-mappings, POST /api/reprocess/preview, POST /api/reprocess/execute, POST /api/reprocess/test-connection, POST /api/reprocess/pause-status, POST /api/reprocess/pause-remove, POST /api/reprocess/chatwoot/messages, GET /api/reprocess/chatwoot/media, POST /api/reprocess/n8n/error-callback, GET /api/reprocess/n8n/errors/latest, POST /api/reprocess/n8n/status-callback, GET /api/reprocess/n8n/status/latest, GET /api/reprocess/n8n/execution/latest, GET /api/reprocess/n8n/events, POST /conversation-context ou POST /reprocess",
  });
});

server.listen(config.port, () => {
  console.log(`Chatwoot Reprocess Helper online em http://localhost:${config.port}`);
});

