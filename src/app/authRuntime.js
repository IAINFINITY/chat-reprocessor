import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function createAuthRuntime({
  config,
  json,
  registerAuthAuditEvent,
  createSupabaseAdminClient,
}) {
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
    const enrichedPayload = {
      ...payload,
      ip: payload.ip || getClientIp(req),
      user_agent: payload.user_agent || String(req.headers["user-agent"] || "").slice(0, 360),
      request_path: payload.request_path || getRequestPath(req),
      request_method: payload.request_method || String(req.method || "GET").toUpperCase(),
    };

    registerAuthAuditEvent(enrichedPayload).catch(() => null);
    return null;
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

  function getAuthSessionTtlMs() {
    const hours = Number(config?.authSessionTtlHours || 8);
    if (!Number.isFinite(hours) || hours <= 0) {
      return 8 * 60 * 60 * 1000;
    }
    return Math.floor(hours * 60 * 60 * 1000);
  }

  function getAuthCookieName() {
    return String(config?.authCookieName || "ia_auth_session").trim() || "ia_auth_session";
  }

  function buildAuthSessionSecret() {
    return String(config?.authSessionSecret || "").trim();
  }

  function createAuthSessionToken(sessionData = {}) {
    const secret = buildAuthSessionSecret();
    const now = Date.now();
    const sid = String(sessionData.sid || randomBytes(16).toString("hex")).trim();
    const payload = {
      sid,
      sub: String(sessionData.user_id || sessionData.sub || ""),
      email: String(sessionData.email || ""),
      role: String(sessionData.role || "operator"),
      iat: now,
      exp: now + getAuthSessionTtlMs(),
      nonce: randomBytes(12).toString("hex"),
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", secret)
      .update(encodedPayload)
      .digest("base64url");
    return `${encodedPayload}.${signature}`;
  }

  function verifyAuthSessionToken(token) {
    const secret = buildAuthSessionSecret();
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

  function buildAuthCookie(token, req, { clear = false } = {}) {
    const secure =
      String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https" ||
      Boolean(req.socket?.encrypted);
    const cookieName = getAuthCookieName();
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
      parts.push(`Max-Age=${Math.floor(getAuthSessionTtlMs() / 1000)}`);
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

  async function authenticateSupabasePassword(email, password) {
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

  async function checkUserAllowed(email) {
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

  function resolveAuthSessionPayloadFromRequest(req) {
    const cookies = parseCookieHeader(req);
    const cookieName = getAuthCookieName();
    const token = String(cookies[cookieName] || "").trim();
    if (!token) {
      return null;
    }
    return verifyAuthSessionToken(token);
  }

  function readAuthSessionFromRequest(req) {
    const payload = resolveAuthSessionPayloadFromRequest(req);
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

  function enforceRouteRole(req, res, requiredRole) {
    if (!config?.authEnabled) {
      return { ok: true, session: null };
    }

    const session = readAuthSessionFromRequest(req);
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

  function enforceFixedAuth(req, res, requestUrl) {
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
    const sessionPayload = readAuthSessionFromRequest(req);
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

  function enforceAuth(req, res, requestUrl) {
    if (!config?.authEnabled) {
      return true;
    }
    return enforceFixedAuth(req, res, requestUrl);
  }

  return {
    constants: {
      AUTH_WINDOW_MS,
      AUTH_MAX_ATTEMPTS,
      AUTH_CREDENTIAL_MAX_ATTEMPTS,
      AUTH_BLOCK_MS,
    },
    getClientIp,
    normalizeAuthRole,
    registerAuthAudit,
    ensureAuthCsrfCookie,
    enforceAuthCsrf,
    waitForAuthFailureWindow,
    createAuthSessionToken,
    verifyAuthSessionToken,
    buildAuthCookie,
    buildAuthCsrfCookie,
    authenticateSupabasePassword,
    checkUserAllowed,
    getAuthRuntimeStats,
    enforceAuthOrigin,
    resolveAuthSessionPayloadFromRequest,
    readAuthSessionFromRequest,
    getAuthAttemptEntry,
    getAuthCredentialAttemptEntry,
    registerAuthFailure,
    registerAuthCredentialFailure,
    clearAuthFailures,
    clearAuthCredentialFailures,
    registerAuthSession,
    revokeAuthSession,
    revokeSessionsByEmail,
    enforceRouteRole,
    enforceAuth,
  };
}
