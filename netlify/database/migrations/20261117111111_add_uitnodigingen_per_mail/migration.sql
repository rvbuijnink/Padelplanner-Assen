ALTER TABLE "partij_deelnemers" ADD COLUMN "status" text DEFAULT 'bevestigd' NOT NULL;--> statement-breakpoint
ALTER TABLE "partij_deelnemers" ADD COLUMN "token" text;--> statement-breakpoint
ALTER TABLE "partij_deelnemers" ADD COLUMN "uitgenodigd" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "partij_deelnemers" ADD COLUMN "herinnerd" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "partijen" ADD COLUMN "automatisch" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "partijen" ADD COLUMN "boeker_id" integer;--> statement-breakpoint
ALTER TABLE "partijen" ADD COLUMN "compleet_gemeld" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "spelers" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "spelers" ADD COLUMN "mail_aan" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "partij_deelnemers" ADD CONSTRAINT "partij_deelnemers_token_key" UNIQUE("token");--> statement-breakpoint
ALTER TABLE "partijen" ADD CONSTRAINT "partijen_boeker_id_spelers_id_fkey" FOREIGN KEY ("boeker_id") REFERENCES "spelers"("id") ON DELETE SET NULL;