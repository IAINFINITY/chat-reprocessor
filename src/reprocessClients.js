import { listWebhookMappings } from "./webhookResolver.js";

const DEFAULT_SOURCE = "manual_reprocess";
const DEFAULT_SECRET_HEADER = "x-reprocess-secret";
const DEFAULT_HMAC_HEADER = "x-reprocess-signature";

function normalizeClientKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "");
}

function maybeRepairMojibake(value) {
  const text = String(value || "");

  if (!/[ÃÂ]/.test(text)) {
    return text;
  }

  try {
    return Buffer.from(text, "latin1").toString("utf8");
  } catch {
    return text;
  }
}

function normalizeClientName(value) {
  return maybeRepairMojibake(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function toEnvKey(clientKey) {
  return String(clientKey || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_");
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

function parsePositiveInteger(rawValue, fallbackValue) {
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallbackValue;
  }

  return parsed;
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

const payloadBuilders = {
  default: buildDefaultPayload,
};

function getClientsRegistry(env = process.env) {
  const mappings = listWebhookMappings();
  const clients = {};

  for (const mapping of mappings) {
    const key = normalizeClientKey(mapping.nome);
    if (!key) {
      continue;
    }

    const envKey = toEnvKey(key);
    const envPrefix = `CLIENT_${envKey}_`;
    const builderKey = normalizeClientKey(env[`${envPrefix}PAYLOAD_BUILDER`] || "default") || "default";
    const payloadBuilder = payloadBuilders[builderKey] || payloadBuilders.default;

    clients[key] = {
      key,
      name: mapping.nome,
      webhookUrl: mapping.webhookUrl,
      webhookSecret: String(env[`${envPrefix}WEBHOOK_SECRET`] || "").trim(),
      webhookSecretHeader: String(env[`${envPrefix}WEBHOOK_SECRET_HEADER`] || DEFAULT_SECRET_HEADER).trim(),
      webhookHmacSecret: String(env[`${envPrefix}WEBHOOK_HMAC_SECRET`] || "").trim(),
      webhookHmacHeader: String(env[`${envPrefix}WEBHOOK_HMAC_HEADER`] || DEFAULT_HMAC_HEADER).trim(),
      timeoutMs: parsePositiveInteger(env[`${envPrefix}TIMEOUT_MS`], 10000),
      retryCount: parsePositiveInteger(env[`${envPrefix}RETRY_COUNT`], 2),
      chatwootAccountIds: parseCsvInteger(env[`${envPrefix}CHATWOOT_ACCOUNT_IDS`]),
      payloadBuilder,
    };
  }

  return clients;
}

export function listReprocessClients() {
  return Object.values(getClientsRegistry()).map((client) => ({
    key: client.key,
    name: client.name,
    webhook_url: client.webhookUrl,
    chatwoot_account_ids: client.chatwootAccountIds,
    webhook_configured: Boolean(client.webhookUrl),
  }));
}

export function getReprocessClient(clientKey) {
  const normalized = normalizeClientKey(clientKey);
  if (!normalized) {
    return null;
  }

  return getClientsRegistry()[normalized] || null;
}

export function detectReprocessClientByAccountId(accountId) {
  const numericAccountId = Number(accountId || 0);
  if (!Number.isInteger(numericAccountId) || numericAccountId <= 0) {
    return null;
  }

  return (
    Object.values(getClientsRegistry()).find((client) => client.chatwootAccountIds.includes(numericAccountId)) ||
    null
  );
}

export function detectReprocessClientByAccountName(accountName) {
  const normalizedName = normalizeClientName(accountName);
  if (!normalizedName) {
    return null;
  }

  return (
    Object.values(getClientsRegistry()).find(
      (client) => normalizeClientName(client.name) === normalizedName,
    ) || null
  );
}

export function buildClientPayload(clientConfig, context) {
  return clientConfig.payloadBuilder(context);
}
