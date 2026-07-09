CREATE TABLE "runtime"."points_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"environment" text NOT NULL,
	"user_id" text NOT NULL,
	"delta" integer NOT NULL,
	"source" text NOT NULL,
	"source_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime"."user_streaks" (
	"project_id" text NOT NULL,
	"environment" text NOT NULL,
	"user_id" text NOT NULL,
	"current_streak" integer DEFAULT 0 NOT NULL,
	"longest_streak" integer DEFAULT 0 NOT NULL,
	"last_active_day" date,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "points_ledger_user_ix" ON "runtime"."points_ledger" USING btree ("project_id","environment","user_id");--> statement-breakpoint
CREATE INDEX "points_ledger_window_ix" ON "runtime"."points_ledger" USING btree ("project_id","environment","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_streaks_uq" ON "runtime"."user_streaks" USING btree ("project_id","environment","user_id");