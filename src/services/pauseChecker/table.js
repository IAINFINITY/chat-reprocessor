import {
  describeSupabaseTable,
  inspectSupabaseTableSampleColumns,
  listSupabaseExposedTables,
  probeSupabaseTableColumns,
} from "../../clients/supabaseClient.js";
import {
  DEFAULT_FLAG_PROBE_COLUMNS,
  buildSyntheticColumnsFromNames,
  normalizeNameForMatch,
  pickSuggestedFlagColumnByName,
  tokenizeNormalizedText,
} from "./shared.js";

export function isPauseTableCandidate(tableName, suffix = "pausar") {
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

export function scorePauseTableMatch(clientName, tableName) {
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

export async function inspectPauseTableColumns({ config, table, schema, probeCandidates }) {
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

export function buildPauseProbeCandidates(configuredLookupColumns, explicitFlagColumn) {
  return [
    ...configuredLookupColumns,
    explicitFlagColumn,
    ...DEFAULT_FLAG_PROBE_COLUMNS,
  ];
}

