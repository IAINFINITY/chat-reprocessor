-- Harden RLS for companies config table
-- This table was added after baseline RLS migration.

ALTER TABLE IF EXISTS public."REPROCESSAMENTO - companies" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF to_regclass('public."REPROCESSAMENTO - companies"') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE public."REPROCESSAMENTO - companies" FROM anon, authenticated';
  END IF;
END
$$;

DROP POLICY IF EXISTS "companies_authenticated_select" ON public."REPROCESSAMENTO - companies";
DROP POLICY IF EXISTS "companies_authenticated_modify" ON public."REPROCESSAMENTO - companies";

-- Keep private by default. Access should happen through backend service role.
