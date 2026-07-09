-- Custom SQL migration file, put your code below! --
-- Backfill delivered_at for pre-existing claims created before migration 0004
-- introduced delivered_at/attempts. Without this, every historical claim row
-- has delivered_at = NULL, causing the scheduler to re-drive (duplicate
-- webhooks) or dead-letter ('<unresolvable>') all pre-existing rows on the
-- first tick after upgrade.
UPDATE "runtime"."timed_event_notifications" SET "delivered_at" = "fired_at" WHERE "delivered_at" IS NULL;