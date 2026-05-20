import OpenAI from "openai";

export function createOpenAiClient(config) {
  if (!config?.openaiApiKey) {
    return null;
  }

  return new OpenAI({
    apiKey: config.openaiApiKey,
  });
}

