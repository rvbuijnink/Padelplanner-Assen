-- 06-nummers van medespelers verdwijnen meteen na afloop van de partij (begin + speelduur),
-- in plaats van pas een dag na de partij. Eigen nummer blijft altijd zichtbaar.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'padel_lezer') THEN
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
          AND (p."datum" + p."tijd"::time + make_interval(mins => p."duur")) > (now() AT TIME ZONE 'Europe/Amsterdam')
      )
    );
  END IF;
EXCEPTION WHEN others THEN
  -- Lukt het niet, dan wordt alles in dit blok teruggedraaid en blijft de oude regel staan.
  RAISE WARNING 'telefoons_medespelers kon niet worden bijgewerkt: %', SQLERRM;
END $$;
