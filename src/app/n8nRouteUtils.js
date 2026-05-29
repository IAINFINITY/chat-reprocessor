export function extractConversationIdFromExecuteInput(input) {
  const normalizedPayload = Array.isArray(input?.payload) ? input.payload[0] : input?.payload;
  const webhookBody = normalizedPayload?.body || normalizedPayload || {};
  return String(webhookBody?.conversation_id || webhookBody?.id || "").trim();
}

export async function enrichApiErrorWithN8nEvent(apiBody, fallback = {}, getLatestN8nErrorEvent) {
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

  const event = await getLatestN8nErrorEvent({
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

export function validateN8nCallbackSecret(req, config) {
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

export function isStaleRunningExecutionEvent(event, maxAgeMs = 45000) {
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
