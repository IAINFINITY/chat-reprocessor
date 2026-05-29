import {
  createSupabaseAdminClient,
  describeSupabaseTable,
  inspectSupabaseTableSampleColumns,
  listSupabaseExposedTables,
  probeSupabaseTableColumns,
} from "../clients/supabaseClient.js";

const IGNORED_NAME_TOKENS = new Set([
  "e",
  "de",
  "da",
  "do",
  "dos",
  "das",
  "the",
  "group",
  "grupo",
]);
const DEFAULT_FLAG_PROBE_COLUMNS = [
  "pausado",
  "paused",
  "ia_pausada",
  "ai_paused",
  "pause",
  "is_paused",
  "ia_ativa",
  "chatdesativado",
  "ChatDesativado",
  "status",
];

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

function normalizeNameForMatch(value) {
  return maybeRepairMojibake(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenizeNormalizedText(value) {
  return normalizeNameForMatch(value)
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !IGNORED_NAME_TOKENS.has(token));
}

function isPauseTableCandidate(tableName, suffix = "pausar") {
  const normalized = normalizeNameForMatch(tableName);
  const safeSuffix = String(suffix || "pausar")
    .toLowerCase()
    .trim();

  if (!normalized || !safeSuffix) {
    return false;
  }

  return (
    normalized.endsWith(` ${safeSuffix}`) ||
    normalized.endsWith(` ${safeSuffix} ia`) ||
    normalized.includes(` ${safeSuffix} `)
  );
}

function scorePauseTableMatch(clientName, tableName) {
  const clientNorm = normalizeNameForMatch(clientName);
  const tableNorm = normalizeNameForMatch(tableName);

  if (!clientNorm || !tableNorm) {
    return 0;
  }

  const tokens = tokenizeNormalizedText(clientNorm);
  if (tokens.length === 0) {
    return 0;
  }

  let score = 0;

  if (tableNorm.includes(clientNorm)) {
    score += 100;
  }

  let hitCount = 0;
  for (const token of tokens) {
    if (tableNorm.includes(token)) {
      hitCount += 1;
      score += 20;
    }
  }

  if (hitCount === tokens.length) {
    score += 40;
  }

  return score;
}

export async function resolvePauseTableName(clientConfig, config) {
  const explicitPauseTable = String(clientConfig?.pauseTable || "").trim();
  const explicitSource = String(clientConfig?.pauseTableSource || "env").trim() || "env";
  if (explicitPauseTable) {
    return {
      table: explicitPauseTable,
      source: explicitSource,
      reason: null,
    };
  }

  if (!clientConfig?.pauseAutoDetectTable) {
    return {
      table: "",
      source: "disabled",
      reason: "pause_auto_detect_disabled",
    };
  }

  const schema = String(clientConfig?.pauseSchema || "public").trim() || "public";
  const suffix = String(clientConfig?.pauseTableSuffix || "pausar")
    .trim()
    .toLowerCase();
  const managedPrefix = String(config?.supabaseManagedTablePrefix || "").trim();
  const managedListResult = await listSupabaseExposedTables(config, schema, {
    tablePrefix: managedPrefix,
    managedOnly: Boolean(managedPrefix),
  });

  if (!managedListResult?.ok || !Array.isArray(managedListResult.tables)) {
    return {
      table: "",
      source: "auto_error",
      reason: managedListResult?.error || "list_tables_failed",
    };
  }

  let candidateSource = "managed_prefix";
  let pauseCandidates = managedListResult.tables.filter((tableName) =>
    isPauseTableCandidate(tableName, suffix),
  );

  if (pauseCandidates.length === 0) {
    const fallbackListResult = await listSupabaseExposedTables(config, schema, {
      tablePrefix: managedPrefix,
      managedOnly: false,
    });
    if (fallbackListResult?.ok && Array.isArray(fallbackListResult.tables)) {
      pauseCandidates = fallbackListResult.tables.filter((tableName) =>
        isPauseTableCandidate(tableName, suffix),
      );
      candidateSource = "all_tables_fallback";
    }
  }

  if (pauseCandidates.length === 0) {
    return {
      table: "",
      source: "auto_empty",
      reason: "no_pause_table_candidates",
    };
  }

  const ranked = pauseCandidates
    .map((tableName) => ({
      tableName,
      score: scorePauseTableMatch(clientConfig?.name, tableName),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.tableName.length - right.tableName.length);

  if (!ranked[0]?.tableName) {
    return {
      table: "",
      source: "auto_empty",
      reason: "no_matching_client_table",
    };
  }

  return {
    table: ranked[0].tableName,
    source: `auto:${candidateSource}`,
    reason: null,
  };
}

function normalizeDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizePhoneForCompare(value) {
  const digits = normalizeDigits(value);
  if (!digits) {
    return "";
  }

  if (digits.startsWith("55") && digits.length > 11) {
    return digits.slice(2);
  }

  return digits;
}

function buildBrazilianNinthDigitVariants(value) {
  const raw = normalizePhoneForCompare(value);
  if (!raw) {
    return [];
  }

  const variants = new Set([raw]);

  if (raw.length === 11 && raw[2] === "9") {
    variants.add(`${raw.slice(0, 2)}${raw.slice(3)}`);
  }

  if (raw.length === 10) {
    variants.add(`${raw.slice(0, 2)}9${raw.slice(2)}`);
  }

  return [...variants];
}

function buildPhoneCandidates(inputPhone) {
  const raw = String(inputPhone || "").trim();
  const digits = normalizeDigits(raw);
  const candidates = [];

  if (raw) {
    candidates.push(raw);
  }

  if (digits) {
    candidates.push(digits);
    candidates.push(normalizePhoneForCompare(digits));

    if (!raw.startsWith("+")) {
      candidates.push(`+${digits}`);
    }

    if (digits.startsWith("55") && digits.length > 11) {
      candidates.push(digits.slice(2));
      candidates.push(`+${digits.slice(2)}`);
    }

    const normalized = normalizePhoneForCompare(digits);
    for (const variant of buildBrazilianNinthDigitVariants(normalized)) {
      candidates.push(variant);
      candidates.push(`+${variant}`);
      candidates.push(`55${variant}`);
      candidates.push(`+55${variant}`);
    }
  }

  return [...new Set(candidates.filter(Boolean))];
}

function buildLookupColumnCandidates(clientConfig) {
  const configuredList = Array.isArray(clientConfig?.pauseLookupColumns)
    ? clientConfig.pauseLookupColumns
    : [];
  const legacyColumn = String(clientConfig?.pausePhoneColumn || "").trim();
  const fallbacks = [
    "telefone",
    "phone",
    "phone_number",
    "numero",
    "whatsapp",
    "telefonecliente",
    "id",
  ];

  return [...new Set([...configuredList, legacyColumn, ...fallbacks].filter(Boolean))];
}

function resolveExistingLookupColumns(candidates, tableColumns) {
  const normalizedToRaw = new Map();
  const columns = Array.isArray(tableColumns) ? tableColumns : [];

  for (const column of columns) {
    const columnName = String(column?.name || "").trim();
    const normalized = normalizeNameForMatch(columnName);
    if (!columnName || !normalized || normalizedToRaw.has(normalized)) {
      continue;
    }

    normalizedToRaw.set(normalized, columnName);
  }

  const resolved = [];
  for (const candidate of candidates) {
    const normalized = normalizeNameForMatch(candidate);
    if (!normalized) {
      continue;
    }

    const existing = normalizedToRaw.get(normalized);
    if (existing) {
      resolved.push(existing);
    }
  }

  return [...new Set(resolved)];
}

function resolvePauseFlagColumn(clientConfig, tableInspection, options = {}) {
  const explicitColumn = String(clientConfig?.pauseFlagColumn || "").trim();
  const allowSuggested = options?.allowSuggested === true;
  if (!tableInspection?.ok) {
    return explicitColumn || null;
  }

  const normalizedToRaw = new Map();
  const columns = Array.isArray(tableInspection.columns) ? tableInspection.columns : [];
  for (const column of columns) {
    const columnName = String(column?.name || "").trim();
    const normalized = normalizeNameForMatch(columnName);
    if (!columnName || !normalized || normalizedToRaw.has(normalized)) {
      continue;
    }

    normalizedToRaw.set(normalized, columnName);
  }

  if (explicitColumn) {
    const existing = normalizedToRaw.get(normalizeNameForMatch(explicitColumn));
    return existing || explicitColumn;
  }

  const suggested = String(tableInspection?.suggested_flag_column || "").trim();
  if (allowSuggested && suggested) {
    return suggested;
  }

  return null;
}

function buildSyntheticColumnsFromNames(columnNames) {
  return [...new Set((columnNames || []).map((name) => String(name || "").trim()).filter(Boolean))].map(
    (name) => ({
      name,
      type: null,
      format: null,
      nullable: true,
      required: false,
      has_default: false,
      enum_values: [],
      description: null,
      type_guess: null,
    }),
  );
}

function pickSuggestedFlagColumnByName(columnNames) {
  const normalizedMap = new Map();
  for (const name of columnNames || []) {
    const raw = String(name || "").trim();
    const normalized = normalizeNameForMatch(raw);
    if (!raw || !normalized || normalizedMap.has(normalized)) {
      continue;
    }
    normalizedMap.set(normalized, raw);
  }

  for (const hint of DEFAULT_FLAG_PROBE_COLUMNS) {
    const found = normalizedMap.get(normalizeNameForMatch(hint));
    if (found) {
      return found;
    }
  }

  return null;
}

async function inspectPauseTableColumns({ config, table, schema, probeCandidates }) {
  const openApiInspection = await describeSupabaseTable(config, {
    table,
    schema,
  });

  if (openApiInspection?.ok && Array.isArray(openApiInspection.columns) && openApiInspection.columns.length > 0) {
    return {
      ...openApiInspection,
      columns_source: "openapi",
    };
  }

  const sampleInspection = await inspectSupabaseTableSampleColumns(config, {
    table,
    schema,
    sampleLimit: 1,
  });

  if (sampleInspection?.ok && Array.isArray(sampleInspection.columns) && sampleInspection.columns.length > 0) {
    return {
      ...sampleInspection,
      columns_source: "sample",
      fallback_error: openApiInspection?.ok ? null : openApiInspection?.error || null,
      fallback_message: openApiInspection?.ok ? null : openApiInspection?.message || null,
    };
  }

  const probe = await probeSupabaseTableColumns(config, {
    table,
    schema,
    columnCandidates: Array.isArray(probeCandidates) ? probeCandidates : [],
  });
  if (probe?.ok && Array.isArray(probe.existing_columns) && probe.existing_columns.length > 0) {
    return {
      ok: true,
      schema,
      table,
      columns_source: "probe",
      columns: buildSyntheticColumnsFromNames(probe.existing_columns),
      total_columns: probe.existing_columns.length,
      lookup_candidates: probe.existing_columns,
      suggested_lookup_column: probe.existing_columns[0] || null,
      flag_candidates: [],
      suggested_flag_column: pickSuggestedFlagColumnByName(probe.existing_columns),
      probe_results: probe.results || [],
      fallback_error: openApiInspection?.ok ? null : openApiInspection?.error || null,
      fallback_message: openApiInspection?.ok ? null : openApiInspection?.message || null,
    };
  }

  return {
    ...(openApiInspection || {}),
    columns_source: "unavailable",
    fallback_error:
      sampleInspection?.error || probe?.error || openApiInspection?.error || "table_inspection_failed",
    fallback_message:
      sampleInspection?.message ||
      probe?.message ||
      openApiInspection?.message ||
      "Falha ao inspecionar colunas da tabela.",
    probe_results: probe?.results || [],
  };
}

function normalizeFlagString(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function isPausedByFlagValue(value, acceptedValues) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value > 0;
  }

  return acceptedValues.has(normalizeFlagString(value));
}

async function fetchPauseRows({
  supabaseClient,
  schema,
  table,
  phoneColumn,
  phoneValue,
}) {
  try {
    const { data, error, status } = await supabaseClient
      .schema(schema)
      .from(table)
      .select("*")
      .eq(phoneColumn, phoneValue)
      .limit(1);

    if (error) {
      return {
        ok: false,
        status: Number(status || 500),
        rows: [],
        rawText: error.message || "erro supabase",
      };
    }

    return {
      ok: true,
      status: Number(status || 200),
      rows: Array.isArray(data) ? data : [],
      rawText: "",
    };
  } catch (error) {
    return {
      ok: false,
      status: 500,
      rows: [],
      rawText: error?.message || "erro supabase",
    };
  }
}

async function fetchPauseRowsSample({
  supabaseClient,
  schema,
  table,
  limit = 200,
}) {
  try {
    const { data, error, status } = await supabaseClient
      .schema(schema)
      .from(table)
      .select("*")
      .limit(Math.max(1, Math.min(Number(limit || 200), 1000)));

    if (error) {
      return {
        ok: false,
        status: Number(status || 500),
        rows: [],
        rawText: error.message || "erro supabase",
      };
    }

    return {
      ok: true,
      status: Number(status || 200),
      rows: Array.isArray(data) ? data : [],
      rawText: "",
    };
  } catch (error) {
    return {
      ok: false,
      status: 500,
      rows: [],
      rawText: error?.message || "erro supabase",
    };
  }
}

async function deletePauseRows({
  supabaseClient,
  schema,
  table,
  phoneColumn,
  phoneValue,
}) {
  try {
    const { data, error, status } = await supabaseClient
      .schema(schema)
      .from(table)
      .delete()
      .eq(phoneColumn, phoneValue)
      .select("*");

    if (error) {
      return {
        ok: false,
        status: Number(status || 500),
        rows: [],
        rawText: error.message || "erro supabase",
      };
    }

    return {
      ok: true,
      status: Number(status || 200),
      rows: Array.isArray(data) ? data : [],
      rawText: "",
    };
  } catch (error) {
    return {
      ok: false,
      status: 500,
      rows: [],
      rawText: error?.message || "erro supabase",
    };
  }
}

function findPauseRowByNormalizedPhone({
  rows,
  phoneColumns,
  candidates,
}) {
  const normalizedCandidates = new Set();
  for (const candidate of candidates || []) {
    const normalized = normalizePhoneForCompare(candidate);
    if (!normalized) {
      continue;
    }
    for (const variant of buildBrazilianNinthDigitVariants(normalized)) {
      normalizedCandidates.add(variant);
    }
  }

  if (normalizedCandidates.size === 0) {
    return null;
  }

  for (const row of Array.isArray(rows) ? rows : []) {
    for (const phoneColumn of phoneColumns || []) {
      const rowValue = row?.[phoneColumn];
      if (rowValue === null || rowValue === undefined) {
        continue;
      }

      const normalizedRowValue = normalizePhoneForCompare(rowValue);
      if (!normalizedRowValue) {
        continue;
      }

      const rowVariants = buildBrazilianNinthDigitVariants(normalizedRowValue);
      for (const rowVariant of rowVariants) {
        if (normalizedCandidates.has(rowVariant)) {
          return {
            row,
            phoneColumn,
            matchedPhone: rowVariant,
          };
        }
      }
    }
  }

  return null;
}

export async function checkClientPauseStatus({
  clientConfig,
  phone,
  config,
  timeoutMs = 8000,
}) {
  const pauseTableResolution = await resolvePauseTableName(clientConfig, config);
  const pauseTable = String(pauseTableResolution?.table || "").trim();
  if (!pauseTable) {
    return {
      checked: false,
      paused: false,
      reason: pauseTableResolution?.reason || "pause_table_not_configured",
      pause_table_source: pauseTableResolution?.source || null,
    };
  }

  const pauseSchema = String(clientConfig?.pauseSchema || "public").trim();
  const pauseLookupColumns = buildLookupColumnCandidates(clientConfig);
  const explicitFlagColumn = String(clientConfig?.pauseFlagColumn || "").trim();
  const probeCandidates = [
    ...pauseLookupColumns,
    explicitFlagColumn,
    ...DEFAULT_FLAG_PROBE_COLUMNS,
  ];
  const tableInspection = await inspectPauseTableColumns({
    config,
    table: pauseTable,
    schema: pauseSchema,
    probeCandidates,
  });
  const resolvedLookupColumns = tableInspection?.ok
    ? resolveExistingLookupColumns(pauseLookupColumns, tableInspection.columns)
    : [];
  const phoneColumns = resolvedLookupColumns.length > 0 ? resolvedLookupColumns : pauseLookupColumns;
  const pauseFlagColumn = resolvePauseFlagColumn(clientConfig, tableInspection, {
    allowSuggested: false,
  });
  const pauseFlagTrueValues = new Set(
    Array.isArray(clientConfig?.pauseFlagTrueValues) && clientConfig.pauseFlagTrueValues.length > 0
      ? clientConfig.pauseFlagTrueValues.map(normalizeFlagString)
      : ["true", "1", "sim", "yes", "paused", "pausado"],
  );

  const supabaseClient = createSupabaseAdminClient(config);
  const sampleLimit = Math.max(
    50,
    Math.min(Number(config?.pauseCheckSampleLimit || 200), 1000),
  );

  if (!supabaseClient) {
    return {
      checked: false,
      paused: false,
      reason: "supabase_not_configured",
      pause_table_source: pauseTableResolution?.source || null,
    };
  }

  const candidates = buildPhoneCandidates(phone);
  if (candidates.length === 0) {
    return {
      checked: false,
      paused: false,
      reason: "phone_not_available",
      pause_table_source: pauseTableResolution?.source || null,
      table: pauseTable,
      table_columns: tableInspection?.ok
        ? tableInspection.columns.map((column) => column.name)
        : [],
      table_columns_source: tableInspection?.columns_source || "unavailable",
      lookup_columns_tried: phoneColumns,
      flag_column: pauseFlagColumn || null,
    };
  }

  let lastFailedResponse = null;
  let hadSuccessfulQuery = false;

  for (const candidate of candidates) {
    for (const phoneColumn of phoneColumns) {
      const result = await fetchPauseRows({
        supabaseClient,
        schema: pauseSchema,
        table: pauseTable,
        phoneColumn,
        phoneValue: candidate,
      });

      if (!result.ok) {
        lastFailedResponse = result;
        continue;
      }

      hadSuccessfulQuery = true;

      const row = result.rows[0] || null;
      if (!row) {
        continue;
      }

      const paused = pauseFlagColumn
        ? isPausedByFlagValue(row[pauseFlagColumn], pauseFlagTrueValues)
        : true;

      return {
        checked: true,
        paused,
        reason: paused ? "paused_found" : "pause_flag_false",
        matched_phone: candidate,
        table: pauseTable,
        pause_table_source: pauseTableResolution?.source || "env",
        phone_column: phoneColumn,
        flag_column: pauseFlagColumn || null,
        table_columns: tableInspection?.ok
          ? tableInspection.columns.map((column) => column.name)
          : [],
        table_columns_source: tableInspection?.columns_source || "unavailable",
        lookup_columns_tried: phoneColumns,
      };
    }
  }

  if (lastFailedResponse && !hadSuccessfulQuery) {
    return {
      checked: true,
      paused: false,
      reason: "pause_check_failed",
      status_code: lastFailedResponse.status,
      response_excerpt: String(lastFailedResponse.rawText || "").slice(0, 500),
      table: pauseTable,
      pause_table_source: pauseTableResolution?.source || "env",
      phone_column: phoneColumns[0] || null,
      flag_column: pauseFlagColumn || null,
      table_columns: tableInspection?.ok
        ? tableInspection.columns.map((column) => column.name)
        : [],
      table_columns_source: tableInspection?.columns_source || "unavailable",
      lookup_columns_tried: phoneColumns,
    };
  }

  const sampleResult = await fetchPauseRowsSample({
    supabaseClient,
    schema: pauseSchema,
    table: pauseTable,
    limit: sampleLimit,
  });

  if (sampleResult.ok && Array.isArray(sampleResult.rows) && sampleResult.rows.length > 0) {
    const normalizedMatch = findPauseRowByNormalizedPhone({
      rows: sampleResult.rows,
      phoneColumns,
      candidates,
    });

    if (normalizedMatch?.row) {
      const row = normalizedMatch.row;
      const paused = pauseFlagColumn
        ? isPausedByFlagValue(row[pauseFlagColumn], pauseFlagTrueValues)
        : true;

      return {
        checked: true,
        paused,
        reason: paused ? "paused_found_normalized" : "pause_flag_false_normalized",
        matched_phone: normalizedMatch.matchedPhone,
        table: pauseTable,
        pause_table_source: pauseTableResolution?.source || "env",
        phone_column: normalizedMatch.phoneColumn,
        flag_column: pauseFlagColumn || null,
        table_columns: tableInspection?.ok
          ? tableInspection.columns.map((column) => column.name)
          : [],
        table_columns_source: tableInspection?.columns_source || "unavailable",
        lookup_columns_tried: phoneColumns,
      };
    }
  }

  return {
    checked: true,
    paused: false,
    reason: "not_paused",
    table: pauseTable,
    pause_table_source: pauseTableResolution?.source || "env",
    phone_column: phoneColumns[0] || null,
    flag_column: pauseFlagColumn || null,
    table_columns: tableInspection?.ok
      ? tableInspection.columns.map((column) => column.name)
      : [],
    table_columns_source: tableInspection?.columns_source || "unavailable",
    lookup_columns_tried: phoneColumns,
  };
}

export async function inspectPauseConfigForClient({
  clientConfig,
  config,
}) {
  const pauseTableResolution = await resolvePauseTableName(clientConfig, config);
  const pauseTable = String(pauseTableResolution?.table || "").trim();
  const pauseSchema = String(clientConfig?.pauseSchema || "public").trim();
  const configuredLookupColumns = buildLookupColumnCandidates(clientConfig);
  const explicitFlagColumn = String(clientConfig?.pauseFlagColumn || "").trim();
  const probeCandidates = [
    ...configuredLookupColumns,
    explicitFlagColumn,
    ...DEFAULT_FLAG_PROBE_COLUMNS,
  ];

  if (!pauseTable) {
    return {
      client: String(clientConfig?.key || ""),
      name: String(clientConfig?.name || ""),
      pause_table: null,
      source: pauseTableResolution?.source || null,
      reason: pauseTableResolution?.reason || "pause_table_not_configured",
      pause_schema: pauseSchema,
      configured_lookup_columns: configuredLookupColumns,
      resolved_lookup_columns: [],
      flag_column: String(clientConfig?.pauseFlagColumn || "").trim() || null,
      suggested_flag_column: null,
      columns: [],
      inspect_ok: false,
    };
  }

  const tableInspection = await inspectPauseTableColumns({
    config,
    table: pauseTable,
    schema: pauseSchema,
    probeCandidates,
  });
  const resolvedLookupColumns = tableInspection?.ok
    ? resolveExistingLookupColumns(configuredLookupColumns, tableInspection.columns)
    : [];
  const resolvedFlagColumn = resolvePauseFlagColumn(clientConfig, tableInspection, {
    allowSuggested: false,
  });

  return {
    client: String(clientConfig?.key || ""),
    name: String(clientConfig?.name || ""),
    pause_table: pauseTable,
    source: pauseTableResolution?.source || null,
    reason: pauseTableResolution?.reason || null,
    pause_schema: pauseSchema,
    configured_lookup_columns: configuredLookupColumns,
    resolved_lookup_columns: resolvedLookupColumns,
    flag_column: resolvedFlagColumn || null,
    suggested_flag_column: tableInspection?.suggested_flag_column || null,
    columns: tableInspection?.ok ? tableInspection.columns : [],
    columns_source: tableInspection?.columns_source || "unavailable",
    inspect_ok: Boolean(tableInspection?.ok),
    inspect_error: tableInspection?.ok ? null : tableInspection?.error || "table_inspection_failed",
    inspect_message: tableInspection?.ok
      ? null
      : tableInspection?.message || "Falha ao inspecionar colunas da tabela.",
    fallback_error: tableInspection?.fallback_error || null,
    fallback_message: tableInspection?.fallback_message || null,
  };
}

export async function removeClientPauseEntry({
  clientConfig,
  phone,
  config,
}) {
  const pauseTableResolution = await resolvePauseTableName(clientConfig, config);
  const pauseTable = String(pauseTableResolution?.table || "").trim();
  const pauseSchema = String(clientConfig?.pauseSchema || "public").trim();

  if (!pauseTable) {
    return {
      success: false,
      removed: false,
      reason: pauseTableResolution?.reason || "pause_table_not_configured",
      table: null,
      schema: pauseSchema,
      removed_count: 0,
    };
  }

  const supabaseClient = createSupabaseAdminClient(config);
  if (!supabaseClient) {
    return {
      success: false,
      removed: false,
      reason: "supabase_not_configured",
      table: pauseTable,
      schema: pauseSchema,
      removed_count: 0,
    };
  }

  const pauseLookupColumns = buildLookupColumnCandidates(clientConfig);
  const explicitFlagColumn = String(clientConfig?.pauseFlagColumn || "").trim();
  const probeCandidates = [
    ...pauseLookupColumns,
    explicitFlagColumn,
    ...DEFAULT_FLAG_PROBE_COLUMNS,
  ];
  const tableInspection = await inspectPauseTableColumns({
    config,
    table: pauseTable,
    schema: pauseSchema,
    probeCandidates,
  });
  const resolvedLookupColumns = tableInspection?.ok
    ? resolveExistingLookupColumns(pauseLookupColumns, tableInspection.columns)
    : [];
  const phoneColumns = resolvedLookupColumns.length > 0 ? resolvedLookupColumns : pauseLookupColumns;
  const phoneCandidates = buildPhoneCandidates(phone);

  if (phoneCandidates.length === 0) {
    return {
      success: false,
      removed: false,
      reason: "phone_not_available",
      table: pauseTable,
      schema: pauseSchema,
      removed_count: 0,
      lookup_columns_tried: phoneColumns,
    };
  }

  const pauseStatus = await checkClientPauseStatus({
    clientConfig,
    phone,
    config,
  });

  const triedPairs = new Set();
  const deleteTargets = [];
  const pushTarget = (column, value) => {
    const safeColumn = String(column || "").trim();
    const safeValue = String(value || "").trim();
    if (!safeColumn || !safeValue) {
      return;
    }
    const key = `${safeColumn}::${safeValue}`;
    if (triedPairs.has(key)) {
      return;
    }
    triedPairs.add(key);
    deleteTargets.push({ phoneColumn: safeColumn, phoneValue: safeValue });
  };

  if (pauseStatus?.paused && pauseStatus?.phone_column) {
    pushTarget(pauseStatus.phone_column, pauseStatus.matched_phone || phone);
    for (const candidate of phoneCandidates) {
      pushTarget(pauseStatus.phone_column, candidate);
    }
  } else {
    for (const phoneColumn of phoneColumns) {
      for (const candidate of phoneCandidates) {
        pushTarget(phoneColumn, candidate);
      }
    }
  }

  let removedCount = 0;
  let removedByColumn = null;
  let removedByValue = null;
  let lastError = null;

  for (const target of deleteTargets) {
    const result = await deletePauseRows({
      supabaseClient,
      schema: pauseSchema,
      table: pauseTable,
      phoneColumn: target.phoneColumn,
      phoneValue: target.phoneValue,
    });

    if (!result.ok) {
      lastError = result;
      continue;
    }

    const count = Array.isArray(result.rows) ? result.rows.length : 0;
    if (count > 0) {
      removedCount += count;
      removedByColumn = target.phoneColumn;
      removedByValue = target.phoneValue;
      if (pauseStatus?.paused) {
        break;
      }
    }
  }

  if (removedCount > 0) {
    return {
      success: true,
      removed: true,
      reason: "pause_entry_removed",
      table: pauseTable,
      schema: pauseSchema,
      removed_count: removedCount,
      phone_column: removedByColumn,
      matched_phone: removedByValue,
      pause_table_source: pauseTableResolution?.source || "env",
      lookup_columns_tried: phoneColumns,
    };
  }

  if (lastError) {
    return {
      success: false,
      removed: false,
      reason: "pause_remove_failed",
      table: pauseTable,
      schema: pauseSchema,
      removed_count: 0,
      status_code: lastError.status || null,
      response_excerpt: String(lastError.rawText || "").slice(0, 500),
      pause_table_source: pauseTableResolution?.source || "env",
      lookup_columns_tried: phoneColumns,
    };
  }

  return {
    success: true,
    removed: false,
    reason: "pause_entry_not_found",
    table: pauseTable,
    schema: pauseSchema,
    removed_count: 0,
    pause_table_source: pauseTableResolution?.source || "env",
    lookup_columns_tried: phoneColumns,
  };
}

