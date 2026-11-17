ALTER TABLE "partij_deelnemers" ADD COLUMN "betaald" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "partijen" ADD COLUMN "betaallink" text;