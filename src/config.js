import { readFileSync } from "node:fs";

function parseValue(rawValue) {
  if (rawValue === "true") {
    return true;
  }

  if (rawValue === "false") {
    return false;
  }

  if (rawValue !== "" && !Number.isNaN(Number(rawValue))) {
    return Number(rawValue);
  }

  return rawValue;
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
  return {
    port: Number(process.env.PORT || 3000),
    chatwootBaseUrl: (process.env.CHATWOOT_BASE_URL || "").replace(/\/$/, ""),
    chatwootApiToken: process.env.CHATWOOT_API_ACCESS_TOKEN || "",
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

  if (missing.length > 0) {
    throw new Error(`Variaveis obrigatorias ausentes: ${missing.join(", ")}`);
  }
}
