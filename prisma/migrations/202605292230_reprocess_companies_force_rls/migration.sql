-- Final hardening for companies table in case previous migration did not apply

ALTER TABLE IF EXISTS public."REPROCESSAMENTO - companies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."REPROCESSAMENTO - companies" FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."REPROCESSAMENTO - companies" FROM anon, authenticated;

DROP POLICY IF EXISTS "companies_authenticated_select" ON public."REPROCESSAMENTO - companies";
DROP POLICY IF EXISTS "companies_authenticated_modify" ON public."REPROCESSAMENTO - companies";
DROP POLICY IF EXISTS "companies_public_read" ON public."REPROCESSAMENTO - companies";
DROP POLICY IF EXISTS "companies_public_all" ON public."REPROCESSAMENTO - companies";
