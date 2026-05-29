CREATE TABLE IF NOT EXISTS "REPROCESSAMENTO - companies" (
  "id" TEXT NOT NULL,
  "nome" TEXT NOT NULL,
  "nome_normalizado" TEXT NOT NULL,
  "url_webhook" TEXT NOT NULL,
  "tabela" TEXT NOT NULL,
  "chatwoot_account_ids" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "ativo" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "REPROCESSAMENTO - companies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "REPROCESSAMENTO - companies_nome_normalizado_key"
  ON "REPROCESSAMENTO - companies"("nome_normalizado");

CREATE INDEX IF NOT EXISTS "idx_reprocess_companies_ativo_nome_normalizado"
  ON "REPROCESSAMENTO - companies"("ativo", "nome_normalizado");

