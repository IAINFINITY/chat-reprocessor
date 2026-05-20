const DEFAULT_SOURCE = "manual_reprocess";
const DEFAULT_SECRET_HEADER = "x-reprocess-secret";

function normalizeClientKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
}

function parseCsv(rawValue) {
  return String(rawValue || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseCsvInteger(rawValue) {
  return parseCsv(rawValue)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function buildBasePayload({ clientKey, lastUserMessage, contact, conversation }) {
  return {
    message: String(lastUserMessage?.content || ""),
    phone: String(contact?.phone_number || contact?.identifier || ""),
    contact_id: Number(contact?.id || 0) || null,
    conversation_id: Number(conversation?.id || 0) || null,
    account_id: Number(conversation?.account_id || 0) || null,
    source: DEFAULT_SOURCE,
    client: clientKey,
  };
}

function buildDefaultPayload(context) {
  return buildBasePayload(context);
}

function buildN8nPayload(context) {
  return buildBasePayload(context);
}

const payloadBuilders = {
  default: buildDefaultPayload,
  n8n: buildN8nPayload,
};

function parseClientsConfigFromEnv(env = process.env) {
  const configuredKeys = parseCsv(env.REPROCESS_CLIENTS).map(normalizeClientKey).filter(Boolean);
  const clients = {};

  for (const clientKey of configuredKeys) {
    const upperKey = clientKey.toUpperCase();
    const envPrefix = `CLIENT_${upperKey}_`;
    const webhookUrl = String(env[`${envPrefix}REPROCESS_WEBHOOK`] || "").trim();

    if (!webhookUrl) {
      continue;
    }

    const builderKey = normalizeClientKey(env[`${envPrefix}PAYLOAD_BUILDER`] || clientKey) || "default";
    const payloadBuilder = payloadBuilders[builderKey] || payloadBuilders.default;

    clients[clientKey] = {
      key: clientKey,
      name: String(env[`${envPrefix}NAME`] || upperKey).trim(),
      webhookUrl,
      webhookSecret: String(env[`${envPrefix}WEBHOOK_SECRET`] || "").trim(),
      webhookSecretHeader: String(env[`${envPrefix}WEBHOOK_SECRET_HEADER`] || DEFAULT_SECRET_HEADER).trim(),
      chatwootAccountIds: parseCsvInteger(env[`${envPrefix}CHATWOOT_ACCOUNT_IDS`]),
      payloadBuilder,
    };
  }

  return clients;
}

function getClientRegistry() {
  return parseClientsConfigFromEnv();
}

export function listReprocessClients() {
  return Object.values(getClientRegistry()).map((client) => ({
    key: client.key,
    name: client.name,
    chatwoot_account_ids: client.chatwootAccountIds,
    webhook_configured: Boolean(client.webhookUrl),
  }));
}

export function getReprocessClient(clientKey) {
  const normalized = normalizeClientKey(clientKey);

  if (!normalized) {
    return null;
  }

  return getClientRegistry()[normalized] || null;
}

export function detectReprocessClientByAccountId(accountId) {
  const numericAccountId = Number(accountId || 0);

  if (!Number.isInteger(numericAccountId) || numericAccountId <= 0) {
    return null;
  }

  return (
    Object.values(getClientRegistry()).find((client) => client.chatwootAccountIds.includes(numericAccountId)) ||
    null
  );
}

export function buildClientPayload(clientConfig, context) {
  return clientConfig.payloadBuilder(context);
}
