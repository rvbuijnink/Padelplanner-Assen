-- 06-nummers: row level security in de database.
-- De site leest nummers altijd als de beperkte rol "padel_lezer" (SET LOCAL ROLE binnen een transactie),
-- met het id van de ingelogde speler in de instelling "padel.speler_id". De policy hieronder bepaalt welke rijen die ziet:
--   - je eigen nummer;
--   - het nummer van een speler die net als jij heeft bevestigd voor dezelfde partij, die niet is geannuleerd,
--     tot en met een dag na de partij.
ALTER TABLE "telefoons" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "telefoons" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'padel_lezer') THEN
    CREATE ROLE padel_lezer NOLOGIN NOBYPASSRLS;
  END IF;
  EXECUTE format('GRANT padel_lezer TO %I', current_user);
  GRANT USAGE ON SCHEMA public TO padel_lezer;
  GRANT SELECT ON "telefoons", "partij_deelnemers", "partijen" TO padel_lezer;
  DROP POLICY IF EXISTS telefoons_medespelers ON "telefoons";
  CREATE POLICY telefoons_medespelers ON "telefoons" FOR SELECT TO padel_lezer USING (
    "speler_id" = nullif(current_setting('padel.speler_id', true), '')::int
    OR EXISTS (
      SELECT 1
      FROM "partij_deelnemers" mij
      JOIN "partij_deelnemers" ander ON ander."partij_id" = mij."partij_id"
      JOIN "partijen" p ON p."id" = mij."partij_id"
      WHERE mij."speler_id" = nullif(current_setting('padel.speler_id', true), '')::int
        AND mij."status" = 'bevestigd'
        AND ander."speler_id" = "telefoons"."speler_id"
        AND ander."status" = 'bevestigd'
        AND NOT p."geannuleerd"
        AND p."datum" >= ((now() AT TIME ZONE 'Europe/Amsterdam')::date - 1)
    )
  );
EXCEPTION WHEN others THEN
  -- Lukt het niet om de rol te maken, dan blijft de tabel dicht: de site toont dan geen nummers (veilig).
  RAISE WARNING 'padel_lezer kon niet worden ingesteld: %', SQLERRM;
END $$;
