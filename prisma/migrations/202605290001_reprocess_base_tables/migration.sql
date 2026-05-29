-- Reprocessador base schema for Supabase (PostgreSQL)
-- Naming standard: all operational tables start with "REPROCESSAMENTO - "

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'reprocess_auth_role') THEN
    CREATE TYPE public.reprocess_auth_role AS ENUM ('admin', 'operator');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'reprocess_status') THEN
    CREATE TYPE public.reprocess_status AS ENUM ('pending', 'running', 'success', 'warning', 'error', 'canceled', 'timeout');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'reprocess_n8n_event_type') THEN
    CREATE TYPE public.reprocess_n8n_event_type AS ENUM ('error', 'status', 'execution');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public."REPROCESSAMENTO - allowed_users" (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  role public.reprocess_auth_role NOT NULL DEFAULT 'operator',
  display_name text NULL,
  notes text NULL,
  last_login_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reprocess_allowed_users_active_role
  ON public."REPROCESSAMENTO - allowed_users" (active, role);

CREATE TABLE IF NOT EXISTS public."REPROCESSAMENTO - auth_sessions" (
  sid text PRIMARY KEY,
  user_id text NULL,
  email text NOT NULL,
  role public.reprocess_auth_role NOT NULL DEFAULT 'operator',
  ip text NULL,
  user_agent text NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NULL,
  last_seen_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reprocess_auth_sessions_email
  ON public."REPROCESSAMENTO - auth_sessions" (email);
CREATE INDEX IF NOT EXISTS idx_reprocess_auth_sessions_expires_at
  ON public."REPROCESSAMENTO - auth_sessions" (expires_at);
CREATE INDEX IF NOT EXISTS idx_reprocess_auth_sessions_revoked_at
  ON public."REPROCESSAMENTO - auth_sessions" (revoked_at);

CREATE TABLE IF NOT EXISTS public."REPROCESSAMENTO - auth_audit_events" (
  id text PRIMARY KEY,
  event_type text NOT NULL,
  outcome text NOT NULL,
  reason text NULL,
  email text NULL,
  role text NULL,
  session_id text NULL,
  ip text NULL,
  user_agent text NULL,
  request_path text NULL,
  request_method text NULL,
  details jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reprocess_auth_audit_events_created_at
  ON public."REPROCESSAMENTO - auth_audit_events" (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reprocess_auth_audit_events_event_type_created_at
  ON public."REPROCESSAMENTO - auth_audit_events" (event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reprocess_auth_audit_events_email_created_at
  ON public."REPROCESSAMENTO - auth_audit_events" (email, created_at DESC);

CREATE TABLE IF NOT EXISTS public."REPROCESSAMENTO - n8n_events" (
  id text PRIMARY KEY,
  event_type public.reprocess_n8n_event_type NOT NULL,
  category text NOT NULL,
  title text NOT NULL,
  likely_cause text NULL,
  suggestion text NULL,
  workflow_name text NULL,
  workflow_id text NULL,
  execution_id text NULL,
  execution_url text NULL,
  failed_node text NULL,
  request_id text NULL,
  conversation_id text NULL,
  client text NULL,
  status text NULL,
  nodes_executed integer NULL,
  n8n_http_code text NULL,
  error_message text NULL,
  error_description text NULL,
  upstream_messages jsonb NULL,
  duplicate_count integer NOT NULL DEFAULT 1,
  source text NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reprocess_n8n_events_received_at
  ON public."REPROCESSAMENTO - n8n_events" (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_reprocess_n8n_events_request_id_received_at
  ON public."REPROCESSAMENTO - n8n_events" (request_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_reprocess_n8n_events_conversation_id_received_at
  ON public."REPROCESSAMENTO - n8n_events" (conversation_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_reprocess_n8n_events_client_received_at
  ON public."REPROCESSAMENTO - n8n_events" (client, received_at DESC);

CREATE TABLE IF NOT EXISTS public."REPROCESSAMENTO - reprocess_executions" (
  id text PRIMARY KEY,
  request_id text UNIQUE NULL,
  client text NOT NULL,
  account_id integer NULL,
  conversation_id integer NULL,
  contact_id integer NULL,
  phone text NULL,
  status public.reprocess_status NOT NULL DEFAULT 'pending',
  duration_ms integer NULL,
  webhook_url text NULL,
  payload_preview jsonb NULL,
  webhook_response jsonb NULL,
  error_code text NULL,
  error_message text NULL,
  n8n_execution_id text NULL,
  n8n_workflow_name text NULL,
  started_at timestamptz NULL,
  finished_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reprocess_executions_client_created_at
  ON public."REPROCESSAMENTO - reprocess_executions" (client, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reprocess_executions_conversation_created_at
  ON public."REPROCESSAMENTO - reprocess_executions" (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reprocess_executions_status_created_at
  ON public."REPROCESSAMENTO - reprocess_executions" (status, created_at DESC);

CREATE TABLE IF NOT EXISTS public."REPROCESSAMENTO - queue_items" (
  id text PRIMARY KEY,
  request_id text NULL,
  client text NOT NULL,
  conversation_id integer NULL,
  status public.reprocess_status NOT NULL DEFAULT 'pending',
  payload jsonb NULL,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz NULL,
  finished_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reprocess_queue_items_status_enqueued_at
  ON public."REPROCESSAMENTO - queue_items" (status, enqueued_at ASC);
CREATE INDEX IF NOT EXISTS idx_reprocess_queue_items_client_enqueued_at
  ON public."REPROCESSAMENTO - queue_items" (client, enqueued_at ASC);
