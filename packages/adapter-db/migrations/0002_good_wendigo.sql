CREATE TABLE "runtime"."timed_event_notifications" (
	"project_id" text NOT NULL,
	"event_id" text NOT NULL,
	"transition" text NOT NULL,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime"."webhook_dead_letters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"url" text NOT NULL,
	"payload" text NOT NULL,
	"error" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "event_notif_uq" ON "runtime"."timed_event_notifications" USING btree ("project_id","event_id","transition");