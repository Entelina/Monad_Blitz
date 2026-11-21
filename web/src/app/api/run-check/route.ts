import { NextResponse } from "next/server";
import { encodePacked, keccak256 } from "viem";
import { executeSingleCheck } from "@/lib/runner";
import { PatchId } from "@/lib/suite";
import { submitCheckOnchain } from "@/lib/verifier";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const taskId = body.taskId as `0x${string}`;
    const patchId: PatchId = body.patchId === "patch-fail" ? "patch-fail" : "patch-pass";
    const checkIndex = Number(body.checkIndex);
    const mode: "direct" | "eip712" = body.mode === "eip712" ? "eip712" : "direct";
    const simulateDishonest = Boolean(body.simulateDishonest);

    if (!taskId || !taskId.startsWith("0x") || taskId.length !== 66) {
      return NextResponse.json({ error: "Invalid taskId" }, { status: 400 });
    }
    if (!Number.isInteger(checkIndex) || checkIndex < 0 || checkIndex > 15) {
      return NextResponse.json({ error: "Invalid checkIndex (0..15)" }, { status: 400 });
    }

    // 1. Execute the real sandboxed test inside isolated node:vm
    const execResult = executeSingleCheck(patchId, checkIndex);

    // Optional demo toggle: intentionally submit a forged PASS on a failing test
    // so judges can watch the same-runHash independent re-run catch & dispute it onchain!
    const attestedPassed = simulateDishonest ? true : execResult.passed;
    const attestedReceiptHash = simulateDishonest
      ? keccak256(encodePacked(["bytes32", "string"], [execResult.receiptHash, "DISHONEST_FORGED_PASS"]))
      : execResult.receiptHash;

    // 2. Submit real transaction to Monad Testnet
    const chainResult = await submitCheckOnchain({
      taskId,
      checkIndex,
      passed: attestedPassed,
      runHash: execResult.runHash,
      receiptHash: attestedReceiptHash,
      mode,
    });

    return NextResponse.json({
      ok: true,
      simulatedDishonest: simulateDishonest,
      execution: execResult,
      attested: {
        passed: attestedPassed,
        receiptHash: attestedReceiptHash,
      },
      chain: chainResult,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
