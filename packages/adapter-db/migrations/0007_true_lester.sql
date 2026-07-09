CREATE TABLE "runtime"."coupons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"environment" text NOT NULL,
	"reward_id" text NOT NULL,
	"user_id" text NOT NULL,
	"code" text NOT NULL,
	"code_shared" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'claimed' NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"redeemed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "coupons_code_uq" ON "runtime"."coupons" USING btree ("project_id","environment","code") WHERE "runtime"."coupons"."code_shared" = false;--> statement-breakpoint
CREATE INDEX "coupons_code_ix" ON "runtime"."coupons" USING btree ("project_id","environment","code");--> statement-breakpoint
CREATE INDEX "coupons_reward_ix" ON "runtime"."coupons" USING btree ("project_id","environment","reward_id");--> statement-breakpoint
CREATE INDEX "coupons_user_ix" ON "runtime"."coupons" USING btree ("project_id","environment","reward_id","user_id");