import { existsSync, readFileSync, statSync } from "node:fs";
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
import { getReprocessClient, listReprocessClients } from "../domain/reprocessClients.js";
import { reprocessConversation } from "../api/reprocessConversation.js";
import { listSupabaseExposedTables } from "../clients/supabaseClient.js";
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDirPath = path.resolve(__dirname, "..", "..", "public");
const indexHtmlPath = path.resolve(publicDirPath, "pages", "index.html");
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

async function readJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Body JSON invalido.");
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

function normalizeChatPreviewContent(message) {
  const content = String(message?.content || "").trim();
  if (content) {
    return content;
  }

  const processed = String(message?.processed_message_content || "").trim();
  if (processed) {
    return processed;
  }

  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
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

function normalizeConversationMessagesForPreview(messagesResponse) {
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
    return {
      id: Number(message?.id || 0) || null,
      conversation_id: Number(message?.conversation_id || 0) || null,
      account_id: Number(message?.account_id || 0) || null,
      message_type: Number(message?.message_type),
      content_type: String(message?.content_type || "text"),
      sender_type: String(message?.sender_type || message?.sender?.type || ""),
      sender_name: String(message?.sender?.name || message?.sender?.available_name || ""),
      private: Boolean(message?.private),
      direction: mapMessageDirection(message),
      attachments_count: Array.isArray(message?.attachments) ? message.attachments.length : 0,
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

  if (tryServeStaticAsset(req, res, pathname)) {
    return;
  }

  if (req.method === "GET" && pathname === "/") {
    try {
      const content = readFileSync(indexHtmlPath, "utf8");
      return html(res, 200, content);
    } catch {
      return json(res, 500, {
        error: "index_unavailable",
        message: "Nao foi possivel carregar public/pages/index.html",
      });
    }
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
      const normalized = normalizeConversationMessagesForPreview(messagesResponse);
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

  if (req.method === "GET" && pathname === "/api/reprocess/clients") {
    return json(res, 200, {
      success: true,
      clients: listReprocessClients(),
    });
  }

  if (req.method === "GET" && pathname === "/api/reprocess/supabase/tables") {
    try {
      const schema = requestUrl.searchParams.get("schema") || "public";
      const result = await listSupabaseExposedTables(config, schema);

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
      try {
        const reconciled = await reconcileExecutionFromN8n({
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
      "Use GET /, GET /reprocessador, GET /configuracoes, GET /empresas, GET /health, GET /api/config/empresas, PUT /api/config/empresas, GET /api/reprocess/clients, GET /api/reprocess/supabase/tables, GET /api/reprocess/supabase/pause-mappings, POST /api/reprocess/preview, POST /api/reprocess/execute, POST /api/reprocess/test-connection, POST /api/reprocess/pause-status, POST /api/reprocess/chatwoot/messages, POST /api/reprocess/n8n/error-callback, GET /api/reprocess/n8n/errors/latest, POST /api/reprocess/n8n/status-callback, GET /api/reprocess/n8n/status/latest, GET /api/reprocess/n8n/execution/latest, GET /api/reprocess/n8n/events, POST /conversation-context ou POST /reprocess",
  });
});

server.listen(config.port, () => {
  console.log(`Chatwoot Reprocess Helper online em http://localhost:${config.port}`);
});

