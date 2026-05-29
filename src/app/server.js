import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import {
  extractMessageAttachments,
  guessAttachmentMimeType,
  mapProfileAccounts,
  normalizeConversationMessagesForPreview,
  resolveAttachmentSourceUrl,
} from "./chatPreviewUtils.js";
import {
  extractConversationIdFromExecuteInput,
  enrichApiErrorWithN8nEvent,
  isStaleRunningExecutionEvent,
  validateN8nCallbackSecret,
} from "./n8nRouteUtils.js";
import {
  getRequestUrl,
  html,
  json,
  readJsonBody,
  resolveSafeNextPath,
  tryServeStaticAsset,
} from "./httpUtils.js";
import { createAuthRuntime } from "./authRuntime.js";

loadEnvFile();

const config = getConfig();
let configBootstrapError = null;
try {
  assertRequiredConfig(config);
} catch (error) {
  configBootstrapError = error;
  console.error(
    JSON.stringify({
      level: "error",
      event: "bootstrap_config_error",
      ts: new Date().toISOString(),
      message: error?.message || "Falha ao validar configuração obrigatória.",
    }),
  );
}
configureN8nEventStore({
  maxEvents: config.n8nEventStoreMaxEvents,
});
configureAuthAuditStore();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDirPath = path.resolve(__dirname, "..", "..", "public");
const loginHtmlPath = path.resolve(publicDirPath, "pages", "login.html");
const reprocessadorHtmlPath = path.resolve(publicDirPath, "pages", "reprocessador.html");
const configuracoesHtmlPath = path.resolve(publicDirPath, "pages", "configuracoes.html");

const auth = createAuthRuntime({
  config,
  json,
  registerAuthAuditEvent,
  createSupabaseAdminClient,
});

const {
  constants: authConstants,
  getClientIp,
  normalizeAuthRole,
  registerAuthAudit,
  ensureAuthCsrfCookie,
  enforceAuthCsrf,
  waitForAuthFailureWindow,
  createAuthSessionToken: createAuthSessionTokenRaw,
  verifyAuthSessionToken: verifyAuthSessionTokenRaw,
  buildAuthCookie: buildAuthCookieRaw,
  buildAuthCsrfCookie,
  authenticateSupabasePassword: authenticateSupabasePasswordRaw,
  checkUserAllowed: checkUserAllowedRaw,
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
  enforceRouteRole: enforceRouteRoleRaw,
  enforceAuth: enforceAuthRaw,
} = auth;

const AUTH_MAX_ATTEMPTS = authConstants.AUTH_MAX_ATTEMPTS;
const AUTH_CREDENTIAL_MAX_ATTEMPTS = authConstants.AUTH_CREDENTIAL_MAX_ATTEMPTS;
const AUTH_BLOCK_MS = authConstants.AUTH_BLOCK_MS;
const AUTH_WINDOW_MS = authConstants.AUTH_WINDOW_MS;

function enforceAuth(req, res, requestUrl, _config) {
  return enforceAuthRaw(req, res, requestUrl);
}

function enforceRouteRole(req, res, _config, requiredRole) {
  return enforceRouteRoleRaw(req, res, requiredRole);
}

function createAuthSessionToken(_config, sessionData) {
  return createAuthSessionTokenRaw(sessionData);
}

function verifyAuthSessionToken(token, _config) {
  return verifyAuthSessionTokenRaw(token);
}

function buildAuthCookie(token, req, _config, options = {}) {
  return buildAuthCookieRaw(token, req, options);
}

async function authenticateSupabasePassword(_config, email, password) {
  return authenticateSupabasePasswordRaw(email, password);
}

async function checkUserAllowed(_config, email) {
  return checkUserAllowedRaw(email);
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
        message: error?.message || "Erro de requisição.",
      },
    };
  }

  return {
    statusCode: 500,
    body: {
      success: false,
      error: "internal_error",
      message: error?.message || "Erro interno não identificado.",
    },
  };
}
export async function requestHandler(req, res) {
  const requestUrl = getRequestUrl(req);
  const pathname = requestUrl.pathname;

  if (configBootstrapError) {
    return json(res, 500, {
      success: false,
      error: "config_bootstrap_error",
      message: configBootstrapError?.message || "Falha ao validar configuração de ambiente.",
      hint:
        "Verifique as variáveis obrigatórias no projeto da Vercel e redeploy. Consulte os logs da Function para detalhes.",
    });
  }

  if (!enforceAuth(req, res, requestUrl, config)) {
    return;
  }

  if (tryServeStaticAsset(req, res, pathname, publicDirPath)) {
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
        message: "Não foi possível carregar public/pages/login.html",
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
    const auditStats = await getAuthAuditStats();
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
    const events = await listAuthAuditEvents({
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
        message: "Não foi possível carregar public/pages/reprocessador.html",
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
        message: "Não foi possível carregar public/pages/reprocessador.html",
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
        message: "Não foi possível carregar public/pages/configuracoes.html",
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

      const empresas = await mapProfileAccounts(profile, findWebhookMappingByAccountName);
      return json(res, 200, { empresas });
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
      const profileAccounts = await mapProfileAccounts(profile, findWebhookMappingByAccountName);
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
        clients: await listReprocessClients(),
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
      const allClients = await listReprocessClients();
      const targetClients = clientFilter
        ? allClients.filter((client) => String(client.key || "").toLowerCase() === clientFilter)
        : allClients;

      if (clientFilter && targetClients.length === 0) {
        return json(res, 404, {
          success: false,
          error: "client_not_found",
          message: `Cliente '${clientFilter}' não encontrado.`,
        });
      }

      const mappings = await Promise.all(
        targetClients.map(async (clientSummary) => {
          const clientConfig = await getReprocessClient(clientSummary.key);
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

        await registerWebhookDispatchEvent({
          request_id: requestContext.requestId,
          client: requestContext.client,
          conversation_id: requestContext.conversationId,
          httpStatusCode: result?.webhook_http_status || null,
        });

        scheduleExecutionReconciliation({
          config,
          context: requestContext,
          onEvent: async (event) => {
            await registerN8nExecutionEvent(event);
          },
          onFailure: async (error) => {
            await registerN8nStatusEvent({
              category: "n8n_execution_lookup_failed",
              title: "Falha ao consultar execução no n8n",
              likely_cause: error?.message || "Falha não identificada ao consultar API do n8n.",
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
      await enrichApiErrorWithN8nEvent(formatted.body, {
        requestId: String(formatted.body?.details?.request_id || "").trim(),
        client: String(formatted.body?.details?.client || input?.client || "")
          .trim()
          .toLowerCase(),
        conversationId: extractConversationIdFromExecuteInput(input),
      }, getLatestN8nErrorEvent);
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
      const event = await registerN8nErrorEvent(normalizedInput);

      return json(res, 200, {
        success: true,
        message: "Evento de erro n8n recebido.",
        event,
      });
    } catch (error) {
      return json(res, 400, {
        success: false,
        error: "invalid_n8n_callback_payload",
        message: error?.message || "Payload inválido para callback de erro n8n.",
      });
    }
  }

  if (req.method === "GET" && pathname === "/api/reprocess/n8n/errors/latest") {
    const client = requestUrl.searchParams.get("client") || "";
    const requestId = requestUrl.searchParams.get("request_id") || "";
    const conversationId = requestUrl.searchParams.get("conversation_id") || "";
    const event = await getLatestN8nErrorEvent({
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
      const event = await registerN8nStatusEvent(normalizedInput);

      return json(res, 200, {
        success: true,
        message: "Evento de status n8n recebido.",
        event,
      });
    } catch (error) {
      return json(res, 400, {
        success: false,
        error: "invalid_n8n_callback_payload",
        message: error?.message || "Payload inválido para callback de status n8n.",
      });
    }
  }

  if (req.method === "GET" && pathname === "/api/reprocess/n8n/status/latest") {
    const client = requestUrl.searchParams.get("client") || "";
    const requestId = requestUrl.searchParams.get("request_id") || "";
    const conversationId = requestUrl.searchParams.get("conversation_id") || "";
    const event = await getLatestN8nStatusEvent({
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
      const result = await readCompaniesConfig();
      return json(res, 200, {
        success: true,
        storage: result.storage,
        total: result.empresas.length,
        empresas: result.empresas,
      });
    } catch (error) {
      return json(res, 500, {
        success: false,
        error: "companies_read_failed",
        message: error?.message || "Falha ao ler configuração de empresas.",
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
      const result = await writeCompaniesConfig(input);
      return json(res, 200, {
        success: true,
        message: "Empresas salvas com sucesso.",
        storage: result.storage,
        total: result.total,
        empresas: result.empresas,
      });
    } catch (error) {
      return json(res, 400, {
        success: false,
        error: "companies_write_failed",
        message: error?.message || "Falha ao salvar configuração de empresas.",
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

    let event = await getLatestN8nExecutionEvent({
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
          event = await registerN8nExecutionEvent(reconciled.event);
        } else if (!event) {
          await registerN8nStatusEvent({
            category: "n8n_execution_not_found",
            title: "Execução ainda não localizada no n8n",
            likely_cause: "A execução pode ainda não ter sido indexada na API do n8n.",
            suggestion: "Tentar novamente em alguns segundos.",
            request_id: requestId || null,
            client: client || null,
            conversation_id: conversationId || null,
          });
        }
      } catch (error) {
        await registerN8nStatusEvent({
          category: "n8n_execution_lookup_failed",
          title: "Falha ao consultar execução no n8n",
          likely_cause: error?.message || "Falha não identificada ao consultar API do n8n.",
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
    const events = await listRecentN8nEvents({
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
}

const isVercelRuntime = Boolean(process.env.VERCEL) || Boolean(process.env.NOW_REGION);

if (!isVercelRuntime) {
  const server = createServer(requestHandler);
  server.listen(config.port, () => {
    console.log(`Chatwoot Reprocess Helper online em http://localhost:${config.port}`);
  });
}


