import { parseJsonSafe, pickUpstreamMessage, truncateText } from "./common.js";

export function classifyWebhookFailure({ statusCode, responseBody }) {
  const parsed = parseJsonSafe(responseBody);
  const upstreamMessage = pickUpstreamMessage(parsed, responseBody);
  const normalized = `${statusCode} ${upstreamMessage}`.toLowerCase();

  let category = "upstream_workflow_error";
  let title = "Erro no workflow remoto";
  let likelyCause =
    "O n8n recebeu a chamada, mas ocorreu erro interno durante o processamento do fluxo.";
  let suggestion =
    "Verifique no n8n qual nó falhou nessa execução e ajuste tratamento/fallback do fluxo.";

  if (normalized.includes("supabase") && /(pause|paused|suspend|inativ|disabled)/.test(normalized)) {
    category = "supabase_ai_paused";
    title = "Supabase/IA pausada";
    likelyCause = "O fluxo indica que a automação/IA no Supabase está pausada ou indisponível.";
    suggestion = "Reativar o status da IA no Supabase e testar novamente.";
  } else if (normalized.includes("variable") && normalized.includes("not found")) {
    category = "workflow_variable_not_found";
    title = "Variável ausente no fluxo";
    likelyCause = "O fluxo tentou usar uma variável que não existe no contexto desta execução.";
    suggestion = "Revisar o nó com erro e validar nomes/caminhos de variáveis no n8n.";
  } else if (normalized.includes("dify") && /(unavailable|timeout|refused|down|503|504|502|failed)/.test(normalized)) {
    category = "dify_unavailable";
    title = "Dify indisponível";
    likelyCause = "O workflow não conseguiu acessar o Dify (queda, timeout ou indisponibilidade).";
    suggestion = "Validar status do Dify e conectividade do ambiente n8n para o endpoint do Dify.";
  } else if (
    normalized.includes("openai") &&
    /(invalid_api_key|api key|unauthorized|401|insufficient_quota|quota|billing|credit)/.test(normalized)
  ) {
    category = "openai_auth_or_quota";
    title = "OpenAI sem token/crédito";
    likelyCause = "Erro de autenticação ou de quota/crédito da OpenAI no fluxo remoto.";
    suggestion = "Conferir chave da OpenAI no n8n e saldo/quota da conta.";
  } else if (statusCode === 404) {
    category = "webhook_not_found";
    title = "Webhook não encontrado";
    likelyCause = "A URL de webhook pode estar incorreta, desativada ou removida no n8n.";
    suggestion = "Validar URL configurada para a empresa e confirmar que o workflow/webhook está ativo.";
  } else if (statusCode === 401 || statusCode === 403) {
    category = "webhook_auth_error";
    title = "Falha de autenticação no webhook";
    likelyCause = "O webhook rejeitou a chamada por token/header inválido.";
    suggestion = "Conferir headers de secret/HMAC esperados pelo workflow.";
  }

  return {
    category,
    title,
    likely_cause: likelyCause,
    suggestion,
    status_code: statusCode,
    upstream_message: upstreamMessage,
    upstream_body_excerpt: truncateText(responseBody, 1200),
  };
}

export function detectLogicalFailureInSuccessResponse(responseText) {
  const parsed = parseJsonSafe(responseText);
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const statusFromBody = Number(parsed?.status || parsed?.status_code || parsed?.error?.status || 0);
  const code = String(parsed?.code || parsed?.error?.code || "").toLowerCase();
  const message = String(
    parsed?.message || parsed?.error?.message || parsed?.description || "",
  ).toLowerCase();
  const successFlag = parsed?.success;

  if (statusFromBody >= 400) {
    return {
      statusCode: statusFromBody,
      reason: "status_code_in_body",
    };
  }

  if (successFlag === false) {
    return {
      statusCode: 422,
      reason: "success_false_in_body",
    };
  }

  if (code && /(invalid_param|error|failed|fail|exception)/.test(code)) {
    return {
      statusCode: 422,
      reason: "error_code_in_body",
    };
  }

  if (/run failed|variable .* not found|bad request|invalid_param/.test(message)) {
    return {
      statusCode: 422,
      reason: "error_message_in_body",
    };
  }

  return null;
}

export function classifyNetworkFailure(error, timeoutMs) {
  const isTimeout = error?.name === "AbortError";
  const code = error?.code || error?.cause?.code || "";
  const causeMessage = error?.cause?.message || error?.message || "falha de rede";
  const normalized = `${code} ${causeMessage}`.toLowerCase();

  let category = "network_error";
  let title = "Falha de rede ao chamar webhook";
  let likelyCause = "Não foi possível estabelecer comunicação com o endpoint remoto.";
  let suggestion = "Validar DNS/rede/firewall e disponibilidade do domínio do webhook.";

  if (isTimeout) {
    category = "network_timeout";
    title = "Timeout na chamada do webhook";
    likelyCause = `O endpoint não respondeu dentro de ${timeoutMs}ms.`;
    suggestion = "Aumentar timeout ou ajustar o workflow para responder mais rápido.";
  } else if (normalized.includes("enotfound") || normalized.includes("eai_again")) {
    category = "dns_resolution_error";
    title = "Falha de DNS";
    likelyCause = "O host do webhook não foi resolvido neste ambiente.";
    suggestion = "Checar DNS/rede local e disponibilidade do domínio.";
  } else if (normalized.includes("econnrefused")) {
    category = "connection_refused";
    title = "Conexão recusada";
    likelyCause = "O host respondeu recusando conexão na porta alvo.";
    suggestion = "Verificar se o serviço de destino está ativo e aceitando conexões HTTPS.";
  } else if (normalized.includes("econnreset") || normalized.includes("socket")) {
    category = "connection_reset";
    title = "Conexão encerrada pelo servidor";
    likelyCause = "A conexão foi encerrada no meio da requisição (proxy/WAF/upstream).";
    suggestion = "Verificar logs do Cloudflare/proxy/n8n para reset de conexão.";
  }

  return {
    category,
    title,
    likely_cause: likelyCause,
    suggestion,
    error_code: code || null,
    error_message: String(error?.message || "erro de rede"),
    error_cause: causeMessage,
    is_timeout: isTimeout,
  };
}
