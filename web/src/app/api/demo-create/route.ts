import { NextResponse } from "next/server";
import { computeCommitAndRunHash } from "@/lib/runner";
import { PatchId, resolveMutations } from "@/lib/suite";
import { createDemoTaskOnchain } from "@/lib/verifier";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const patchId: PatchId | undefined =
      body.patchId === "patch-fail" || body.patchId === "patch-pass"
        ? body.patchId
        : undefined;
    const mutations = resolveMutations(patchId, body.mutations);
    const rewardMon = typeof body.rewardMon === "string" ? body.rewardMon : "1.6";
    const totalChecks = Number(body.totalChecks) || 16;
    const finalBonusBps = Number(body.finalBonusBps ?? 4000);

    const rewardNum = Number(rewardMon);
    if (!Number.isFinite(rewardNum) || rewardNum <= 0 || rewardNum > 3) {
      return NextResponse.json(
        { error: "Demo reward must be between 0.05 and 3.0 MON" },
        { status: 400 }
      );
    }

    const { runHash, commit } = computeCommitAndRunHash(mutations);
    const label = mutations.length === 0 ? "clean" : mutations.join("+");
    const created = await createDemoTaskOnchain({
      label,
      totalChecks,
      finalBonusBps,
      rewardMon,
      runHash,
    });

    return NextResponse.json({ ok: true, mutations, commit, runHash, ...created });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
