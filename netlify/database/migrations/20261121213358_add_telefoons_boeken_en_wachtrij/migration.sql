CREATE TABLE "mail_wachtrij" (
	"id" serial PRIMARY KEY,
	"mail" jsonb NOT NULL,
	"aangemaakt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telefoons" (
	"speler_id" integer PRIMARY KEY,
	"nummer" text NOT NULL,
	"bijgewerkt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "partij_deelnemers" ADD COLUMN "reactie_tot" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "partijen" ADD COLUMN "boeken_tot" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "partijen" ADD COLUMN "baan_prijs" double precision;--> statement-breakpoint
ALTER TABLE "partijen" ADD COLUMN "afgewezen_boekers" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "partijen" ADD COLUMN "besluit" text;--> statement-breakpoint
ALTER TABLE "partijen" ADD COLUMN "keuze_gemeld" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "partijen" ADD COLUMN "beslis_gemeld" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "partijen" ADD COLUMN "overname_nodig" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "partijen" ADD COLUMN "vorige_boeker_id" integer;--> statement-breakpoint
ALTER TABLE "spelers" ADD COLUMN "boek_bereid" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "partijen" ADD CONSTRAINT "partijen_vorige_boeker_id_spelers_id_fkey" FOREIGN KEY ("vorige_boeker_id") REFERENCES "spelers"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "telefoons" ADD CONSTRAINT "telefoons_speler_id_spelers_id_fkey" FOREIGN KEY ("speler_id") REFERENCES "spelers"("id") ON DELETE CASCADE;