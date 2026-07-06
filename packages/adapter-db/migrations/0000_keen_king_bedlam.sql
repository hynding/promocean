CREATE SCHEMA "runtime";
--> statement-breakpoint
CREATE TABLE "runtime"."achievement_progress" (
	"project_id" text NOT NULL,
	"environment" text NOT NULL,
	"user_id" text NOT NULL,
	"achievement_id" text NOT NULL,
	"current" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime"."events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"environment" text NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime"."monthly_active_users" (
	"project_id" text NOT NULL,
	"environment" text NOT NULL,
	"month" text NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime"."unlocks" (
	"project_id" text NOT NULL,
	"environment" text NOT NULL,
	"user_id" text NOT NULL,
	"achievement_id" text NOT NULL,
	"unlocked_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime"."usage_counters" (
	"project_id" text NOT NULL,
	"environment" text NOT NULL,
	"month" text NOT NULL,
	"events_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "progress_uq" ON "runtime"."achievement_progress" USING btree ("project_id","environment","user_id","achievement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "events_idem_uq" ON "runtime"."events" USING btree ("project_id","environment","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "mau_uq" ON "runtime"."monthly_active_users" USING btree ("project_id","environment","month","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "unlocks_uq" ON "runtime"."unlocks" USING btree ("project_id","environment","user_id","achievement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_uq" ON "runtime"."usage_counters" USING btree ("project_id","environment","month");