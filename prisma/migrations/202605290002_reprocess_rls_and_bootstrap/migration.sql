-- RLS baseline for REPROCESSAMENTO tables
-- Strategy:
-- 1) Enable RLS on all operational tables
-- 2) Keep tables private by default (no broad policies for anon/authenticated)
-- 3) Allow authenticated users to read only their own row in allowed_users
-- 4) Seed initial admin allowlist user (idempotent upsert)

ALTER TABLE public."REPROCESSAMENTO - allowed_users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."REPROCESSAMENTO - auth_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."REPROCESSAMENTO - auth_audit_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."REPROCESSAMENTO - n8n_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."REPROCESSAMENTO - reprocess_executions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."REPROCESSAMENTO - queue_items" ENABLE ROW LEVEL SECURITY;

-- Remove accidental broad grants (hardening)
REVOKE ALL ON TABLE public."REPROCESSAMENTO - allowed_users" FROM anon, authenticated;
REVOKE ALL ON TABLE public."REPROCESSAMENTO - auth_sessions" FROM anon, authenticated;
REVOKE ALL ON TABLE public."REPROCESSAMENTO - auth_audit_events" FROM anon, authenticated;
REVOKE ALL ON TABLE public."REPROCESSAMENTO - n8n_events" FROM anon, authenticated;
REVOKE ALL ON TABLE public."REPROCESSAMENTO - reprocess_executions" FROM anon, authenticated;
REVOKE ALL ON TABLE public."REPROCESSAMENTO - queue_items" FROM anon, authenticated;

DROP POLICY IF EXISTS "allowed_users_read_own_active" ON public."REPROCESSAMENTO - allowed_users";
CREATE POLICY "allowed_users_read_own_active"
ON public."REPROCESSAMENTO - allowed_users"
FOR SELECT
TO authenticated
USING (
  active = true
  AND lower(email) = lower(coalesce((auth.jwt() ->> 'email'), ''))
);

-- Bootstrap first admin user in allowlist
INSERT INTO public."REPROCESSAMENTO - allowed_users" (
  id,
  email,
  active,
  role,
  notes,
  created_at,
  updated_at
)
VALUES (
  'bootstrap-franciscoaneto15-gmail-com',
  'franciscoaneto15@gmail.com',
  true,
  'admin'::public.reprocess_auth_role,
  'bootstrap admin',
  now(),
  now()
)
ON CONFLICT (email)
DO UPDATE SET
  active = EXCLUDED.active,
  role = EXCLUDED.role,
  updated_at = now();
