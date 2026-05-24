import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_FILE_NAME = "empresas.json";

function getCompaniesFilePath() {
  return path.resolve(process.cwd(), DEFAULT_FILE_NAME);
}

function normalizeRow(input = {}) {
  const rawAccountIds = input?.chatwoot_account_ids ?? input?.account_ids ?? input?.account_id;
  const parsedAccountIds = Array.isArray(rawAccountIds)
    ? rawAccountIds
    : String(rawAccountIds == null ? "" : rawAccountIds)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
  const normalizedAccountIds = [...new Set(
    parsedAccountIds
      .map((item) => Number(item))
      .filter((item) => Number.isInteger(item) && item > 0),
  )];

  return {
    nome: String(input?.nome || "").trim(),
    url_webhook: String(input?.url_webhook || "").trim(),
    tabela: String(input?.tabela || input?.pause_table || "").trim(),
    chatwoot_account_ids: normalizedAccountIds,
  };
}

function parseCompaniesFile(rawText) {
  let parsed = {};
  try {
    parsed = JSON.parse(String(rawText || "").replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("Arquivo empresas.json invalido. Verifique o formato JSON.");
  }

  const empresas = Array.isArray(parsed?.empresas) ? parsed.empresas : [];
  return empresas.map(normalizeRow);
}

function validateCompaniesRows(rows) {
  if (!Array.isArray(rows)) {
    throw new Error("O campo 'empresas' deve ser um array.");
  }

  if (rows.length > 500) {
    throw new Error("Limite excedido. Maximo de 500 empresas por arquivo.");
  }

  const duplicatedNames = new Set();
  const nameSet = new Set();

  rows.forEach((row, index) => {
    const line = index + 1;
    const nome = String(row?.nome || "").trim();
    const webhook = String(row?.url_webhook || "").trim();
    const tabela = String(row?.tabela || "").trim();
    const accountIds = Array.isArray(row?.chatwoot_account_ids) ? row.chatwoot_account_ids : [];

    if (!nome) {
      throw new Error(`Empresa #${line}: campo 'nome' obrigatorio.`);
    }

    if (!webhook) {
      throw new Error(`Empresa '${nome}': campo 'url_webhook' obrigatorio.`);
    }

    try {
      const parsedUrl = new URL(webhook);
      if (!/^https?:$/i.test(parsedUrl.protocol)) {
        throw new Error("invalid protocol");
      }
    } catch {
      throw new Error(`Empresa '${nome}': url_webhook invalida.`);
    }

    if (!tabela) {
      throw new Error(`Empresa '${nome}': campo 'tabela' obrigatorio.`);
    }

    for (const accountId of accountIds) {
      const numeric = Number(accountId);
      if (!Number.isInteger(numeric) || numeric <= 0) {
        throw new Error(`Empresa '${nome}': chatwoot_account_ids deve conter apenas inteiros positivos.`);
      }
    }

    const normalizedName = nome.toLowerCase();
    if (nameSet.has(normalizedName)) {
      duplicatedNames.add(nome);
    }
    nameSet.add(normalizedName);
  });

  if (duplicatedNames.size > 0) {
    throw new Error(
      `Nomes de empresas duplicados: ${[...duplicatedNames].join(", ")}.`,
    );
  }
}

export function readCompaniesConfig() {
  const filePath = getCompaniesFilePath();

  if (!existsSync(filePath)) {
    return {
      file_path: filePath,
      empresas: [],
    };
  }

  const content = readFileSync(filePath, "utf8");
  const empresas = parseCompaniesFile(content);

  return {
    file_path: filePath,
    empresas,
  };
}

export function writeCompaniesConfig(input = {}) {
  const filePath = getCompaniesFilePath();
  const empresas = Array.isArray(input?.empresas) ? input.empresas.map(normalizeRow) : [];

  validateCompaniesRows(empresas);

  const payload = {
    empresas,
  };

  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  return {
    file_path: filePath,
    total: empresas.length,
    empresas,
  };
}
