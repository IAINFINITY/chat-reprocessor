import { readFileSync } from "node:fs";

function parseValue(rawValue) {
  const value = String(rawValue ?? "");
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function loadEnvFile(path = ".env") {
  let fileContent = "";

  try {
    fileContent = readFileSync(path, "utf8");
  } catch {
    return;
  }

  const lines = fileContent.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex < 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();

    if (!key || process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = String(parseValue(rawValue));
  }
}

export function getConfig() {
  const n8nReconcileDelaysMs = String(
    process.env.N8N_RECONCILE_DELAYS_MS || "5000,15000,30000",
  )
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);

  return {
    port: Number(process.env.PORT || 3000),
    chatwootBaseUrl: (process.env.CHATWOOT_BASE_URL || "").replace(/\/$/, ""),
    chatwootApiToken: process.env.CHATWOOT_API_ACCESS_TOKEN || "",
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    openaiModelName: process.env.OPENAI_MODEL_NAME || "gpt-4o-mini",
    openaiVisionModelName: process.env.OPENAI_VISION_MODEL_NAME || "gpt-4o-mini",
    openaiAudioModelName: process.env.OPENAI_AUDIO_MODEL_NAME || "gpt-4o-mini-transcribe",
    enableMediaAi: String(process.env.ENABLE_MEDIA_AI || "false").toLowerCase() === "true",
    mediaAudioPromptPath: process.env.MEDIA_AUDIO_PROMPT_PATH || "prompts/media_audio_prompt.txt",
    mediaImagePromptPath: process.env.MEDIA_IMAGE_PROMPT_PATH || "prompts/media_image_prompt.txt",
    supabaseUrl: String(process.env.SUPABASE_URL || "").trim(),
    supabaseAnonKey: String(process.env.SUPABASE_ANON_KEY || "").trim(),
    supabaseServiceRoleKey: String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim(),
    supabaseManagedTablePrefix: String(
      process.env.SUPABASE_MANAGED_TABLE_PREFIX || "REPROCESSAMENTO - ",
    ).trim(),
    pauseCheckTimeoutMs: Number(process.env.PAUSE_CHECK_TIMEOUT_MS || 8000),
    pauseCheckSampleLimit: Number(process.env.PAUSE_CHECK_SAMPLE_LIMIT || 200),
    n8nErrorCallbackSecret: String(process.env.N8N_ERROR_CALLBACK_SECRET || "").trim(),
    n8nErrorCallbackHeader: String(
      process.env.N8N_ERROR_CALLBACK_HEADER || "x-n8n-error-secret",
    )
      .trim()
      .toLowerCase(),
    n8nApiBaseUrl: String(process.env.N8N_API_BASE_URL || "")
      .trim()
      .replace(/\/+$/, ""),
    n8nApiKey: String(process.env.N8N_API_KEY || "").trim(),
    n8nApiTimeoutMs: Number(process.env.N8N_API_TIMEOUT_MS || 30000),
    n8nReconcileEnabled: String(process.env.N8N_RECONCILE_ENABLED || "true").toLowerCase() === "true",
    n8nReconcileDelaysMs,
    n8nExecutionLookbackLimit: Number(process.env.N8N_EXECUTION_LOOKBACK_LIMIT || 40),
    n8nEventStoreMaxEvents: Number(process.env.N8N_EVENT_STORE_MAX_EVENTS || 500),
    authEnabled: String(process.env.AUTH_ENABLED || "false").toLowerCase() === "true",
    authSessionSecret: String(process.env.AUTH_SESSION_SECRET || "").trim(),
    authCookieName: String(process.env.AUTH_COOKIE_NAME || "ia_auth_session").trim(),
    authSessionTtlHours: Number(process.env.AUTH_SESSION_TTL_HOURS || 8),
    authAllowedUsersTable: String(
      process.env.AUTH_ALLOWED_USERS_TABLE || "REPROCESSAMENTO - allowed_users",
    ).trim(),
    authAllowedUsersEmailColumn: String(
      process.env.AUTH_ALLOWED_USERS_EMAIL_COLUMN || "email",
    ).trim(),
    authAllowedUsersActiveColumn: String(
      process.env.AUTH_ALLOWED_USERS_ACTIVE_COLUMN || "active",
    ).trim(),
    authSignupBlockMode: String(process.env.AUTH_SIGNUP_BLOCK_MODE || "unknown").trim(),
    authSignupEvidenceNote: String(process.env.AUTH_SIGNUP_EVIDENCE_NOTE || "").trim(),
  };
}

export function assertRequiredConfig(config) {
  const missing = [];

  if (!config.chatwootApiToken) {
    missing.push("CHATWOOT_API_ACCESS_TOKEN");
  }

  if (!config.chatwootBaseUrl) {
    missing.push("CHATWOOT_BASE_URL");
  }

  if (!String(process.env.DATABASE_URL || "").trim()) {
    missing.push("DATABASE_URL");
  }

  if (config.authEnabled) {
    if (!config.supabaseUrl) {
      missing.push("SUPABASE_URL");
    }
    if (!config.supabaseAnonKey) {
      missing.push("SUPABASE_ANON_KEY");
    }
    if (!config.supabaseServiceRoleKey) {
      missing.push("SUPABASE_SERVICE_ROLE_KEY");
    }
    if (!config.authSessionSecret) {
      missing.push("AUTH_SESSION_SECRET");
    }
  }

  if (missing.length > 0) {
    throw new Error(`Variáveis obrigatórias ausentes: ${missing.join(", ")}`);
  }
}
