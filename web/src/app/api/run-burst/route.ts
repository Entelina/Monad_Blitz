import { NextResponse } from "next/server";
import { executeSingleCheck, type CheckExecutionResult } from "@/lib/runner";
import { PatchId, TEST_SUITE_SPEC } from "@/lib/suite";
import { submitBurstChecksOnchain } from "@/lib/verifier";

export const dynamic = "force-dynamic";

/**
 * Monad Pipeline Burst Endpoint:
 * Runs all tests inside isolated node:vm (~20ms total), stops at the first failure if any,
 * and concurrently pipelines all signed transactions with strictly incrementing nonces
 * into Monad Testnet's 300ms slots!
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const taskId = body.taskId as `0x${string}`;
    const patchId: PatchId = body.patchId === "patch-fail" ? "patch-fail" : "patch-pass";
    const mode: "direct" | "eip712" = body.mode === "eip712" ? "eip712" : "direct";

    if (!taskId || !taskId.startsWith("0x") || taskId.length !== 66) {
      return NextResponse.json({ error: "Invalid taskId" }, { status: 400 });
    }

    // 1. Run real sandboxed tests up to first failure (or all 16 if all pass)
    const tSandbox0 = performance.now();
    const executions: CheckExecutionResult[] = [];
    for (let i = 0; i < TEST_SUITE_SPEC.length; i++) {
      const r = executeSingleCheck(patchId, i);
      executions.push(r);
      if (!r.passed) break;
    }
    const sandboxTotalMs = Number((performance.now() - tSandbox0).toFixed(2));

    // 2. Pipeline all checks concurrently via strictly incrementing nonces on Monad Testnet
    const burst = await submitBurstChecksOnchain({
      taskId,
      mode,
      checks: executions.map((e) => ({
        checkIndex: e.checkIndex,
        passed: e.passed,
        runHash: e.runHash,
        receiptHash: e.receiptHash,
      })),
    });

    return NextResponse.json({
      ok: true,
      patchId,
      mode,
      sandboxTotalMs,
      broadcastMs: burst.broadcastMs,
      allConfirmedMs: burst.allConfirmedMs,
      spannedBlocks: burst.spannedBlocks,
      halted: executions.some((e) => !e.passed),
      items: executions.map((exec, idx) => ({
        execution: exec,
        attested: {
          passed: exec.passed,
          receiptHash: exec.receiptHash,
        },
        chain: burst.results[idx],
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
