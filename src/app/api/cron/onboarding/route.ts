/**
 * The onboarding tick - sends any due follow-up for every customer in a
 * sequence. The day-0 welcome is sent instantly by the payment webhook; this
 * daily job handles the later touches (day 2, day 5, …).
 *
 *   GET /api/cron/onboarding   (Authorization: Bearer <CRON_SECRET>)
 */
import { NextRequest, NextResponse } from "next/server";
import { runOnboarding } from "@/lib/onboarding";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }
  const result = await runOnboarding();
  return NextResponse.json({ ok: true, ...result });
}
