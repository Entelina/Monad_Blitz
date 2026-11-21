import { NextResponse } from "next/server";
import { TASKRAIL_ABI } from "@/lib/abi";
import { getContractAddress, getPublicClient } from "@/lib/chain";
import { executeSingleCheck, resolveMutationsByRunHash } from "@/lib/runner";
import { disputeDemoCheckOnchain } from "@/lib/verifier";

export const dynamic = "force-dynamic";

/**
 * Independent same-runHash re-run verifier & optional onchain dispute trigger.
 * Reverses the exact whitelisted mutation set purely from onchain `runHash` (across all 16 combinations),
 * re-executes the sandboxed check from scratch, and compares receiptHashes byte-for-byte.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const taskId = body.taskId as `0x${string}`;
    const checkIndex = Number(body.checkIndex);
    const submitDispute = Boolean(body.submitDispute);

    if (!taskId || !taskId.startsWith("0x") || taskId.length !== 66) {
      return NextResponse.json({ error: "Invalid taskId" }, { status: 400 });
    }

    const contractAddress = getContractAddress();
    const publicClient = getPublicClient();

    const [task, checks] = await Promise.all([
      publicClient.readContract({
        address: contractAddress,
        abi: TASKRAIL_ABI,
        functionName: "getTask",
        args: [taskId],
      }),
      publicClient.readContract({
        address: contractAddress,
        abi: TASKRAIL_ABI,
        functionName: "getAllChecks",
        args: [taskId],
      }),
    ]);

    const matchedMutations = resolveMutationsByRunHash(task.runHash);
    if (!matchedMutations) {
      return NextResponse.json(
        { error: "Onchain runHash does not match any whitelisted mutation combination" },
        { status: 404 }
      );
    }

    const idx = Number.isInteger(checkIndex) ? checkIndex : Math.max(0, checks.length - 1);
    const onchainRec = checks[idx];
    if (!onchainRec) {
      return NextResponse.json(
        { error: `Check #${idx} not recorded onchain yet` },
        { status: 400 }
      );
    }

    const rerun = executeSingleCheck(matchedMutations, idx);
    const receiptMatches =
      rerun.receiptHash.toLowerCase() === onchainRec.receiptHash.toLowerCase();
    const passedMatches = rerun.passed === onchainRec.passed;
    const conflict = !receiptMatches || !passedMatches;

    let disputeTx = null;
    if (submitDispute && conflict) {
      disputeTx = await disputeDemoCheckOnchain({
        taskId,
        checkIndex: idx,
        counterReceiptHash: rerun.receiptHash,
        reason: `Independent re-run on runHash ${task.runHash.slice(0, 10)}... returned passed=${rerun.passed} (onchain=${onchainRec.passed})`,
      });
    }

    return NextResponse.json({
      ok: true,
      mutations: matchedMutations,
      runHash: task.runHash,
      checkIndex: idx,
      onchain: {
        passed: onchainRec.passed,
        receiptHash: onchainRec.receiptHash,
        disputed: onchainRec.disputed,
      },
      rerun: {
        passed: rerun.passed,
        receiptHash: rerun.receiptHash,
        stdout: rerun.stdout,
        durationMs: rerun.durationMs,
      },
      conflict,
      disputeTx,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
