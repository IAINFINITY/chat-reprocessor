import { createSupabaseAdminClient } from "../clients/supabaseClient.js";
import { deletePauseRows, fetchPauseRows, fetchPauseRowsSample } from "./pauseChecker/db.js";
import {
  buildBrazilianNinthDigitVariants,
  buildLookupColumnCandidates,
  buildPhoneCandidates,
  isPausedByFlagValue,
  normalizeFlagString,
  normalizePhoneForCompare,
  resolveExistingLookupColumns,
  resolvePauseFlagColumn,
} from "./pauseChecker/shared.js";
import {
  buildPauseProbeCandidates,
  inspectPauseTableColumns,
  resolvePauseTableName,
} from "./pauseChecker/table.js";

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
  const probeCandidates = buildPauseProbeCandidates(pauseLookupColumns, explicitFlagColumn);
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
  const probeCandidates = buildPauseProbeCandidates(configuredLookupColumns, explicitFlagColumn);

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
  const probeCandidates = buildPauseProbeCandidates(pauseLookupColumns, explicitFlagColumn);
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

export { resolvePauseTableName };

