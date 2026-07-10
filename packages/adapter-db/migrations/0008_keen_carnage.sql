DROP INDEX "runtime"."event_notif_uq";--> statement-breakpoint
ALTER TABLE "runtime"."timed_event_notifications" ADD COLUMN "occurrence_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "event_notif_uq" ON "runtime"."timed_event_notifications" USING btree ("project_id","event_id","occurrence_key","transition");