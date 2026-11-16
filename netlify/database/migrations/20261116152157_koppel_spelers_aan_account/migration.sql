ALTER TABLE "spelers" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "spelers" ADD CONSTRAINT "spelers_user_id_key" UNIQUE("user_id");