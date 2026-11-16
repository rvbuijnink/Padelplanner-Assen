CREATE TABLE "beschikbaarheid" (
	"speler_id" integer,
	"week" date,
	"tijdvakken" jsonb NOT NULL,
	"bijgewerkt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "beschikbaarheid_pkey" PRIMARY KEY("speler_id","week")
);
--> statement-breakpoint
CREATE TABLE "spelers" (
	"id" serial PRIMARY KEY,
	"slug" text NOT NULL UNIQUE,
	"naam" text NOT NULL,
	"niveau" text NOT NULL,
	"wens_niveaus" jsonb NOT NULL,
	"duren" jsonb NOT NULL,
	"frequentie" text NOT NULL,
	"club_voorkeur" jsonb DEFAULT '{}' NOT NULL,
	"bijgewerkt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "beschikbaarheid" ADD CONSTRAINT "beschikbaarheid_speler_id_spelers_id_fkey" FOREIGN KEY ("speler_id") REFERENCES "spelers"("id") ON DELETE CASCADE;