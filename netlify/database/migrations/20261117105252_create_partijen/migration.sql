CREATE TABLE "partij_deelnemers" (
	"partij_id" integer,
	"speler_id" integer,
	"aangemeld" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partij_deelnemers_pkey" PRIMARY KEY("partij_id","speler_id")
);
--> statement-breakpoint
CREATE TABLE "partijen" (
	"id" serial PRIMARY KEY,
	"datum" date NOT NULL,
	"tijd" text NOT NULL,
	"duur" integer NOT NULL,
	"club_id" text NOT NULL,
	"opmerking" text DEFAULT '' NOT NULL,
	"aangemaakt_door" integer,
	"aangemaakt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "partij_deelnemers" ADD CONSTRAINT "partij_deelnemers_partij_id_partijen_id_fkey" FOREIGN KEY ("partij_id") REFERENCES "partijen"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "partij_deelnemers" ADD CONSTRAINT "partij_deelnemers_speler_id_spelers_id_fkey" FOREIGN KEY ("speler_id") REFERENCES "spelers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "partijen" ADD CONSTRAINT "partijen_aangemaakt_door_spelers_id_fkey" FOREIGN KEY ("aangemaakt_door") REFERENCES "spelers"("id") ON DELETE SET NULL;