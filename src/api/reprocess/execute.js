import { randomUUID } from "node:crypto";
import { getReprocessClient } from "../../domain/reprocessClients.js";
import { checkClientPauseStatus, removeClientPauseEntry } from "../../services/pauseChecker.js";
import {
  buildIdempotencyKey,
  extractCoreContactId,
  extractCoreConversationId,
  extractPhoneForPauseCheck,
  fail,
  getClientInput,
  shouldRetry,
  signPayload,
  wait,
  logEvent,
} from "./common.js";
import {
  classifyNetworkFailure,
  classifyWebhookFailure,
  detectLogicalFailureInSuccessResponse,
} from "./webhookDiagnostics.js";

export async function executeReprocessWebhook({ input, config }) {
  const clientKey = getClientInput(input);
  const payload = input?.payload;

  if (!clientKey) {
    fail("client_required", "Informe o cliente para executar o reprocessamento.", 400);
  }

  if (!payload || typeof payload !== "object") {
    fail("invalid_payload", "Payload inválido. Gere o preview antes de executar.", 400);
  }

  const clientConfig = await getReprocessClient(clientKey);
  if (!clientConfig || !clientConfig.webhookUrl) {
    fail("webhook_not_configured", `Webhook não configurado para o cliente '${clientKey}'.`, 400);
  }

  const normalizedPayload = Array.isArray(payload) ? payload[0] : payload;
  const webhookBody = normalizedPayload?.body || payload;
  const phoneForPauseCheck = extractPhoneForPauseCheck(webhookBody);
  const pauseStatus = await checkClientPauseStatus({
    clientConfig,
    phone: phoneForPauseCheck,
    config,
    timeoutMs: Number(config?.pauseCheckTimeoutMs || 8000),
  });

  if (pauseStatus.checked && pauseStatus.paused) {
    logEvent("info", "reprocess_skipped_paused", {
      client: clientKey,
      conversation_id: extractCoreConversationId(webhookBody) || null,
      contact_id: extractCoreContactId(webhookBody) || null,
      matched_phone: pauseStatus.matched_phone || null,
      pause_table: pauseStatus.table || null,
    });

    return {
      success: true,
      skipped: true,
      status: "paused",
      message: "Reprocessamento não enviado: contato com IA pausada no Supabase.",
      pause_status: {
        event_type: "status",
        category: "supabase_ai_paused",
        title: "IA pausada no Supabase",
        likely_cause: "Contato encontrado na tabela de pausa configurada para este cliente.",
        suggestion: "Remover a pausa no Supabase e tentar novamente.",
        conversation_id: extractCoreConversationId(webhookBody) || null,
        client: clientKey,
        ...pauseStatus,
      },
    };
  }

  const requestId = randomUUID();
  const payloadText = JSON.stringify(webhookBody);
  const idempotencyKey = buildIdempotencyKey(clientKey, webhookBody);

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "x-request-id": requestId,
    "x-idempotency-key": idempotencyKey,
  };

  if (clientConfig.webhookSecret) {
    headers[clientConfig.webhookSecretHeader || "x-reprocess-secret"] = clientConfig.webhookSecret;
  }

  if (clientConfig.webhookHmacSecret) {
    headers[clientConfig.webhookHmacHeader || "x-reprocess-signature"] = signPayload(
      payloadText,
      clientConfig.webhookHmacSecret,
    );
  }

  const maxAttempts = Number(clientConfig.retryCount || 0) + 1;
  let lastErrorMessage = "Erro não identificado";
  let lastStatusCode = null;
  let lastErrorDetails = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(clientConfig.timeoutMs || 10000));

    try {
      logEvent("info", "webhook_send_attempt", {
        request_id: requestId,
        client: clientKey,
        attempt,
        max_attempts: maxAttempts,
        timeout_ms: Number(clientConfig.timeoutMs || 10000),
        conversation_id: extractCoreConversationId(webhookBody) || null,
        contact_id: extractCoreContactId(webhookBody) || null,
      });

      const response = await fetch(clientConfig.webhookUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(webhookBody),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const responseText = await response.text();

      if (response.ok) {
        const logicalFailure = detectLogicalFailureInSuccessResponse(responseText);
        if (logicalFailure) {
          const classified = classifyWebhookFailure({
            statusCode: logicalFailure.statusCode,
            responseBody: responseText,
          });

          lastStatusCode = logicalFailure.statusCode;
          lastErrorMessage = `Webhook respondeu HTTP 200, mas com erro lógico no body: ${responseText || "(vazio)"}`;
          lastErrorDetails = {
            ...classified,
            request_id: requestId,
            client: clientKey,
            attempt,
            http_status_code: response.status,
            logical_failure: logicalFailure.reason,
          };

          logEvent("error", "webhook_send_failed_logical_response", {
            request_id: requestId,
            client: clientKey,
            attempt,
            http_status_code: response.status,
            logical_status_code: logicalFailure.statusCode,
            logical_failure: logicalFailure.reason,
            response_body: responseText || "",
          });

          break;
        }

        logEvent("info", "webhook_send_success", {
          request_id: requestId,
          client: clientKey,
          attempt,
          status_code: response.status,
          conversation_id: extractCoreConversationId(webhookBody) || null,
          contact_id: extractCoreContactId(webhookBody) || null,
        });

        return {
          success: true,
          message: "Payload enviado ao webhook. Aguardando conclusão final do fluxo.",
          request_id: requestId,
          idempotency_key: idempotencyKey,
          client: clientKey,
          conversation_id: extractCoreConversationId(webhookBody) || null,
          contact_id: extractCoreContactId(webhookBody) || null,
          webhook_http_status: response.status,
          pause_status: pauseStatus.checked ? pauseStatus : null,
        };
      }

      const classified = classifyWebhookFailure({
        statusCode: response.status,
        responseBody: responseText,
      });
      lastStatusCode = response.status;
      lastErrorMessage = `Webhook respondeu com status ${response.status}. Body: ${responseText || "(vazio)"}`;
      lastErrorDetails = {
        ...classified,
        request_id: requestId,
        client: clientKey,
        attempt,
      };

      logEvent("error", "webhook_send_failed_response", {
        request_id: requestId,
        client: clientKey,
        attempt,
        status_code: response.status,
        response_body: responseText || "",
      });

      if (!shouldRetry({ statusCode: response.status, networkError: false }) || attempt >= maxAttempts) {
        break;
      }
    } catch (error) {
      clearTimeout(timeout);

      const isAbort = error?.name === "AbortError";
      const classifiedNetwork = classifyNetworkFailure(error, Number(clientConfig.timeoutMs || 10000));
      lastErrorMessage = isAbort
        ? `Timeout ao chamar webhook após ${Number(clientConfig.timeoutMs || 10000)}ms`
        : `Erro ao chamar o webhook: ${error?.message || "falha de rede"}`;
      lastErrorDetails = {
        ...classifiedNetwork,
        request_id: requestId,
        client: clientKey,
        attempt,
      };

      logEvent("error", "webhook_send_failed_network", {
        request_id: requestId,
        client: clientKey,
        attempt,
        is_timeout: isAbort,
        error_name: error?.name || null,
        error_code: error?.code || error?.cause?.code || null,
        error_cause: error?.cause?.message || null,
        error_message: error?.message || "erro de rede",
      });

      if (!shouldRetry({ statusCode: null, networkError: true }) || attempt >= maxAttempts) {
        break;
      }
    }

    await wait(attempt * 500);
  }

  fail(
    "webhook_request_error",
    `${lastErrorMessage} (request_id=${requestId}${lastStatusCode ? `, status=${lastStatusCode}` : ""})`,
    502,
    lastErrorDetails,
  );
}

export async function previewPauseStatus({ input, config }) {
  const clientKey = getClientInput(input);
  const payload = input?.payload;

  if (!clientKey) {
    fail("client_required", "Informe o cliente para consultar status de pausa.", 400);
  }

  if (!payload || typeof payload !== "object") {
    fail("invalid_payload", "Payload inválido para consulta de pausa.", 400);
  }

  const clientConfig = await getReprocessClient(clientKey);
  if (!clientConfig || !clientConfig.webhookUrl) {
    fail("webhook_not_configured", `Webhook não configurado para o cliente '${clientKey}'.`, 400);
  }

  const normalizedPayload = Array.isArray(payload) ? payload[0] : payload;
  const webhookBody = normalizedPayload?.body || payload;
  const phoneForPauseCheck = extractPhoneForPauseCheck(webhookBody);
  const pauseStatus = await checkClientPauseStatus({
    clientConfig,
    phone: phoneForPauseCheck,
    config,
    timeoutMs: Number(config?.pauseCheckTimeoutMs || 8000),
  });

  return {
    success: true,
    client: clientKey,
    conversation_id: extractCoreConversationId(webhookBody) || null,
    contact_id: extractCoreContactId(webhookBody) || null,
    phone: phoneForPauseCheck || null,
    pause_status: pauseStatus,
  };
}

export async function removePauseStatus({ input, config }) {
  const clientKey = getClientInput(input);
  const payload = input?.payload;

  if (!clientKey) {
    fail("client_required", "Informe o cliente para remover a pausa.", 400);
  }

  if (!payload || typeof payload !== "object") {
    fail("invalid_payload", "Payload inválido para remover pausa.", 400);
  }

  const clientConfig = await getReprocessClient(clientKey);
  if (!clientConfig || !clientConfig.webhookUrl) {
    fail("webhook_not_configured", `Webhook não configurado para o cliente '${clientKey}'.`, 400);
  }

  const normalizedPayload = Array.isArray(payload) ? payload[0] : payload;
  const webhookBody = normalizedPayload?.body || payload;
  const phoneForPauseCheck = extractPhoneForPauseCheck(webhookBody);

  const result = await removeClientPauseEntry({
    clientConfig,
    phone: phoneForPauseCheck,
    config,
  });

  if (result.success === false && result.reason === "pause_remove_failed") {
    fail(
      "pause_remove_failed",
      "Falha ao remover contato da tabela de pausa no Supabase.",
      502,
      result,
    );
  }

  return {
    success: true,
    client: clientKey,
    conversation_id: extractCoreConversationId(webhookBody) || null,
    contact_id: extractCoreContactId(webhookBody) || null,
    phone: phoneForPauseCheck || null,
    pause_remove: result,
    message: result.removed
      ? "Contato removido da tabela de pausa com sucesso."
      : "Contato não encontrado na tabela de pausa.",
  };
}

export async function testWebhookConnection({ input }) {
  const clientKey = getClientInput(input);

  if (!clientKey) {
    fail("client_required", "Informe o cliente para testar conexão.", 400);
  }

  const clientConfig = await getReprocessClient(clientKey);
  if (!clientConfig || !clientConfig.webhookUrl) {
    fail("webhook_not_configured", `Webhook não configurado para o cliente '${clientKey}'.`, 400);
  }

  const requestId = randomUUID();
  const timeoutMs = Number(clientConfig.timeoutMs || 10000);
  const method = String(input?.method || "POST").toUpperCase();
  const safeMethod = ["HEAD", "OPTIONS", "GET", "POST"].includes(method) ? method : "POST";

  const headers = {
    "x-request-id": requestId,
    "x-connection-test": "true",
  };

  if (clientConfig.webhookSecret) {
    headers[clientConfig.webhookSecretHeader || "x-reprocess-secret"] = clientConfig.webhookSecret;
  }

  const controller = new AbortController();
  const start = Date.now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(clientConfig.webhookUrl, {
      method: safeMethod,
      headers,
      body: safeMethod === "POST" ? "{}" : undefined,
      signal: controller.signal,
    });
    clearTimeout(timer);

    return {
      success: true,
      message: "Conexão com webhook testada.",
      request_id: requestId,
      client: clientKey,
      method: safeMethod,
      status_code: response.status,
      ok: response.ok,
      latency_ms: Date.now() - start,
    };
  } catch (error) {
    clearTimeout(timer);
    const isTimeout = error?.name === "AbortError";
    const details = classifyNetworkFailure(error, timeoutMs);

    fail(
      "webhook_connection_test_failed",
      isTimeout
        ? `Timeout no teste de conexão após ${timeoutMs}ms`
        : `Falha no teste de conexão: ${error?.message || "erro de rede"}`,
      502,
      details,
    );
  }
}
