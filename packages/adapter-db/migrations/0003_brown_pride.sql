ALTER TABLE "runtime"."offer_events" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE INDEX "events_stats_ix" ON "runtime"."events" USING btree ("project_id","environment","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "offer_events_idem_uq" ON "runtime"."offer_events" USING btree ("project_id","environment","idempotency_key") WHERE "runtime"."offer_events"."kind" = 'impression' and "runtime"."offer_events"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "offer_events_stats_ix" ON "runtime"."offer_events" USING btree ("project_id","environment","offer_id","kind");--> statement-breakpoint
CREATE INDEX "unlocks_stats_ix" ON "runtime"."unlocks" USING btree ("project_id","environment","achievement_id");