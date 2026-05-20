import { readFileSync } from "node:fs";
import path from "node:path";

const promptCache = new Map();

function normalizePromptPath(promptPath) {
  const raw = String(promptPath || "").trim();
  if (!raw) {
    return "";
  }

  return path.resolve(process.cwd(), raw);
}

export function loadPromptFile(promptPath, fallbackPrompt) {
  const resolvedPath = normalizePromptPath(promptPath);
  if (!resolvedPath) {
    return fallbackPrompt;
  }

  if (promptCache.has(resolvedPath)) {
    return promptCache.get(resolvedPath);
  }

  try {
    const content = readFileSync(resolvedPath, "utf8").trim();
    const finalPrompt = content || fallbackPrompt;
    promptCache.set(resolvedPath, finalPrompt);
    return finalPrompt;
  } catch {
    promptCache.set(resolvedPath, fallbackPrompt);
    return fallbackPrompt;
  }
}

export function clearPromptCache() {
  promptCache.clear();
}

