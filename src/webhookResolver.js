import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

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

  if (!/[ÃÂ]/.test(text)) {
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

function readWebhooksJsonFile() {
  const filePath = path.resolve(process.cwd(), "empresas.json");

  if (!existsSync(filePath)) {
    throw new Error("Arquivo empresas.json nao encontrado na raiz do projeto.");
  }

  let parsed;
  try {
    const content = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Arquivo empresas.json invalido. Verifique o formato JSON.");
  }

  const empresas = Array.isArray(parsed?.empresas) ? parsed.empresas : [];
  const mappings = [];

  for (const empresa of empresas) {
    const nome = String(empresa?.nome || "").trim();
    const webhookUrl = String(empresa?.url_webhook || "").trim();

    if (!nome || !webhookUrl) {
      continue;
    }

    mappings.push({
      nome,
      nome_normalizado: normalizeName(nome),
      webhookUrl,
    });
  }

  return mappings;
}

export function listWebhookMappings() {
  return readWebhooksJsonFile().map((item) => ({
    nome: item.nome,
    webhookUrl: item.webhookUrl,
  }));
}

export function findWebhookMappingByAccountName(accountName) {
  const normalized = normalizeName(accountName);
  if (!normalized) {
    return null;
  }

  const mappings = readWebhooksJsonFile();
  return mappings.find((item) => item.nome_normalizado === normalized) || null;
}

export function resolveWebhookConfigByAccountName(accountName) {
  const found = findWebhookMappingByAccountName(accountName);

  if (!found) {
    throw new Error(
      `Nao existe webhook mapeado para a conta '${accountName}' no arquivo empresas.json.`,
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
