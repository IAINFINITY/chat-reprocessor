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
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    openaiModelName: process.env.OPENAI_MODEL_NAME || "gpt-4o-mini",
    openaiVisionModelName: process.env.OPENAI_VISION_MODEL_NAME || "gpt-4o-mini",
    openaiAudioModelName: process.env.OPENAI_AUDIO_MODEL_NAME || "gpt-4o-mini-transcribe",
    enableMediaAi: String(process.env.ENABLE_MEDIA_AI || "false").toLowerCase() === "true",
    mediaAudioPromptPath: process.env.MEDIA_AUDIO_PROMPT_PATH || "prompts/media_audio_prompt.txt",
    mediaImagePromptPath: process.env.MEDIA_IMAGE_PROMPT_PATH || "prompts/media_image_prompt.txt",
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
