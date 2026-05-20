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

function readWebhooksTextFile() {
  const filePath = path.resolve(process.cwd(), "empresas.txt");

  if (!existsSync(filePath)) {
    throw new Error("Arquivo empresas.txt nao encontrado na raiz do projeto.");
  }

  const content = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  const mappings = [];

  for (const line of lines) {
    if (line.startsWith("#")) {
      continue;
    }

    const parts = line.split(/\s-\s/);
    if (parts.length < 2) {
      continue;
    }

    const nome = parts[0].trim();
    const webhookUrl = parts.slice(1).join(" - ").trim();

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
  return readWebhooksTextFile().map((item) => ({
    nome: item.nome,
    webhookUrl: item.webhookUrl,
  }));
}

export function findWebhookMappingByAccountName(accountName) {
  const normalized = normalizeName(accountName);
  if (!normalized) {
    return null;
  }

  const mappings = readWebhooksTextFile();
  return mappings.find((item) => item.nome_normalizado === normalized) || null;
}

export function resolveWebhookConfigByAccountName(accountName) {
  const found = findWebhookMappingByAccountName(accountName);

  if (!found) {
    throw new Error(
      `Nao existe webhook mapeado para a conta '${accountName}' no arquivo empresas.txt.`,
    );
  }

  return {
    nome: found.nome,
    webhookUrl: found.webhookUrl,
    headersTemplate: { ...HEADER_TEMPLATE },
    headersMode: "template",
  };
}
