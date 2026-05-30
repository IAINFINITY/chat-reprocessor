import { createClient } from "@supabase/supabase-js";
import ws from "ws";

const OPENAPI_SPEC_CACHE = new Map();
const DEFAULT_TABLES_CACHE_TTL_MS = 60_000;
const DEFAULT_LOOKUP_COLUMNS_PRIORITY = [
  "telefone",
  "phone",
  "phone_number",
  "numero",
  "whatsapp",
  "telefonecliente",
  "id",
];
const DEFAULT_FLAG_COLUMNS_PRIORITY = [
  "pausado",
  "paused",
  "ia_pausada",
  "ai_paused",
  "pause",
  "is_paused",
  "ativo",
  "status",
];

export function createSupabaseAdminClient(config) {
  const supabaseUrl = String(config?.supabaseUrl || "").trim();
  const supabaseServiceRoleKey = String(config?.supabaseServiceRoleKey || "").trim();

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return null;
  }

  const realtimeTransport =
    typeof globalThis.WebSocket === "function" ? globalThis.WebSocket : ws;

  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    realtime: {
      transport: realtimeTransport,
    },
  });
}

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function normalizePrefix(value) {
  return String(value || "").trim().toLowerCase();
}

function hasManagedPrefix(tableName, prefix) {
  const normalizedTable = String(tableName || "").trim().toLowerCase();
  const normalizedPrefix = normalizePrefix(prefix);
  if (!normalizedTable || !normalizedPrefix) {
    return false;
  }
  return normalizedTable.startsWith(normalizedPrefix);
}

function decodeRouteSegment(segment) {
  const raw = String(segment || "");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function isValidTableEndpoint(endpointName) {
  const safe = String(endpointName || "").trim();
  if (!safe || safe === "rpc") {
    return false;
  }

  return !safe.includes("{") && !safe.includes("}");
}

function getRouteEndpointName(routePath) {
  const normalized = String(routePath || "");
  const segments = normalized.split("/").filter(Boolean);
  const lastSegment = segments[segments.length - 1] || "";
  return decodeRouteSegment(lastSegment);
}

function parseRefName(refValue) {
  const ref = String(refValue || "").trim();
  const marker = "#/components/schemas/";
  if (!ref.startsWith(marker)) {
    return "";
  }

  return decodeRouteSegment(ref.slice(marker.length));
}

function readSchemaRefFromMethod(methodEntry) {
  const responses = methodEntry?.responses;
  if (!responses || typeof responses !== "object") {
    return "";
  }

  const preferredResponse = responses["200"] || responses["201"] || responses.default || null;
  const content = preferredResponse?.content;
  if (!content || typeof content !== "object") {
    return "";
  }

  const jsonSchema =
    content["application/json"]?.schema ||
    content["application/vnd.pgrst.object+json"]?.schema ||
    content["application/*+json"]?.schema ||
    null;

  if (!jsonSchema || typeof jsonSchema !== "object") {
    return "";
  }

  const directRef = parseRefName(jsonSchema.$ref);
  if (directRef) {
    return directRef;
  }

  const arrayItemRef = parseRefName(jsonSchema?.items?.$ref);
  if (arrayItemRef) {
    return arrayItemRef;
  }

  return "";
}

function findTableSchemaKey(openApiDoc, tableName) {
  const normalizedTable = normalizeName(tableName);
  if (!normalizedTable) {
    return "";
  }

  const paths = openApiDoc?.paths && typeof openApiDoc.paths === "object" ? openApiDoc.paths : {};
  const methodsOrder = ["get", "post", "patch", "put"];

  for (const routePath of Object.keys(paths)) {
    const endpointName = getRouteEndpointName(routePath);
    if (!isValidTableEndpoint(endpointName)) {
      continue;
    }

    if (normalizeName(endpointName) !== normalizedTable) {
      continue;
    }

    const routeEntry = paths[routePath];
    for (const methodName of methodsOrder) {
      const schemaKey = readSchemaRefFromMethod(routeEntry?.[methodName]);
      if (schemaKey) {
        return schemaKey;
      }
    }
  }

  const schemas = openApiDoc?.components?.schemas;
  if (!schemas || typeof schemas !== "object") {
    return "";
  }

  const ranked = Object.keys(schemas)
    .map((schemaKey) => {
      const keyNorm = normalizeName(schemaKey);
      let score = 0;

      if (keyNorm === normalizedTable) {
        score += 100;
      }

      if (keyNorm.includes(normalizedTable)) {
        score += 40;
      }

      if (/\b(insert|update)\b/.test(keyNorm)) {
        score -= 40;
      }

      return { schemaKey, score };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.schemaKey.length - right.schemaKey.length);

  return ranked[0]?.schemaKey || "";
}

function extractColumnsFromSchema(schemaEntry) {
  const properties =
    schemaEntry?.properties && typeof schemaEntry.properties === "object" ? schemaEntry.properties : {};
  const required = new Set(Array.isArray(schemaEntry?.required) ? schemaEntry.required : []);
  const columns = [];

  for (const [columnName, rawDefinition] of Object.entries(properties)) {
    const definition = rawDefinition && typeof rawDefinition === "object" ? rawDefinition : {};

    columns.push({
      name: columnName,
      type: definition.type || null,
      format: definition.format || null,
      nullable: Boolean(definition.nullable),
      required: required.has(columnName),
      has_default: definition.default !== undefined,
      enum_values: Array.isArray(definition.enum) ? definition.enum : [],
      description: String(definition.description || "").trim() || null,
    });
  }

  return columns;
}

function mapExistingColumnsByName(columns) {
  const map = new Map();
  for (const column of columns) {
    const key = normalizeName(column?.name);
    if (!key) {
      continue;
    }

    if (!map.has(key)) {
      map.set(key, String(column.name));
    }
  }

  return map;
}

function suggestColumns({ columns, priority }) {
  const byName = mapExistingColumnsByName(columns);
  const suggestions = [];

  for (const preferred of priority) {
    const normalized = normalizeName(preferred);
    if (!normalized) {
      continue;
    }

    const found = byName.get(normalized);
    if (found) {
      suggestions.push(found);
    }
  }

  return [...new Set(suggestions)];
}

function inferValueType(value) {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "array";
  }

  const native = typeof value;
  if (native === "object") {
    return "object";
  }

  return native;
}

function buildColumnsFromSampleRows(rows) {
  const columnsByName = new Map();

  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      continue;
    }

    for (const [key, value] of Object.entries(row)) {
      const existing = columnsByName.get(key);
      const valueType = inferValueType(value);
      const hasValue = value !== null && value !== undefined;

      if (!existing) {
        columnsByName.set(key, {
          name: key,
          type: null,
          format: null,
          nullable: !hasValue,
          required: false,
          has_default: false,
          enum_values: [],
          description: null,
          type_guess: valueType,
        });
        continue;
      }

      if (existing.type_guess === "null" && valueType !== "null") {
        existing.type_guess = valueType;
      }

      if (hasValue) {
        existing.nullable = false;
      }
    }
  }

  return [...columnsByName.values()];
}

async function fetchSupabaseOpenApi(config, schema = "public", options = {}) {
  const supabaseUrl = String(config?.supabaseUrl || "").trim().replace(/\/$/, "");
  const supabaseServiceRoleKey = String(config?.supabaseServiceRoleKey || "").trim();
  const safeSchema = String(schema || "public").trim() || "public";
  const ttlMs = Number(options?.cacheTtlMs || DEFAULT_TABLES_CACHE_TTL_MS);
  const useCache = ttlMs > 0 && options?.bypassCache !== true;
  const cacheKey = `${supabaseUrl}|${safeSchema}`;

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return {
      ok: false,
      error: "supabase_not_configured",
      message: "SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios para consultar Supabase.",
    };
  }

  if (useCache) {
    const cached = OPENAPI_SPEC_CACHE.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }
  }

  const response = await fetch(`${supabaseUrl}/rest/v1/`, {
    method: "GET",
    headers: {
      apikey: supabaseServiceRoleKey,
      Authorization: `Bearer ${supabaseServiceRoleKey}`,
      Accept: "application/openapi+json",
      "Accept-Profile": safeSchema,
    },
  });

  const rawText = await response.text();
  let parsed = {};

  try {
    parsed = rawText ? JSON.parse(rawText) : {};
  } catch {
    parsed = {};
  }

  if (!response.ok) {
    return {
      ok: false,
      error: "supabase_openapi_error",
      message: `Falha ao ler OpenAPI do Supabase (status ${response.status}).`,
      schema: safeSchema,
      status_code: response.status,
      response_excerpt: String(rawText || "").slice(0, 500),
    };
  }

  if (!parsed || typeof parsed !== "object") {
    return {
      ok: false,
      error: "supabase_openapi_invalid_json",
      message: "OpenAPI do Supabase retornou JSON inválido.",
      schema: safeSchema,
    };
  }

  const result = {
    ok: true,
    schema: safeSchema,
    openapi: parsed,
  };

  if (useCache) {
    OPENAPI_SPEC_CACHE.set(cacheKey, {
      expiresAt: Date.now() + ttlMs,
      result,
    });
  }

  return result;
}

export async function listSupabaseExposedTables(config, schema = "public", options = {}) {
  const openApiResult = await fetchSupabaseOpenApi(config, schema, options);
  if (!openApiResult.ok) {
    return {
      ...openApiResult,
      tables: [],
      total: 0,
    };
  }

  const paths =
    openApiResult?.openapi?.paths && typeof openApiResult.openapi.paths === "object"
      ? openApiResult.openapi.paths
      : {};
  const found = [];

  for (const routePath of Object.keys(paths)) {
    const endpointName = getRouteEndpointName(routePath);
    if (!isValidTableEndpoint(endpointName)) {
      continue;
    }

    found.push(endpointName);
  }

  const uniqueTables = [...new Set(found)].sort((a, b) => a.localeCompare(b));
  const managedPrefix = String(options?.tablePrefix || "").trim();
  const managedOnly = options?.managedOnly === true;
  const managedTables = managedPrefix
    ? uniqueTables.filter((tableName) => hasManagedPrefix(tableName, managedPrefix))
    : [];
  const filtered = managedOnly && managedPrefix ? managedTables : uniqueTables;

  return {
    ok: true,
    schema: openApiResult.schema,
    managed_prefix: managedPrefix || null,
    managed_only: managedOnly,
    total_all: uniqueTables.length,
    managed_total: managedTables.length,
    tables: filtered,
    total: filtered.length,
  };
}

export async function describeSupabaseTable(config, { table, schema = "public", options = {} } = {}) {
  const safeTable = String(table || "").trim();
  if (!safeTable) {
    return {
      ok: false,
      error: "table_required",
      message: "Informe o nome da tabela para inspecionar colunas.",
      schema: String(schema || "public").trim() || "public",
      table: "",
      columns: [],
      total_columns: 0,
    };
  }

  const openApiResult = await fetchSupabaseOpenApi(config, schema, options);
  if (!openApiResult.ok) {
    return {
      ...openApiResult,
      table: safeTable,
      columns: [],
      total_columns: 0,
    };
  }

  const schemaKey = findTableSchemaKey(openApiResult.openapi, safeTable);
  const schemaEntry =
    schemaKey &&
    openApiResult?.openapi?.components?.schemas &&
    typeof openApiResult.openapi.components.schemas === "object"
      ? openApiResult.openapi.components.schemas[schemaKey]
      : null;

  if (!schemaEntry || typeof schemaEntry !== "object") {
    return {
      ok: false,
      error: "table_schema_not_found",
      message: `Não foi possível localizar schema OpenAPI da tabela '${safeTable}'.`,
      schema: openApiResult.schema,
      table: safeTable,
      schema_key: schemaKey || null,
      columns: [],
      total_columns: 0,
    };
  }

  const columns = extractColumnsFromSchema(schemaEntry);
  const lookupCandidates = suggestColumns({
    columns,
    priority: DEFAULT_LOOKUP_COLUMNS_PRIORITY,
  });
  const flagCandidates = suggestColumns({
    columns,
    priority: DEFAULT_FLAG_COLUMNS_PRIORITY,
  });

  return {
    ok: true,
    schema: openApiResult.schema,
    table: safeTable,
    schema_key: schemaKey || null,
    total_columns: columns.length,
    columns,
    lookup_candidates: lookupCandidates,
    suggested_lookup_column: lookupCandidates[0] || null,
    flag_candidates: flagCandidates,
    suggested_flag_column: flagCandidates[0] || null,
  };
}

export async function describeSupabaseTables(config, { tables, schema = "public", options = {} } = {}) {
  const tableList = Array.isArray(tables)
    ? [...new Set(tables.map((item) => String(item || "").trim()).filter(Boolean))]
    : [];

  if (tableList.length === 0) {
    return {
      ok: true,
      schema: String(schema || "public").trim() || "public",
      total: 0,
      items: [],
    };
  }

  const items = await Promise.all(
    tableList.map((tableName) =>
      describeSupabaseTable(config, {
        table: tableName,
        schema,
        options,
      }),
    ),
  );

  return {
    ok: true,
    schema: String(schema || "public").trim() || "public",
    total: items.length,
    items,
  };
}

export async function inspectSupabaseTableSampleColumns(
  config,
  { table, schema = "public", sampleLimit = 1 } = {},
) {
  const safeTable = String(table || "").trim();
  const safeSchema = String(schema || "public").trim() || "public";
  const limit = Math.max(1, Math.min(Number(sampleLimit || 1), 5));

  if (!safeTable) {
    return {
      ok: false,
      error: "table_required",
      message: "Informe o nome da tabela para amostragem.",
      schema: safeSchema,
      table: "",
      columns: [],
      total_columns: 0,
      row_count: 0,
    };
  }

  const client = createSupabaseAdminClient(config);
  if (!client) {
    return {
      ok: false,
      error: "supabase_not_configured",
      message: "SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios para amostragem.",
      schema: safeSchema,
      table: safeTable,
      columns: [],
      total_columns: 0,
      row_count: 0,
    };
  }

  try {
    const { data, error, status } = await client
      .schema(safeSchema)
      .from(safeTable)
      .select("*")
      .limit(limit);

    if (error) {
      return {
        ok: false,
        error: "table_sample_fetch_failed",
        message: error.message || "Falha ao buscar amostra da tabela no Supabase.",
        schema: safeSchema,
        table: safeTable,
        status_code: Number(status || 500),
        columns: [],
        total_columns: 0,
        row_count: 0,
      };
    }

    const rows = Array.isArray(data) ? data : [];
    const columns = buildColumnsFromSampleRows(rows);
    const lookupCandidates = suggestColumns({
      columns,
      priority: DEFAULT_LOOKUP_COLUMNS_PRIORITY,
    });
    const flagCandidates = suggestColumns({
      columns,
      priority: DEFAULT_FLAG_COLUMNS_PRIORITY,
    });

    return {
      ok: true,
      schema: safeSchema,
      table: safeTable,
      row_count: rows.length,
      columns,
      total_columns: columns.length,
      lookup_candidates: lookupCandidates,
      suggested_lookup_column: lookupCandidates[0] || null,
      flag_candidates: flagCandidates,
      suggested_flag_column: flagCandidates[0] || null,
    };
  } catch (error) {
    return {
      ok: false,
      error: "table_sample_fetch_exception",
      message: error?.message || "Erro ao amostrar dados da tabela.",
      schema: safeSchema,
      table: safeTable,
      columns: [],
      total_columns: 0,
      row_count: 0,
    };
  }
}

function isColumnNotFoundErrorMessage(message) {
  const normalized = String(message || "").toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    (normalized.includes("column") && normalized.includes("does not exist")) ||
    (normalized.includes("could not find") && normalized.includes("column"))
  );
}

export async function probeSupabaseTableColumns(
  config,
  { table, schema = "public", columnCandidates = [] } = {},
) {
  const safeTable = String(table || "").trim();
  const safeSchema = String(schema || "public").trim() || "public";
  const candidates = [...new Set(columnCandidates.map((item) => String(item || "").trim()).filter(Boolean))];

  if (!safeTable) {
    return {
      ok: false,
      error: "table_required",
      message: "Informe o nome da tabela para sondagem de colunas.",
      schema: safeSchema,
      table: "",
      existing_columns: [],
      results: [],
    };
  }

  if (candidates.length === 0) {
    return {
      ok: true,
      schema: safeSchema,
      table: safeTable,
      existing_columns: [],
      results: [],
    };
  }

  const client = createSupabaseAdminClient(config);
  if (!client) {
    return {
      ok: false,
      error: "supabase_not_configured",
      message: "SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios para sondagem.",
      schema: safeSchema,
      table: safeTable,
      existing_columns: [],
      results: [],
    };
  }

  const results = [];

  for (const columnName of candidates) {
    try {
      const { error, status } = await client
        .schema(safeSchema)
        .from(safeTable)
        .select("*")
        .eq(columnName, "__probe__")
        .limit(1);

      if (!error) {
        results.push({
          column: columnName,
          exists: true,
          status_code: Number(status || 200),
          reason: "query_ok",
        });
        continue;
      }

      const message = String(error.message || "");
      const notFound = isColumnNotFoundErrorMessage(message);
      results.push({
        column: columnName,
        exists: !notFound,
        status_code: Number(status || 400),
        reason: notFound ? "column_not_found" : "query_error_but_column_may_exist",
        error_message: message || null,
      });
    } catch (error) {
      const message = String(error?.message || "");
      const notFound = isColumnNotFoundErrorMessage(message);
      results.push({
        column: columnName,
        exists: !notFound,
        status_code: 500,
        reason: notFound ? "column_not_found" : "exception_but_column_may_exist",
        error_message: message || null,
      });
    }
  }

  const existingColumns = results.filter((item) => item.exists).map((item) => item.column);

  return {
    ok: true,
    schema: safeSchema,
    table: safeTable,
    existing_columns: [...new Set(existingColumns)],
    results,
  };
}
