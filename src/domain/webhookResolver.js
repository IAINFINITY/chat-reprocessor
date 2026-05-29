import { readCompaniesConfig } from "../services/companyConfigStore.js";

const HEADER_TEMPLATE = {
  host: "webhooks-n8n.iainfinity.app",
  "user-agent": "rest-client/2.1.0 (linux-musl x86_64) ruby/3.3.3p89",
  "content-length": "1846",
  accept: "application/json",
  "accept-encoding": "gzip, br",
  "cdn-loop": "cloudflare; loops=1",
  "cf-connecting-ip": "5.78.158.137",
  "cf-ipcountry": "US",
  "cf-ray": "9f66f1a2f905ef90-PDX",
  "cf-visitor": "{\"scheme\":\"https\"}",
  "cf-warp-tag-id": "814a48f1-8b19-418a-be08-d77402a639c4",
  connection: "keep-alive",
  "content-type": "application/json",
  "x-forwarded-for": "5.78.158.137",
  "x-forwarded-proto": "https",
};

function maybeRepairMojibake(value) {
  const text = String(value || "");

  if (!/[\u00C3\u00C2]/.test(text)) {
    return text;
  }

  try {
    return Buffer.from(text, "latin1").toString("utf8");
  } catch {
    return text;
  }
}

function normalizeName(value) {
  return maybeRepairMojibake(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeMappings(empresas) {
  const source = Array.isArray(empresas) ? empresas : [];
  const mappings = [];

  for (const empresa of source) {
    const nome = String(empresa?.nome || "").trim();
    const webhookUrl = String(empresa?.url_webhook || "").trim();
    const pauseTable = String(
      empresa?.tabela || empresa?.pause_table || empresa?.tabela_pausar || "",
    ).trim();
    const rawAccountIds =
      empresa?.chatwoot_account_ids ??
      empresa?.account_ids ??
      empresa?.account_id;
    const parsedAccountIds = Array.isArray(rawAccountIds)
      ? rawAccountIds
      : String(rawAccountIds == null ? "" : rawAccountIds)
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
    const chatwootAccountIds = [...new Set(
      parsedAccountIds
        .map((item) => Number(item))
        .filter((item) => Number.isInteger(item) && item > 0),
    )];

    if (!nome || !webhookUrl) {
      continue;
    }

    mappings.push({
      nome,
      nome_normalizado: normalizeName(nome),
      webhookUrl,
      pauseTable,
      chatwootAccountIds,
    });
  }

  return mappings;
}

export async function listWebhookMappings() {
  const config = await readCompaniesConfig();
  return normalizeMappings(config.empresas).map((item) => ({
    nome: item.nome,
    webhookUrl: item.webhookUrl,
    pauseTable: item.pauseTable || "",
    chatwootAccountIds: Array.isArray(item.chatwootAccountIds) ? item.chatwootAccountIds : [],
  }));
}

export async function findWebhookMappingByAccountName(accountName) {
  const normalized = normalizeName(accountName);
  if (!normalized) {
    return null;
  }

  const config = await readCompaniesConfig();
  const mappings = normalizeMappings(config.empresas);
  return mappings.find((item) => item.nome_normalizado === normalized) || null;
}

export async function resolveWebhookConfigByAccountName(accountName) {
  const found = await findWebhookMappingByAccountName(accountName);

  if (!found) {
    throw new Error(
      `Não existe webhook mapeado para a conta '${accountName}' na configuração de empresas.`,
    );
  }

  return {
    nome: found.nome,
    webhookUrl: found.webhookUrl,
    headersTemplate: { ...HEADER_TEMPLATE },
    headersMode: "template",
  };
}

export function getWebhookHeaderTemplate() {
  return { ...HEADER_TEMPLATE };
}
