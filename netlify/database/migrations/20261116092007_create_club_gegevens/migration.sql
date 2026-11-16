CREATE TABLE "club_gegevens" (
	"club_id" text PRIMARY KEY,
	"prijs_60" double precision,
	"prijs_90" double precision,
	"dal_prijs_60" double precision,
	"dal_prijs_90" double precision,
	"horizon_dagen" integer NOT NULL,
	"horizon_bevestigd" boolean DEFAULT false NOT NULL,
	"opent_om" text,
	"opmerking" text DEFAULT '' NOT NULL,
	"bijgewerkt" timestamp with time zone DEFAULT now() NOT NULL
);
