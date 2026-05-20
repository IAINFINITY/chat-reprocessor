import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createChatwootClient } from "./chatwootClient.js";
import { assertRequiredConfig, getConfig, loadEnvFile } from "./config.js";
import { resolveConversationIdentity } from "./idParser.js";
import { buildReprocessPreview, executeReprocessWebhook, ReprocessApiError } from "./reprocessApi.js";
import { listReprocessClients } from "./reprocessClients.js";
import { reprocessConversation } from "./reprocessConversation.js";
import { findWebhookMappingByAccountName } from "./webhookResolver.js";

loadEnvFile();

const config = getConfig();
assertRequiredConfig(config);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const indexHtmlPath = path.resolve(__dirname, "..", "public", "index.html");

function toApiErrorResponse(error) {
  if (error instanceof ReprocessApiError) {
    return {
      statusCode: error.statusCode || 400,
      body: {
        success: false,
        error: error.code,
        message: error.message,
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
  if (req.method === "GET" && req.url === "/") {
    try {
      const content = readFileSync(indexHtmlPath, "utf8");
      return html(res, 200, content);
    } catch {
      return json(res, 500, {
        error: "index_unavailable",
        message: "Nao foi possivel carregar public/index.html",
      });
    }
  }

  if (req.method === "GET" && req.url === "/empresas") {
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

  if (req.method === "POST" && req.url === "/conversation-context") {
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

  if (req.method === "GET" && req.url === "/health") {
    return json(res, 200, { ok: true, service: "chatwoot-reprocess-helper" });
  }

  if (req.method === "GET" && req.url === "/api/reprocess/clients") {
    return json(res, 200, {
      success: true,
      clients: listReprocessClients(),
    });
  }

  if (req.method === "POST" && req.url === "/api/reprocess/preview") {
    try {
      const input = await readJsonBody(req);
      const preview = await buildReprocessPreview({ input, config });
      return json(res, 200, preview);
    } catch (error) {
      const formatted = toApiErrorResponse(error);
      return json(res, formatted.statusCode, formatted.body);
    }
  }

  if (req.method === "POST" && req.url === "/api/reprocess/execute") {
    try {
      const input = await readJsonBody(req);
      const result = await executeReprocessWebhook({ input });
      return json(res, 200, result);
    } catch (error) {
      const formatted = toApiErrorResponse(error);
      return json(res, formatted.statusCode, formatted.body);
    }
  }

  if (req.method === "POST" && req.url === "/reprocess") {
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
      "Use GET /, GET /empresas, GET /health, GET /api/reprocess/clients, POST /api/reprocess/preview, POST /api/reprocess/execute, POST /conversation-context ou POST /reprocess",
  });
});

server.listen(config.port, () => {
  console.log(`Chatwoot Reprocess Helper online em http://localhost:${config.port}`);
});
