export const IGNORED_NAME_TOKENS = new Set([
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

export const DEFAULT_FLAG_PROBE_COLUMNS = [
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

export function maybeRepairMojibake(value) {
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

export function normalizeNameForMatch(value) {
  return maybeRepairMojibake(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function tokenizeNormalizedText(value) {
  return normalizeNameForMatch(value)
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !IGNORED_NAME_TOKENS.has(token));
}

export function normalizeDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

export function normalizePhoneForCompare(value) {
  const digits = normalizeDigits(value);
  if (!digits) {
    return "";
  }

  if (digits.startsWith("55") && digits.length > 11) {
    return digits.slice(2);
  }

  return digits;
}

export function buildBrazilianNinthDigitVariants(value) {
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

export function buildPhoneCandidates(inputPhone) {
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

export function buildLookupColumnCandidates(clientConfig) {
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

export function resolveExistingLookupColumns(candidates, tableColumns) {
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

export function resolvePauseFlagColumn(clientConfig, tableInspection, options = {}) {
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

export function buildSyntheticColumnsFromNames(columnNames) {
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

export function pickSuggestedFlagColumnByName(columnNames) {
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

export function normalizeFlagString(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

export function isPausedByFlagValue(value, acceptedValues) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value > 0;
  }

  return acceptedValues.has(normalizeFlagString(value));
}

