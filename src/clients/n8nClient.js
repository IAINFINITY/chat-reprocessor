function parseJsonSafe(rawText) {
  try {
    return JSON.parse(String(rawText || ""));
  } catch {
    return null;
  }
}

function normalizeBaseUrl(value) {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "");
}

function buildQueryString(query = {}) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    params.set(key, String(value));
  }

  const raw = params.toString();
  return raw ? `?${raw}` : "";
}

export function createN8nClient(config = {}) {
  const baseUrl = normalizeBaseUrl(config.n8nApiBaseUrl);
  const apiKey = String(config.n8nApiKey || "").trim();
  const timeoutMs = Number(config.n8nApiTimeoutMs || 12000);
  const enabled = Boolean(baseUrl && apiKey);

  async function request(pathname, { method = "GET", query = {}, body = null } = {}) {
    if (!enabled) {
      throw new Error("Integração com API do n8n não configurada.");
    }

    const endpoint = `${baseUrl}${pathname}${buildQueryString(query)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-N8N-API-KEY": apiKey,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const rawText = await response.text();
      const parsed = parseJsonSafe(rawText);

      if (!response.ok) {
        const error = new Error(
          `Falha na API do n8n (${response.status}) ao acessar ${pathname}.`,
        );
        error.details = {
          status_code: response.status,
          endpoint,
          response_excerpt: String(rawText || "").slice(0, 1200),
        };
        throw error;
      }

      return parsed ?? {};
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeoutError = new Error(
          `Timeout ao consultar API do n8n após ${timeoutMs}ms.`,
        );
        timeoutError.details = {
          status_code: null,
          endpoint,
          is_timeout: true,
        };
        throw timeoutError;
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    enabled,
    async listExecutions({ limit = 20, includeData = true, status, workflowId } = {}) {
      const query = {
        limit: Math.max(1, Math.min(Number(limit || 20), 100)),
        includeData: includeData ? "true" : "false",
      };

      if (status) {
        query.status = status;
      }

      if (workflowId) {
        query.workflowId = workflowId;
      }

      return request("/api/v1/executions", { method: "GET", query });
    },
    async getExecution(executionId, { includeData = true } = {}) {
      const safeId = String(executionId || "").trim();
      if (!safeId) {
        throw new Error("executionId obrigatório para consultar execução no n8n.");
      }

      return request(`/api/v1/executions/${encodeURIComponent(safeId)}`, {
        method: "GET",
        query: { includeData: includeData ? "true" : "false" },
      });
    },
  };
}
