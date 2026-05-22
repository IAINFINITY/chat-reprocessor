import { createN8nClient } from "../clients/n8nClient.js";

function toLower(value) {
  return String(value || "").trim().toLowerCase();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeString(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim();
}

function collectObjectValues(input, maxValues = 3000) {
  const values = [];
  const queue = [input];
  const seen = new Set();

  while (queue.length > 0 && values.length < maxValues) {
    const current = queue.shift();
    if (!current || typeof current !== "object") {
      if (current !== null && current !== undefined) {
        values.push(String(current));
      }
      continue;
    }

    if (seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (Array.isArray(current)) {
      for (const item of current) {
        queue.push(item);
      }
      continue;
    }

    for (const value of Object.values(current)) {
      queue.push(value);
    }
  }

  return values;
}

function extractExecutionDataEnvelope(raw) {
  if (!raw || typeof raw !== "object") {
    return {};
  }

  if (raw.data && typeof raw.data === "object" && !Array.isArray(raw.data)) {
    return raw.data;
  }

  return raw;
}

function getRunDataNodes(executionData) {
  const runData = executionData?.resultData?.runData;
  if (!runData || typeof runData !== "object") {
    return {};
  }

  return runData;
}

function countExecutedNodes(executionData) {
  return Object.keys(getRunDataNodes(executionData)).length;
}

function pickLastExecutedNode(executionData, fallbackNode) {
  const lastNode =
    executionData?.resultData?.lastNodeExecuted ||
    executionData?.resultData?.error?.node?.name ||
    fallbackNode;

  return safeString(lastNode) || null;
}

function deriveExecutionStatus(execution) {
  const rawStatus = safeString(execution?.status);
  if (rawStatus) {
    return rawStatus.toLowerCase();
  }

  if (execution?.stoppedAt && execution?.finished === true) {
    return "success";
  }

  if (execution?.stoppedAt && execution?.finished === false) {
    return "error";
  }

  if (!execution?.stoppedAt) {
    return "running";
  }

  return "unknown";
}

function mapStatusToTitle(status) {
  if (status === "success") {
    return "Execucao concluida com sucesso";
  }

  if (status === "error" || status === "failed" || status === "crashed") {
    return "Execucao com erro";
  }

  if (status === "running" || status === "new" || status === "waiting") {
    return "Execucao em andamento";
  }

  return "Status da execucao atualizado";
}

function mapStatusToCategory(status) {
  if (status === "success") {
    return "n8n_execution_success";
  }

  if (status === "error" || status === "failed" || status === "crashed") {
    return "n8n_execution_error";
  }

  if (status === "running" || status === "new" || status === "waiting") {
    return "n8n_execution_running";
  }

  return "n8n_execution_status";
}

function matchesExecutionByContext(execution, context) {
  const expectedRequestId = safeString(context?.requestId);
  const expectedClient = toLower(context?.client);
  const expectedConversationId = safeString(context?.conversationId);

  const sampleData = collectObjectValues(execution, 3500).join("\n").toLowerCase();

  if (expectedRequestId && sampleData.includes(expectedRequestId.toLowerCase())) {
    return true;
  }

  if (expectedConversationId && sampleData.includes(expectedConversationId.toLowerCase())) {
    if (!expectedClient) {
      return true;
    }

    if (sampleData.includes(expectedClient)) {
      return true;
    }
  }

  if (expectedClient && sampleData.includes(`"${expectedClient}"`)) {
    return true;
  }

  return false;
}

function toExecutionStatusEvent(execution, context = {}) {
  const executionData = execution?.data || execution;
  const status = deriveExecutionStatus(execution);
  const category = mapStatusToCategory(status);
  const title = mapStatusToTitle(status);
  const workflowName =
    safeString(execution?.workflowData?.name) ||
    safeString(execution?.workflowName) ||
    null;
  const workflowId =
    safeString(execution?.workflowId) || safeString(execution?.workflowData?.id) || null;
  const executionId = safeString(execution?.id) || null;
  const lastNode = pickLastExecutedNode(executionData, execution?.lastNodeExecuted);
  const nodesExecuted = countExecutedNodes(executionData);
  const likelyCause =
    status === "success"
      ? `Fluxo concluido com ${nodesExecuted} no(s) executado(s).`
      : status === "running"
        ? `Fluxo ainda em andamento (${nodesExecuted} no(s) executado(s) ate agora).`
        : status === "error" || status === "failed" || status === "crashed"
          ? "Fluxo falhou durante a execucao."
          : "A execucao foi localizada, mas sem status conclusivo.";

  const suggestion =
    status === "success"
      ? "Se o resultado final nao era esperado, abrir a execucao no n8n para validar os dados de entrada."
      : status === "running"
        ? "Aguardar finalizacao do fluxo ou consultar novamente em alguns segundos."
        : "Abrir a execucao no n8n e revisar o no com falha.";

  return {
    event_type: "execution",
    received_at: new Date().toISOString(),
    category,
    title,
    likely_cause: likelyCause,
    suggestion,
    workflow_name: workflowName,
    workflow_id: workflowId,
    execution_id: executionId,
    execution_url: null,
    failed_node: lastNode,
    n8n_http_code: null,
    error_message: null,
    error_description: null,
    upstream_messages: [],
    request_id: safeString(context?.requestId) || null,
    conversation_id: safeString(context?.conversationId) || null,
    client: toLower(context?.client) || null,
    status,
    nodes_executed: nodesExecuted,
    source: "n8n_api_poll",
  };
}

function extractExecutionsListPayload(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload?.data)) {
    return payload.data;
  }

  if (Array.isArray(payload?.items)) {
    return payload.items;
  }

  if (Array.isArray(payload?.results)) {
    return payload.results;
  }

  return [];
}

export async function reconcileExecutionFromN8n({
  config,
  context,
  lookbackLimit,
} = {}) {
  const n8nClient = createN8nClient(config);
  if (!n8nClient.enabled) {
    return {
      ok: false,
      reason: "n8n_api_not_configured",
      event: null,
    };
  }

  const limit = Math.max(5, Math.min(Number(lookbackLimit || config?.n8nExecutionLookbackLimit || 40), 100));
  const listed = await n8nClient.listExecutions({
    limit,
    includeData: true,
  });
  const executions = extractExecutionsListPayload(listed);
  if (executions.length === 0) {
    return {
      ok: false,
      reason: "no_executions_found",
      event: null,
    };
  }

  const matching = executions.find((execution) => matchesExecutionByContext(execution, context));
  if (!matching) {
    return {
      ok: false,
      reason: "execution_not_matched",
      event: null,
    };
  }

  const executionId = safeString(matching?.id);
  let detailedExecution = matching;

  if (executionId) {
    try {
      const executionDetails = await n8nClient.getExecution(executionId, { includeData: true });
      detailedExecution = extractExecutionDataEnvelope(executionDetails);
    } catch {
      detailedExecution = matching;
    }
  }

  const event = toExecutionStatusEvent(detailedExecution, context);
  return {
    ok: true,
    reason: "execution_reconciled",
    event,
  };
}

export async function scheduleExecutionReconciliation({
  config,
  context,
  onEvent,
  onFailure,
} = {}) {
  const enabled = Boolean(config?.n8nReconcileEnabled);
  if (!enabled) {
    return;
  }

  const delays = asArray(config?.n8nReconcileDelaysMs);
  if (delays.length === 0) {
    return;
  }

  for (const rawDelay of delays) {
    const delay = Number(rawDelay);
    if (!Number.isInteger(delay) || delay <= 0) {
      continue;
    }

    setTimeout(async () => {
      try {
        const result = await reconcileExecutionFromN8n({
          config,
          context,
          lookbackLimit: config?.n8nExecutionLookbackLimit,
        });

        if (result.ok && result.event && typeof onEvent === "function") {
          onEvent(result.event);
        }
      } catch (error) {
        if (typeof onFailure === "function") {
          onFailure(error);
        }
      }
    }, delay);
  }
}
