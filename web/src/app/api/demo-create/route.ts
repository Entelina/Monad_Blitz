import { NextResponse } from "next/server";
import { computeRunHash } from "@/lib/runner";
import { PatchId } from "@/lib/suite";
import { createDemoTaskOnchain } from "@/lib/verifier";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const patchId: PatchId = body.patchId === "patch-fail" ? "patch-fail" : "patch-pass";
    const rewardMon = typeof body.rewardMon === "string" ? body.rewardMon : "0.8";
    const totalChecks = Number(body.totalChecks) || 16;
    const finalBonusBps = Number(body.finalBonusBps ?? 4000);

    // Guard demo faucet wallet against accidental huge locks
    const rewardNum = Number(rewardMon);
    if (!Number.isFinite(rewardNum) || rewardNum <= 0 || rewardNum > 3) {
      return NextResponse.json(
        { error: "Demo reward must be between 0.05 and 3.0 MON" },
        { status: 400 }
      );
    }

    const runHash = computeRunHash(patchId);
    const created = await createDemoTaskOnchain({
      label: patchId,
      totalChecks,
      finalBonusBps,
      rewardMon,
      runHash,
    });

    return NextResponse.json({ ok: true, patchId, runHash, ...created });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
