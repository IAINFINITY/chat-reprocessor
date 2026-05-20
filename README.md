# Chatwoot Reprocess Helper

Servico Node.js para facilitar reprocessamento manual de conversas do Chatwoot.

## Stack atual

- Backend: Node.js puro (`node:http`), sem Express.
- Frontend: HTML estatico servido em `public/index.html`.

## Fluxo novo (preview + execute)

1. Usuario cola o link da conversa.
2. Usuario seleciona o cliente (ou usa deteccao automatica por `account_id`).
3. Backend consulta Chatwoot.
4. Backend valida a ultima mensagem da conversa (precisa ser do usuario).
5. Backend monta payload.
6. Frontend mostra JSON para revisao.
7. Usuario clica em reprocessar.
8. Backend envia payload para o webhook configurado.

## Variaveis de ambiente

Base Chatwoot:

- `CHATWOOT_BASE_URL`
- `CHATWOOT_API_ACCESS_TOKEN`
- `PORT` (opcional, default `3000`)

Clientes para reprocessamento:

- `REPROCESS_CLIENTS=n8n,cliente2`
- `CLIENT_N8N_NAME=N8N`
- `CLIENT_N8N_REPROCESS_WEBHOOK=https://...`
- `CLIENT_N8N_WEBHOOK_SECRET=...` (opcional)
- `CLIENT_N8N_WEBHOOK_SECRET_HEADER=x-reprocess-secret` (opcional)
- `CLIENT_N8N_CHATWOOT_ACCOUNT_IDS=12,21` (opcional, para deteccao automatica)
- `CLIENT_N8N_PAYLOAD_BUILDER=n8n` (opcional: `default` ou `n8n`)

## Endpoints novos

- `GET /api/reprocess/clients`
- `POST /api/reprocess/preview`
- `POST /api/reprocess/execute`

### Preview

`POST /api/reprocess/preview`

Body:

```json
{
  "conversationUrl": "https://chat.seudominio.com/app/accounts/12/conversations/7544",
  "client": "n8n"
}
```

Resposta:

```json
{
  "success": true,
  "client": {
    "key": "n8n",
    "name": "N8N"
  },
  "payload": {
    "message": "ultima mensagem do usuario",
    "phone": "5511999999999",
    "contact_id": 123,
    "conversation_id": 7544,
    "account_id": 12,
    "source": "manual_reprocess",
    "client": "n8n"
  },
  "conversation": {
    "account_id": 12,
    "conversation_id": 7544
  }
}
```

### Execute

`POST /api/reprocess/execute`

Body:

```json
{
  "client": "n8n",
  "payload": {
    "message": "ultima mensagem do usuario",
    "phone": "5511999999999",
    "contact_id": 123,
    "conversation_id": 7544,
    "account_id": 12,
    "source": "manual_reprocess",
    "client": "n8n"
  }
}
```

Resposta:

```json
{
  "success": true,
  "message": "Reprocessamento enviado com sucesso."
}
```

## Erros tratados no fluxo novo

- link invalido;
- conversa nao encontrada;
- nenhuma mensagem encontrada;
- ultima mensagem nao ser do usuario;
- erro ao consultar Chatwoot;
- erro ao chamar webhook;
- webhook/cliente nao configurado.

## Compatibilidade

As rotas antigas (`/reprocess`, `/empresas`, `/conversation-context`) foram mantidas.

- Nessas rotas legadas, o arquivo lido em runtime e `empresas.txt` (local, nao versionado).
- O arquivo `empresas-webhooks.json` nao e usado no fluxo atual.

## Executar localmente

```bash
npm run dev
```
