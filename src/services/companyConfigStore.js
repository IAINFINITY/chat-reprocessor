import { prisma } from "../clients/prismaClient.js";

const DEFAULT_SUPABASE_TABLE_PREFIX = "REPROCESSAMENTO - ";

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeRow(input = {}) {
  const rawAccountIds = input?.chatwoot_account_ids ?? input?.account_ids ?? input?.account_id;
  const parsedAccountIds = Array.isArray(rawAccountIds)
    ? rawAccountIds
    : String(rawAccountIds == null ? "" : rawAccountIds)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
  const normalizedAccountIds = [
    ...new Set(
      parsedAccountIds
        .map((item) => Number(item))
        .filter((item) => Number.isInteger(item) && item > 0),
    ),
  ];

  const nome = String(input?.nome || "").trim();
  return {
    nome,
    nome_normalizado: normalizeName(nome),
    url_webhook: String(input?.url_webhook || "").trim(),
    tabela: String(input?.tabela || input?.pause_table || "").trim(),
    chatwoot_account_ids: normalizedAccountIds,
    ativo: input?.ativo === undefined ? true : Boolean(input?.ativo),
  };
}

function getManagedTablePrefix() {
  const raw = String(process.env.SUPABASE_MANAGED_TABLE_PREFIX || DEFAULT_SUPABASE_TABLE_PREFIX).trim();
  return raw || DEFAULT_SUPABASE_TABLE_PREFIX;
}

function hasManagedPrefix(tableName, prefix) {
  const safeTable = String(tableName || "").trim().toLowerCase();
  const safePrefix = String(prefix || "").trim().toLowerCase();
  if (!safeTable || !safePrefix) {
    return false;
  }
  return safeTable.startsWith(safePrefix);
}

function shouldEnforceManagedPrefix() {
  const raw = String(process.env.REPROCESS_ENFORCE_MANAGED_PREFIX || "false").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes" || raw === "sim";
}

function validateCompaniesRows(rows) {
  if (!Array.isArray(rows)) {
    throw new Error("O campo 'empresas' deve ser um array.");
  }

  if (rows.length > 500) {
    throw new Error("Limite excedido. Máximo de 500 empresas por operação.");
  }

  const duplicatedNames = new Set();
  const nameSet = new Set();
  const managedPrefix = getManagedTablePrefix();
  const enforcePrefix = shouldEnforceManagedPrefix();

  rows.forEach((row, index) => {
    const line = index + 1;
    const nome = String(row?.nome || "").trim();
    const webhook = String(row?.url_webhook || "").trim();
    const tabela = String(row?.tabela || "").trim();
    const accountIds = Array.isArray(row?.chatwoot_account_ids) ? row.chatwoot_account_ids : [];

    if (!nome) {
      throw new Error(`Empresa #${line}: campo 'nome' obrigatório.`);
    }

    if (!webhook) {
      throw new Error(`Empresa '${nome}': campo 'url_webhook' obrigatório.`);
    }

    try {
      const parsedUrl = new URL(webhook);
      if (!/^https?:$/i.test(parsedUrl.protocol)) {
        throw new Error("invalid protocol");
      }
    } catch {
      throw new Error(`Empresa '${nome}': url_webhook inválida.`);
    }

    if (!tabela) {
      throw new Error(`Empresa '${nome}': campo 'tabela' obrigatório.`);
    }

    if (enforcePrefix && !hasManagedPrefix(tabela, managedPrefix)) {
      throw new Error(
        `Empresa '${nome}': tabela deve iniciar com '${managedPrefix}' (ex: '${managedPrefix}${nome.toLowerCase().replace(/\s+/g, "_")}').`,
      );
    }

    for (const accountId of accountIds) {
      const numeric = Number(accountId);
      if (!Number.isInteger(numeric) || numeric <= 0) {
        throw new Error(`Empresa '${nome}': chatwoot_account_ids deve conter apenas inteiros positivos.`);
      }
    }

    const normalizedName = normalizeName(nome);
    if (nameSet.has(normalizedName)) {
      duplicatedNames.add(nome);
    }
    nameSet.add(normalizedName);
  });

  if (duplicatedNames.size > 0) {
    throw new Error(`Nomes de empresas duplicados: ${[...duplicatedNames].join(", ")}.`);
  }
}

function mapCompanyRecord(record) {
  const rawIds = Array.isArray(record?.chatwootAccountIds) ? record.chatwootAccountIds : [];
  const ids = [
    ...new Set(
      rawIds
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0),
    ),
  ];
  return {
    nome: String(record?.nome || "").trim(),
    url_webhook: String(record?.urlWebhook || "").trim(),
    tabela: String(record?.tabela || "").trim(),
    chatwoot_account_ids: ids,
    ativo: Boolean(record?.ativo),
  };
}

function isTransactionStartTimeout(error) {
  const code = String(error?.code || "").trim();
  const message = String(error?.message || "").toLowerCase();
  return (
    code === "P2028" ||
    message.includes("unable to start a transaction") ||
    message.includes("transaction api error")
  );
}

async function writeCompaniesWithoutLongTransaction(empresas) {
  await prisma.reprocessCompany.updateMany({
    data: { ativo: false },
  });

  for (const empresa of empresas) {
    await prisma.reprocessCompany.upsert({
      where: { nomeNormalizado: empresa.nome_normalizado },
      create: {
        nome: empresa.nome,
        nomeNormalizado: empresa.nome_normalizado,
        urlWebhook: empresa.url_webhook,
        tabela: empresa.tabela,
        chatwootAccountIds: empresa.chatwoot_account_ids,
        ativo: true,
      },
      update: {
        nome: empresa.nome,
        urlWebhook: empresa.url_webhook,
        tabela: empresa.tabela,
        chatwootAccountIds: empresa.chatwoot_account_ids,
        ativo: true,
      },
    });
  }
}

export async function readCompaniesConfig({ includeInactive = false } = {}) {
  const where = includeInactive ? {} : { ativo: true };
  const companies = await prisma.reprocessCompany.findMany({
    where,
    orderBy: { nomeNormalizado: "asc" },
  });

  return {
    storage: "database",
    empresas: companies.map(mapCompanyRecord),
  };
}

export async function writeCompaniesConfig(input = {}) {
  const empresas = Array.isArray(input?.empresas) ? input.empresas.map(normalizeRow) : [];
  validateCompaniesRows(empresas);

  const operations = [
    prisma.reprocessCompany.updateMany({
      data: { ativo: false },
    }),
    ...empresas.map((empresa) =>
      prisma.reprocessCompany.upsert({
        where: { nomeNormalizado: empresa.nome_normalizado },
        create: {
          nome: empresa.nome,
          nomeNormalizado: empresa.nome_normalizado,
          urlWebhook: empresa.url_webhook,
          tabela: empresa.tabela,
          chatwootAccountIds: empresa.chatwoot_account_ids,
          ativo: true,
        },
        update: {
          nome: empresa.nome,
          urlWebhook: empresa.url_webhook,
          tabela: empresa.tabela,
          chatwootAccountIds: empresa.chatwoot_account_ids,
          ativo: true,
        },
      }),
    ),
  ];

  try {
    await prisma.$transaction(operations, {
      maxWait: 15_000,
      timeout: 60_000,
    });
  } catch (error) {
    if (!isTransactionStartTimeout(error)) {
      throw error;
    }
    await writeCompaniesWithoutLongTransaction(empresas);
  }

  return {
    storage: "database",
    total: empresas.length,
    empresas: empresas.map((item) => ({
      nome: item.nome,
      url_webhook: item.url_webhook,
      tabela: item.tabela,
      chatwoot_account_ids: item.chatwoot_account_ids,
      ativo: true,
    })),
  };
}
