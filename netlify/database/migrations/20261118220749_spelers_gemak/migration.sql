ALTER TABLE "partijen" ADD COLUMN "dag_herinnerd" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "spelers" ADD COLUMN "herinnering_aan" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "spelers" ADD COLUMN "standaard_week" jsonb;