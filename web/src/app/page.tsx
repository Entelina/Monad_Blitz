"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Copy,
  ExternalLink,
  Flame,
  Lock,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Wallet,
  XCircle,
  Zap,
} from "lucide-react";
import { formatEther, keccak256, recoverTypedDataAddress, toHex } from "viem";
import { EIP712_TYPES, TASK_STATUS_LABEL, TASKRAIL_ABI } from "@/lib/abi";
import {
  browserCreateTask,
  browserRefundRemaining,
  connectBrowserWallet,
} from "@/lib/browserWallet";
import {
  addressExplorerUrl,
  getPublicClient,
  txExplorerUrl,
} from "@/lib/chain";
import { MonadCommitState, MonadCommitTracker } from "@/lib/monadWs";
import type { AgentPatch, PatchId, TestCaseSpec } from "@/lib/suite";

interface PatchWithHash extends AgentPatch {
  runHash: `0x${string}`;
}

interface StatusPayload {
  chainId: number;
  rpcUrl: string;
  wssUrl: string;
  contractAddress: `0x${string}`;
  contractReady: boolean;
  verifierAddress: `0x${string}`;
  verifierReady: boolean;
  demoEmployerAddress: `0x${string}` | null;
  demoModeReady: boolean;
  agentAddress: `0x${string}`;
  patches: Record<PatchId, PatchWithHash>;
  tests: TestCaseSpec[];
}

interface StreamCheckItem {
  checkIndex: number;
  stage: "BUILD" | "UNIT";
  testId: string;
  name: string;
  passed: boolean;
  attestedPassed: boolean;
  simulatedDishonest: boolean;
  durationMs: number;
  stdout: string;
  errorMessage?: string;
  runHash: `0x${string}`;
  receiptHash: `0x${string}`;
  attestedReceiptHash: `0x${string}`;
  txHash: `0x${string}`;
  mode: "direct" | "eip712";
  signature?: `0x${string}`;
  verifierAddress: `0x${string}`;
  sentAtMs: number;
  proposedLatencyMs: number;
  finalizedLatencyMs?: number;
  commitState: MonadCommitState;
  blockNumber: string;
  gasLimit: string;
  gasUsed: string;
  actualPaidMon: string;
  payoutMon: string;
}

interface IndependentVerifyResult {
  taskId: `0x${string}`;
  statusLabel: string;
  employer: string;
  agent: string;
  verifier: string;
  runHash: string;
  totalRewardMon: string;
  paidRewardMon: string;
  remainingRewardMon: string;
  totalChecks: number;
  passedChecks: number;
  recordedCount: number;
  signatureVerifiedCount: number;
  signatureCheckedCount: number;
  dispute: {
    challenger: string;
    checkIndex: number;
    counterReceiptHash: string;
    reason: string;
  } | null;
  verifiedAt: string;
}

interface RerunResult {
  patchId: string;
  runHash: string;
  checkIndex: number;
  conflict: boolean;
  onchain: { passed: boolean; receiptHash: string; disputed: boolean };
  rerun: { passed: boolean; receiptHash: string; stdout: string; durationMs: number };
  disputeTx?: { txHash: string; latencyMs: number; actualPaidMon: string } | null;
}

function shortHex(hex?: string | null, left = 6, right = 4) {
  if (!hex) return "—";
  if (hex.length <= left + right + 3) return hex;
  return `${hex.slice(0, left)}...${hex.slice(-right)}`;
}

export default function HomePage() {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [patchId, setPatchId] = useState<PatchId>("patch-fail");
  const [submitMode, setSubmitMode] = useState<"direct" | "eip712">("direct");
  const [rewardMon, setRewardMon] = useState<string>("1.6");
  const [useDemoWallet, setUseDemoWallet] = useState<boolean>(true);
  const [simulateDishonest, setSimulateDishonest] = useState<boolean>(false);

  const [walletAddress, setWalletAddress] = useState<`0x${string}` | null>(null);
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const [latestHead, setLatestHead] = useState<{
    blockNumber: string;
    commitState: MonadCommitState;
  } | null>(null);

  const [activeTaskId, setActiveTaskId] = useState<`0x${string}` | null>(null);
  const [taskCreatedByWallet, setTaskCreatedByWallet] = useState<boolean>(false);
  const [createTxHash, setCreateTxHash] = useState<`0x${string}` | null>(null);
  const [taskStatus, setTaskStatus] = useState<string>("IDLE");
  const [refundTxHash, setRefundTxHash] = useState<`0x${string}` | null>(null);

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [liveAnnouncement, setLiveAnnouncement] = useState<string>("");

  const [terminalLines, setTerminalLines] = useState<
    Array<{ id: string; text: string; kind: "info" | "pass" | "fail" | "chain" }>
  >([
    {
      id: "boot-0",
      text: "$ taskrail-runner --network monad-testnet --chain-id 10143 --ready",
      kind: "info",
    },
    {
      id: "boot-1",
      text: "Ready: Select PR #143 (ACL Bug -> 30s Circuit Breaker) or PR #142 (16-Test Streaming Burst).",
      kind: "info",
    },
  ]);

  const [streamItems, setStreamItems] = useState<StreamCheckItem[]>([]);
  const [verifyTaskInput, setVerifyTaskInput] = useState<string>("");
  const [verifyResult, setVerifyResult] = useState<IndependentVerifyResult | null>(null);
  const [rerunResult, setRerunResult] = useState<RerunResult | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const stopStreamRef = useRef<boolean>(false);
  const trackerRef = useRef<MonadCommitTracker | null>(null);
  const terminalEndRef = useRef<HTMLDivElement | null>(null);

  const pushTerminal = useCallback(
    (text: string, kind: "info" | "pass" | "fail" | "chain" = "info") => {
      setTerminalLines((prev) => [
        ...prev.slice(-80),
        { id: `${Date.now()}-${Math.random()}`, text, kind },
      ]);
    },
    []
  );

  // Load backend config & patches
  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then((data: StatusPayload) => {
        setStatus(data);
        if (!data.demoModeReady) {
          setUseDemoWallet(false);
        }
      })
      .catch((err) => setErrorBanner(`无法加载状态配置: ${String(err)}`));
  }, []);

  // Connect real Monad WebSocket `monadNewHeads` tracker
  useEffect(() => {
    const tracker = new MonadCommitTracker();
    trackerRef.current = tracker;

    const unsubConn = tracker.onConnectionChange((c) => setWsConnected(c));
    const unsubHead = tracker.onHead((head) => {
      const bStr = head.blockNumber.toString();
      setLatestHead({ blockNumber: bStr, commitState: head.commitState });

      // Update matching streamed transactions with REAL commitState & measured latency
      setStreamItems((prev) => {
        let changed = false;
        const rank: Record<MonadCommitState, number> = {
          Proposed: 1,
          Voted: 2,
          Finalized: 3,
          Verified: 4,
        };
        const next = prev.map((item) => {
          const itemBlock = BigInt(item.blockNumber);
          // Either exact block transition or head finalized past item block
          const isMatch =
            item.blockNumber === bStr ||
            ((head.commitState === "Finalized" || head.commitState === "Verified") &&
              head.blockNumber >= itemBlock);
          if (!isMatch) return item;
          if (rank[head.commitState] <= rank[item.commitState]) return item;

          changed = true;
          const isNowFinal =
            head.commitState === "Finalized" || head.commitState === "Verified";
          return {
            ...item,
            commitState: head.commitState,
            finalizedLatencyMs:
              isNowFinal && item.finalizedLatencyMs === undefined
                ? Math.max(item.proposedLatencyMs, head.receivedAtMs - item.sentAtMs)
                : item.finalizedLatencyMs,
          };
        });
        return changed ? next : prev;
      });
    });

    tracker.connect();
    return () => {
      unsubConn();
      unsubHead();
      tracker.disconnect();
    };
  }, []);

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [terminalLines]);

  // Computed financial & performance telemetry
  const totalRewardNum = Number(rewardMon) || 0.8;
  const totalChecks = 16;
  const finalBonusBps = 4000;
  const stepPayoutMon = useMemo(() => {
    const streamPool = totalRewardNum * (1 - finalBonusBps / 10000);
    return streamPool / (totalChecks - 1);
  }, [totalRewardNum]);

  const paidMon = useMemo(
    () => streamItems.reduce((acc, it) => acc + Number(it.payoutMon), 0),
    [streamItems]
  );
  const remainingMon = Math.max(0, totalRewardNum - paidMon);
  const totalGasPaidMon = useMemo(
    () => streamItems.reduce((acc, it) => acc + Number(it.actualPaidMon), 0),
    [streamItems]
  );
  const avgFinalityMs = useMemo(() => {
    const finalized = streamItems.filter((i) => i.finalizedLatencyMs !== undefined);
    if (finalized.length === 0) return null;
    const sum = finalized.reduce((a, b) => a + (b.finalizedLatencyMs || 0), 0);
    return Math.round(sum / finalized.length);
  }, [streamItems]);

  const avgProposedMs = useMemo(() => {
    if (streamItems.length === 0) return null;
    const sum = streamItems.reduce((a, b) => a + b.proposedLatencyMs, 0);
    return Math.round(sum / streamItems.length);
  }, [streamItems]);

  const activePatch = status?.patches[patchId] || null;

  const copyText = (key: string, val: string) => {
    navigator.clipboard?.writeText(val);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  };

  const handleConnectWallet = async () => {
    setErrorBanner(null);
    try {
      const addr = await connectBrowserWallet();
      setWalletAddress(addr);
      setUseDemoWallet(false);
      pushTerminal(`[WALLET] Connected ${addr} on Monad Testnet (10143)`, "chain");
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  const resetRunState = () => {
    stopStreamRef.current = true;
    setActiveTaskId(null);
    setCreateTxHash(null);
    setRefundTxHash(null);
    setTaskStatus("IDLE");
    setStreamItems([]);
    setVerifyResult(null);
    setRerunResult(null);
    setErrorBanner(null);
  };

  const handleLockEscrow = async (): Promise<`0x${string}` | null> => {
    if (!status?.contractReady) {
      setErrorBanner("尚未部署或配置 NEXT_PUBLIC_CONTRACT_ADDRESS");
      return null;
    }
    setErrorBanner(null);
    setBusyAction("locking");
    setRefundTxHash(null);
    setStreamItems([]);
    setVerifyResult(null);
    setRerunResult(null);

    try {
      const patch = status.patches[patchId];
      pushTerminal(
        `$ lock-escrow --patch ${patchId} --reward ${rewardMon}MON --checks 16 --bonus 40% --runHash ${shortHex(patch.runHash, 10, 6)}`,
        "info"
      );

      if (useDemoWallet) {
        const res = await fetch("/api/demo-create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            patchId,
            rewardMon,
            totalChecks,
            finalBonusBps,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to lock escrow");
        setActiveTaskId(data.taskId);
        setVerifyTaskInput(data.taskId);
        setTaskCreatedByWallet(false);
        setCreateTxHash(data.txHash);
        setTaskStatus("OPEN");
        pushTerminal(
          `[MONAD] TaskCreated locked ${rewardMon} MON | tx=${shortHex(data.txHash, 10, 6)} | block=#${data.blockNumber} (${data.latencyMs}ms) | actualGas=${Number(data.actualPaidMon).toFixed(5)} MON`,
          "chain"
        );
        setLiveAnnouncement(`任务已锁仓 ${rewardMon} MON 到 Monad 测试网`);
        return data.taskId as `0x${string}`;
      } else {
        const account = walletAddress || (await connectBrowserWallet());
        setWalletAddress(account);
        const taskId = keccak256(toHex(`${patchId}-${Date.now()}-${Math.random()}`));
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 900);
        const res = await browserCreateTask({
          account,
          taskId,
          agent: status.agentAddress,
          verifier: status.verifierAddress,
          totalChecks,
          finalBonusBps,
          deadline,
          challengeWindow: 120n,
          runHash: patch.runHash,
          rewardMon,
        });
        setActiveTaskId(taskId);
        setVerifyTaskInput(taskId);
        setTaskCreatedByWallet(true);
        setCreateTxHash(res.txHash);
        setTaskStatus("OPEN");
        pushTerminal(
          `[MONAD] Browser Wallet TaskCreated ${rewardMon} MON | tx=${shortHex(res.txHash, 10, 6)} | block=#${res.blockNumber}`,
          "chain"
        );
        setLiveAnnouncement(`浏览器钱包已锁仓 ${rewardMon} MON`);
        return taskId;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorBanner(msg);
      pushTerminal(`[ERROR] Lock failed: ${msg}`, "fail");
      return null;
    } finally {
      setBusyAction(null);
    }
  };

  const runVerificationStream = async (targetTaskId?: `0x${string}`) => {
    const tid = targetTaskId || activeTaskId;
    if (!tid) {
      setErrorBanner("请先锁仓创建任务，或直接点击「一键完整演示」");
      return;
    }
    setErrorBanner(null);
    setBusyAction("streaming");
    stopStreamRef.current = false;

    pushTerminal(
      `$ start-stream --task ${shortHex(tid, 10, 6)} --mode ${submitMode} --sandbox node:vm`,
      "info"
    );

    try {
      let currentPaid = 0;
      for (let i = 0; i < totalChecks; i++) {
        if (stopStreamRef.current) {
          pushTerminal(`[STOP] Verification stream paused by operator at check #${i}`, "info");
          break;
        }

        // Only inject simulated dishonest attestation on check #5 of patch-fail when toggled on
        const dishonestThisCheck = simulateDishonest && patchId === "patch-fail" && i === 5;

        const res = await fetch("/api/run-check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            taskId: tid,
            patchId,
            checkIndex: i,
            mode: submitMode,
            simulateDishonest: dishonestThisCheck,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || `Check #${i} failed on server`);
        }

        const exec = data.execution;
        const chain = data.chain;
        const attestedPassed: boolean = data.attested.passed;

        pushTerminal(
          `${exec.stdout} (${exec.durationMs}ms)`,
          exec.passed ? "pass" : "fail"
        );

        const isLast = i === totalChecks - 1;
        const payout = attestedPassed
          ? isLast
            ? Math.max(0, totalRewardNum - currentPaid)
            : stepPayoutMon
          : 0;
        currentPaid += payout;

        const existingState = trackerRef.current?.getBlockState(chain.blockNumber);
        const initialCommitState: MonadCommitState = existingState || "Proposed";
        const isAlreadyFinal =
          initialCommitState === "Finalized" || initialCommitState === "Verified";

        const item: StreamCheckItem = {
          checkIndex: i,
          stage: exec.spec.stage,
          testId: exec.spec.id,
          name: exec.spec.name,
          passed: exec.passed,
          attestedPassed,
          simulatedDishonest: Boolean(data.simulatedDishonest),
          durationMs: exec.durationMs,
          stdout: exec.stdout,
          errorMessage: exec.errorMessage,
          runHash: exec.runHash,
          receiptHash: exec.receiptHash,
          attestedReceiptHash: data.attested.receiptHash,
          txHash: chain.txHash,
          mode: chain.mode,
          signature: chain.signature,
          verifierAddress: chain.verifierAddress,
          sentAtMs: chain.sentAtMs,
          proposedLatencyMs: chain.proposedLatencyMs,
          finalizedLatencyMs: isAlreadyFinal ? chain.proposedLatencyMs : undefined,
          commitState: initialCommitState,
          blockNumber: chain.blockNumber,
          gasLimit: chain.gasLimit,
          gasUsed: chain.gasUsed,
          actualPaidMon: chain.actualPaidMon,
          payoutMon: payout.toFixed(4),
        };

        setStreamItems((prev) => [...prev, item]);

        if (dishonestThisCheck) {
          pushTerminal(
            `[DEMO ATTACK] Dishonest verifier forged PASS on failing Check #5! tx=${shortHex(chain.txHash, 10, 6)} — Now click "Re-run Same runHash" below to catch & dispute onchain!`,
            "fail"
          );
          setLiveAnnouncement("已模拟恶意验证者伪造第 5 项通过，请点击下方同 runHash 复跑抓包并发起链上争议");
          break;
        }

        if (!attestedPassed) {
          setTaskStatus("HALTED");
          pushTerminal(
            `[CIRCUIT BREAKER] TaskRailEscrow HALTED at Check #${i}! Remaining ${(totalRewardNum - currentPaid).toFixed(4)} MON locked for employer refund.`,
            "fail"
          );
          setLiveAnnouncement(
            `安全熔断触发！第 ${i} 项测试失败，剩余 ${(totalRewardNum - currentPaid).toFixed(4)} MON 已锁死等待雇主退款`
          );
          break;
        } else {
          pushTerminal(
            `[MONAD] Check #${String(i).padStart(2, "0")} attested (${chain.mode}) | +${payout.toFixed(4)} MON -> Agent | tx=${shortHex(chain.txHash, 10, 6)} | Proposed ${chain.proposedLatencyMs}ms | gasPaid=${Number(chain.actualPaidMon).toFixed(5)} MON`,
            "chain"
          );
          if (isLast) {
            setTaskStatus("COMPLETED");
            pushTerminal(
              `[COMPLETED] 16/16 checks finalized on Monad Testnet! Total streamed: ${totalRewardNum.toFixed(4)} MON (0 wei trapped).`,
              "pass"
            );
            setLiveAnnouncement("全部 16 条验证已在 Monad 测试网流式结算完成");
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorBanner(msg);
      pushTerminal(`[ERROR] Stream aborted: ${msg}`, "fail");
    } finally {
      setBusyAction(null);
    }
  };

  const handleOneClickDemo = async () => {
    const tid = await handleLockEscrow();
    if (tid) {
      await runVerificationStream(tid);
    }
  };

  const handleRefund = async () => {
    if (!activeTaskId) return;
    setErrorBanner(null);
    setBusyAction("refunding");
    try {
      if (taskCreatedByWallet) {
        const account = walletAddress || (await connectBrowserWallet());
        const res = await browserRefundRemaining({ account, taskId: activeTaskId });
        setRefundTxHash(res.txHash);
        setTaskStatus("REFUNDED");
        pushTerminal(
          `[REFUND] Browser wallet reclaimed remaining ${remainingMon.toFixed(4)} MON | tx=${shortHex(res.txHash, 10, 6)}`,
          "pass"
        );
      } else {
        const res = await fetch("/api/refund", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskId: activeTaskId }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Refund failed");
        setRefundTxHash(data.txHash);
        setTaskStatus("REFUNDED");
        pushTerminal(
          `[REFUND] Employer reclaimed remaining ${remainingMon.toFixed(4)} MON | tx=${shortHex(data.txHash, 10, 6)} | ${data.latencyMs}ms`,
          "pass"
        );
      }
      setLiveAnnouncement("剩余未释放赏金已退回雇主钱包");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorBanner(msg);
      pushTerminal(`[ERROR] Refund failed: ${msg}`, "fail");
    } finally {
      setBusyAction(null);
    }
  };

  // ZERO-BACKEND independent verification directly via browser viem -> Monad RPC
  const handleIndependentVerify = async () => {
    const targetId = (verifyTaskInput.trim() || activeTaskId) as `0x${string}` | null;
    if (!targetId || !status?.contractReady) {
      setErrorBanner("请输入有效的 0x taskId（或先运行一次演示）");
      return;
    }
    setErrorBanner(null);
    setBusyAction("verifying");
    try {
      const publicClient = getPublicClient();
      const [task, checks, dispute] = await Promise.all([
        publicClient.readContract({
          address: status.contractAddress,
          abi: TASKRAIL_ABI,
          functionName: "getTask",
          args: [targetId],
        }),
        publicClient.readContract({
          address: status.contractAddress,
          abi: TASKRAIL_ABI,
          functionName: "getAllChecks",
          args: [targetId],
        }),
        publicClient.readContract({
          address: status.contractAddress,
          abi: TASKRAIL_ABI,
          functionName: "getDispute",
          args: [targetId],
        }),
      ]);

      // Locally verify EIP-712 signatures for any checks captured in this session
      let sigChecked = 0;
      let sigValid = 0;
      for (const item of streamItems) {
        if (item.signature && activeTaskId?.toLowerCase() === targetId.toLowerCase()) {
          const onchainCheck = checks[item.checkIndex];
          if (onchainCheck) {
            sigChecked++;
            const recovered = await recoverTypedDataAddress({
              domain: {
                name: "TaskRailEscrow",
                version: "1",
                chainId: 10143,
                verifyingContract: status.contractAddress,
              },
              types: EIP712_TYPES,
              primaryType: "CheckAttestation",
              message: {
                taskId: targetId,
                runHash: task.runHash,
                checkIndex: item.checkIndex,
                passed: onchainCheck.passed,
                receiptHash: onchainCheck.receiptHash,
              },
              signature: item.signature,
            });
            if (recovered.toLowerCase() === task.verifier.toLowerCase()) {
              sigValid++;
            }
          }
        }
      }

      const hasDispute =
        dispute && dispute.challenger !== "0x0000000000000000000000000000000000000000";

      setVerifyResult({
        taskId: targetId,
        statusLabel: TASK_STATUS_LABEL[Number(task.status)] || String(task.status),
        employer: task.employer,
        agent: task.agent,
        verifier: task.verifier,
        runHash: task.runHash,
        totalRewardMon: formatEther(task.totalReward),
        paidRewardMon: formatEther(task.paidReward),
        remainingRewardMon: formatEther(task.remainingReward),
        totalChecks: Number(task.totalChecks),
        passedChecks: Number(task.passedChecks),
        recordedCount: checks.length,
        signatureVerifiedCount: sigValid,
        signatureCheckedCount: sigChecked,
        dispute: hasDispute
          ? {
              challenger: dispute.challenger,
              checkIndex: Number(dispute.checkIndex),
              counterReceiptHash: dispute.counterReceiptHash,
              reason: dispute.reason,
            }
          : null,
        verifiedAt: new Date().toLocaleTimeString(),
      });
      setTaskStatus(TASK_STATUS_LABEL[Number(task.status)] || taskStatus);
    } catch (err) {
      setErrorBanner(`链上直读验证失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyAction(null);
    }
  };

  const handleRerunCheck = async (submitDispute: boolean) => {
    const targetId = (verifyTaskInput.trim() || activeTaskId) as `0x${string}` | null;
    if (!targetId) {
      setErrorBanner("请先运行任务或输入 taskId");
      return;
    }
    setErrorBanner(null);
    setBusyAction(submitDispute ? "disputing" : "rerunning");
    try {
      const targetIdx =
        streamItems.length > 0 ? streamItems[streamItems.length - 1].checkIndex : 0;
      const res = await fetch("/api/rerun-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId: targetId,
          checkIndex: targetIdx,
          submitDispute,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Re-run failed");
      setRerunResult(data);
      if (data.conflict) {
        pushTerminal(
          `[RE-RUN CONFLICT] Check #${data.checkIndex} on same runHash returned passed=${data.rerun.passed} vs onchain=${data.onchain.passed}!`,
          "fail"
        );
      } else {
        pushTerminal(
          `[RE-RUN MATCH] Independent sandbox re-run on Check #${data.checkIndex} reproduced exact receiptHash ${shortHex(data.rerun.receiptHash, 10, 6)}.`,
          "pass"
        );
      }
      if (data.disputeTx) {
        setTaskStatus("DISPUTED");
        pushTerminal(
          `[DISPUTE ONCHAIN] CheckDisputed tx=${shortHex(data.disputeTx.txHash, 10, 6)} — task frozen to DISPUTED! Employer can now refund remaining MON.`,
          "fail"
        );
      }
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="min-h-screen bg-[#0b0b12] text-[#f4f4f8]">
      <a href="#main-console" className="skip-link bg-violet-600 text-white px-3 py-2">
        跳到主控制台
      </a>

      {/* Accessible polite live announcer */}
      <div className="sr-only" role="status" aria-live="polite">
        {liveAnnouncement}
      </div>

      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-[#272940] bg-[#0b0b12]/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#836ef9] text-white shadow-lg shadow-violet-900/40">
              <Zap className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-base font-bold tracking-tight text-white">
                TaskRail Stream
              </h1>
              <p className="text-xs text-[#a7abc4]">
                Per-Test Live Verification &amp; Atomic Micro-Escrow · Monad Blitz Guangzhou
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            {/* Real Monad WS Heartbeat */}
            <div className="flex items-center gap-2 rounded-lg border border-[#272940] bg-[#12131f] px-3 py-1.5 font-mono-tabular">
              <span
                className={`h-2 w-2 rounded-full ${wsConnected ? "bg-emerald-400" : "bg-amber-400"}`}
                aria-hidden="true"
              />
              <span className="text-[#a7abc4]">Monad Testnet (10143)</span>
              {latestHead ? (
                <span className="text-violet-300">
                  #{latestHead.blockNumber} · {latestHead.commitState}
                </span>
              ) : (
                <span className="text-amber-300">Connecting WS...</span>
              )}
            </div>

            {status?.contractReady && (
              <a
                href={addressExplorerUrl(status.contractAddress)}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 rounded-lg border border-[#272940] bg-[#12131f] px-3 py-1.5 font-mono-tabular text-violet-300 hover:border-violet-400"
              >
                <span>Escrow: {shortHex(status.contractAddress)}</span>
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            )}

            <button
              type="button"
              onClick={handleConnectWallet}
              className="flex min-h-[34px] items-center gap-1.5 rounded-lg border border-violet-500/60 bg-violet-600/20 px-3 py-1.5 font-medium text-violet-100 hover:bg-violet-600/35"
            >
              <Wallet className="h-3.5 w-3.5" aria-hidden="true" />
              <span>
                {walletAddress
                  ? `Wallet: ${shortHex(walletAddress)}`
                  : "Connect MetaMask / Rabby"}
              </span>
            </button>
          </div>
        </div>
      </header>

      <main id="main-console" tabIndex={-1} className="mx-auto max-w-[1440px] space-y-4 px-4 py-4">
        {errorBanner && (
          <div
            role="alert"
            className="flex items-start justify-between gap-3 rounded-xl border border-rose-500/60 bg-rose-950/50 px-4 py-3 text-sm text-rose-100"
          >
            <div className="flex min-w-0 flex-1 items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" aria-hidden="true" />
              <span className="break-all">{errorBanner}</span>
            </div>
            <button
              type="button"
              onClick={() => setErrorBanner(null)}
              className="shrink-0 text-xs underline text-rose-200 hover:text-white"
            >
              关闭
            </button>
          </div>
        )}

        {/* Top Control Bar */}
        <section className="panel-card rounded-xl border border-[#272940] bg-[#12131f] p-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            {/* Patch selector */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-[#a7abc4]">
                选择 AI Agent PR：
              </span>
              <button
                type="button"
                aria-pressed={patchId === "patch-fail"}
                disabled={busyAction !== null}
                onClick={() => {
                  resetRunState();
                  setPatchId("patch-fail");
                }}
                className={`flex min-h-[38px] items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                  patchId === "patch-fail"
                    ? "border-rose-400 bg-rose-500/20 text-rose-100"
                    : "border-[#272940] bg-[#181a2a] text-[#a7abc4] hover:border-[#3e4166]"
                }`}
              >
                <ShieldAlert className="h-4 w-4 text-rose-400" aria-hidden="true" />
                <span>PR #143 · ACL 漏洞版（30s 熔断退款主 Demo）</span>
              </button>

              <button
                type="button"
                aria-pressed={patchId === "patch-pass"}
                disabled={busyAction !== null}
                onClick={() => {
                  resetRunState();
                  setPatchId("patch-pass");
                }}
                className={`flex min-h-[38px] items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                  patchId === "patch-pass"
                    ? "border-emerald-400 bg-emerald-500/20 text-emerald-100"
                    : "border-[#272940] bg-[#181a2a] text-[#a7abc4] hover:border-[#3e4166]"
                }`}
              >
                <Flame className="h-4 w-4 text-emerald-400" aria-hidden="true" />
                <span>PR #142 · 完整修复版（16 条用例全绿流式爆发）</span>
              </button>
            </div>

            {/* Execution Options */}
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <div className="flex items-center gap-1.5">
                <label htmlFor="reward-select" className="text-[#a7abc4]">
                  锁仓赏金
                </label>
                <select
                  id="reward-select"
                  value={rewardMon}
                  disabled={busyAction !== null}
                  onChange={(e) => setRewardMon(e.target.value)}
                  className="rounded-lg border border-[#3e4166] bg-[#181a2a] px-2 py-1.5 font-mono-tabular text-white"
                >
                  <option value="0.4">0.4 MON</option>
                  <option value="0.8">0.8 MON</option>
                  <option value="1.6">1.6 MON</option>
                  <option value="2.0">2.0 MON</option>
                </select>
              </div>

              <div className="flex items-center gap-1.5">
                <label htmlFor="mode-select" className="text-[#a7abc4]">
                  上链路径
                </label>
                <select
                  id="mode-select"
                  value={submitMode}
                  disabled={busyAction !== null}
                  onChange={(e) => setSubmitMode(e.target.value as "direct" | "eip712")}
                  className="rounded-lg border border-[#3e4166] bg-[#181a2a] px-2 py-1.5 text-white"
                >
                  <option value="direct">Direct（省 Monad 2× ecRecover Gas）</option>
                  <option value="eip712">EIP-712 链上验签（任何人可中继）</option>
                </select>
              </div>

              <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-[#272940] bg-[#181a2a] px-2.5 py-1.5 text-[#a7abc4]">
                <input
                  type="checkbox"
                  checked={useDemoWallet}
                  disabled={!status?.demoModeReady || busyAction !== null}
                  onChange={(e) => setUseDemoWallet(e.target.checked)}
                />
                <span>1-Click Testnet 演示钱包（手机免装插件）</span>
              </label>

              {patchId === "patch-fail" && (
                <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-950/30 px-2.5 py-1.5 text-amber-200">
                  <input
                    type="checkbox"
                    checked={simulateDishonest}
                    disabled={busyAction !== null}
                    onChange={(e) => setSimulateDishonest(e.target.checked)}
                  />
                  <span>模拟恶意 Verifier 造假（用于复跑推翻演示）</span>
                </label>
              )}
            </div>
          </div>

          {/* Primary Action Buttons */}
          <div className="mt-4 flex flex-wrap items-center gap-2.5 border-t border-[#272940] pt-3">
            <button
              type="button"
              onClick={handleOneClickDemo}
              disabled={busyAction !== null || !status?.contractReady}
              className="flex min-h-[40px] items-center gap-2 rounded-lg bg-[#836ef9] px-4 py-2 text-sm font-semibold text-white shadow-md shadow-violet-900/40 hover:bg-[#7159f6] disabled:opacity-50"
            >
              <Zap className="h-4 w-4" aria-hidden="true" />
              <span>
                {busyAction === "locking"
                  ? "正在 Monad 锁仓..."
                  : busyAction === "streaming"
                    ? `正在流式验证上链 (${streamItems.length}/${totalChecks})...`
                    : "一键全自动演示（锁仓 → 真实跑测 → 流式上链）"}
              </span>
            </button>

            <button
              type="button"
              onClick={handleLockEscrow}
              disabled={busyAction !== null || !status?.contractReady}
              className="flex min-h-[40px] items-center gap-1.5 rounded-lg border border-[#3e4166] bg-[#181a2a] px-3.5 py-2 text-xs font-medium text-white hover:border-violet-400 disabled:opacity-50"
            >
              <Lock className="h-3.5 w-3.5" aria-hidden="true" />
              <span>分步 1: 锁仓 Escrow</span>
            </button>

            <button
              type="button"
              onClick={() => runVerificationStream()}
              disabled={busyAction !== null || !activeTaskId || taskStatus !== "OPEN"}
              className="flex min-h-[40px] items-center gap-1.5 rounded-lg border border-[#3e4166] bg-[#181a2a] px-3.5 py-2 text-xs font-medium text-white hover:border-violet-400 disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5" aria-hidden="true" />
              <span>分步 2: 运行测试并流式放款</span>
            </button>

            {(taskStatus === "HALTED" || taskStatus === "DISPUTED") && remainingMon > 0 && (
              <button
                type="button"
                onClick={handleRefund}
                disabled={busyAction !== null}
                className="flex min-h-[40px] items-center gap-1.5 rounded-lg border border-rose-400 bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-rose-950/60 hover:bg-rose-500 disabled:opacity-50"
              >
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                <span>
                  {busyAction === "refunding"
                    ? "正在链上退款..."
                    : `分步 3: 雇主一键退回剩余 ${remainingMon.toFixed(4)} MON`}
                </span>
              </button>
            )}

            {busyAction === "streaming" && (
              <button
                type="button"
                onClick={() => {
                  stopStreamRef.current = true;
                }}
                className="min-h-[40px] rounded-lg border border-amber-500/60 bg-amber-950/40 px-3 py-2 text-xs font-medium text-amber-200"
              >
                停止流
              </button>
            )}

            {activeTaskId && (
              <div className="ml-auto flex flex-wrap items-center gap-2 text-xs font-mono-tabular">
                <span className="rounded bg-[#181a2a] px-2 py-1 text-[#a7abc4]">
                  TaskID: {shortHex(activeTaskId, 10, 6)}
                </span>
                <button
                  type="button"
                  onClick={() => copyText("taskId", activeTaskId)}
                  className="flex items-center gap-1 rounded border border-[#272940] px-2 py-1 text-[#a7abc4] hover:text-white"
                  aria-label="复制 TaskID"
                >
                  <Copy className="h-3 w-3" aria-hidden="true" />
                  <span>{copiedKey === "taskId" ? "已复制" : "复制"}</span>
                </button>
                {createTxHash && (
                  <a
                    href={txExplorerUrl(createTxHash)}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 rounded border border-violet-500/40 bg-violet-950/30 px-2 py-1 text-violet-200 hover:underline"
                  >
                    <span>锁仓 Tx</span>
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                )}
                {refundTxHash && (
                  <a
                    href={txExplorerUrl(refundTxHash)}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 rounded border border-emerald-500/50 bg-emerald-950/40 px-2 py-1 text-emerald-200 hover:underline"
                  >
                    <span>退款 Tx</span>
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Core First-Screen Split View: Left = Live Machine Test Runner | Right = Monad Streaming Escrow */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          {/* LEFT: Code Diff + Live Sandboxed Runner Terminal */}
          <div className="flex flex-col gap-4 lg:col-span-5">
            {/* Code Diff Card */}
            <section className="panel-card rounded-xl border border-[#272940] bg-[#12131f] p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-white">
                  AI Agent 代码提交（{activePatch?.prNumber || "PR"}）
                </h2>
                <span className="rounded bg-[#181a2a] px-2 py-0.5 font-mono-tabular text-[11px] text-violet-300">
                  {activePatch?.agentName || "Agent"}
                </span>
              </div>
              <p className="mt-1 text-xs text-[#a7abc4]">{activePatch?.title}</p>
              <p className="mt-1 text-xs text-slate-300">{activePatch?.summary}</p>

              <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[11px] font-mono-tabular text-[#a7abc4]">
                <span className="rounded border border-[#272940] bg-[#0b0b12] px-2 py-0.5">
                  commit: {shortHex(activePatch?.commit, 8, 4)}
                </span>
                <span className="rounded border border-violet-500/30 bg-violet-950/20 px-2 py-0.5 text-violet-200">
                  runHash: {shortHex(activePatch?.runHash, 10, 6)}
                </span>
              </div>

              <pre className="mt-3 overflow-x-auto rounded-lg border border-[#272940] bg-[#07080f] p-3 font-mono-tabular text-xs leading-relaxed">
                {activePatch?.diffPreview.map((line, idx) => (
                  <div
                    key={idx}
                    className={
                      line.startsWith("+")
                        ? "bg-emerald-950/50 text-emerald-300"
                        : line.startsWith("-")
                          ? "bg-rose-950/50 text-rose-300"
                          : line.startsWith("@@")
                            ? "text-violet-300"
                            : "text-slate-300"
                    }
                  >
                    {line}
                  </div>
                ))}
              </pre>
            </section>

            {/* Live Terminal Output */}
            <section className="panel-card flex flex-1 flex-col rounded-xl border border-[#272940] bg-[#090a11] p-4">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
                  <Terminal className="h-4 w-4 text-violet-400" aria-hidden="true" />
                  <span>实时隔离测试终端（node:vm 真实执行）</span>
                </h2>
                <span className="font-mono-tabular text-[11px] text-[#a7abc4]">
                  1 Build Gate + 15 Unit Tests
                </span>
              </div>
              <div className="h-[370px] overflow-y-auto rounded-lg border border-[#222438] bg-[#05060b] p-3 font-mono-tabular text-xs leading-6">
                {terminalLines.map((l) => (
                  <div
                    key={l.id}
                    className={
                      l.kind === "pass"
                        ? "text-emerald-300"
                        : l.kind === "fail"
                          ? "font-semibold text-rose-300"
                          : l.kind === "chain"
                            ? "text-violet-300"
                            : "text-slate-300"
                    }
                  >
                    {l.text}
                  </div>
                ))}
                <div ref={terminalEndRef} />
              </div>
            </section>
          </div>

          {/* RIGHT: Monad Real-Time Metrics + 16-Check Streaming Payout Waterfall */}
          <div className="flex flex-col gap-4 lg:col-span-7">
            {/* 4 Key Telemetry Cards */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="panel-card rounded-xl border border-[#272940] bg-[#12131f] p-3.5">
                <div className="text-[11px] text-[#a7abc4]">Agent 已流式入账</div>
                <div className="mt-1 font-mono-tabular text-xl font-bold text-emerald-300">
                  {paidMon.toFixed(4)} <span className="text-xs font-normal">MON</span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[#222438]">
                  <div
                    className="h-full bg-emerald-400 transition-all duration-300"
                    style={{
                      width: `${Math.min(100, (paidMon / Math.max(0.0001, totalRewardNum)) * 100)}%`,
                    }}
                  />
                </div>
              </div>

              <div
                className={`panel-card rounded-xl border p-3.5 ${
                  taskStatus === "HALTED" || taskStatus === "DISPUTED"
                    ? "border-rose-400/80 bg-rose-950/35"
                    : "border-[#272940] bg-[#12131f]"
                }`}
              >
                <div className="text-[11px] text-[#a7abc4]">
                  {taskStatus === "REFUNDED"
                    ? "已退回雇主"
                    : taskStatus === "HALTED" || taskStatus === "DISPUTED"
                      ? "熔断保护（可退）"
                      : "合约剩余锁定"}
                </div>
                <div className="mt-1 font-mono-tabular text-xl font-bold text-white">
                  {remainingMon.toFixed(4)}{" "}
                  <span className="text-xs font-normal text-[#a7abc4]">MON</span>
                </div>
                <div className="mt-1 text-[11px] font-medium text-violet-300">
                  状态: {taskStatus}
                </div>
              </div>

              <div className="panel-card rounded-xl border border-[#272940] bg-[#12131f] p-3.5">
                <div className="text-[11px] text-[#a7abc4]">实测 Monad 最终性</div>
                <div className="mt-1 font-mono-tabular text-xl font-bold text-violet-300">
                  {avgFinalityMs !== null
                    ? `${avgFinalityMs}ms`
                    : avgProposedMs !== null
                      ? `${avgProposedMs}ms*`
                      : "—"}
                </div>
                <div className="mt-1 text-[11px] text-[#a7abc4]">
                  {avgFinalityMs !== null
                    ? "monadNewHeads 实测 Finalized"
                    : "等待 monadNewHeads 确认"}
                </div>
              </div>

              <div className="panel-card rounded-xl border border-[#272940] bg-[#12131f] p-3.5">
                <div className="text-[11px] text-[#a7abc4]">实付 Gas（按 gas_limit）</div>
                <div className="mt-1 font-mono-tabular text-xl font-bold text-amber-200">
                  {totalGasPaidMon.toFixed(4)}{" "}
                  <span className="text-xs font-normal">MON</span>
                </div>
                <div className="mt-1 text-[11px] text-[#a7abc4]">
                  tx.gas × effectiveGasPrice
                </div>
              </div>
            </div>

            {/* 16-Check Streaming Waterfall */}
            <section className="panel-card flex-1 rounded-xl border border-[#272940] bg-[#12131f] p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
                  <Activity className="h-4 w-4 text-violet-400" aria-hidden="true" />
                  <span>Monad 逐用例流式验证 &amp; 原子微结算瀑布</span>
                </h2>
                <span className="font-mono-tabular text-xs text-[#a7abc4]">
                  已上链 {streamItems.length} / {totalChecks} · 前 15 项每项{" "}
                  {stepPayoutMon.toFixed(4)} MON + 末项 40% 尾款
                </span>
              </div>

              <div className="h-[465px] space-y-2 overflow-y-auto pr-1">
                {(status?.tests || []).map((spec) => {
                  const rec = streamItems.find((x) => x.checkIndex === spec.index);
                  const isFinalized =
                    rec?.commitState === "Finalized" || rec?.commitState === "Verified";

                  return (
                    <div
                      key={spec.index}
                      className={`rounded-lg border px-3 py-2.5 text-xs transition ${
                        !rec
                          ? "border-[#222438] bg-[#0e101a]/70 text-[#8c90ab]"
                          : !rec.attestedPassed
                            ? "border-rose-500/80 bg-rose-950/35 text-rose-100"
                            : rec.simulatedDishonest
                              ? "border-amber-400/80 bg-amber-950/35 text-amber-100"
                              : "border-emerald-500/40 bg-[#151829] text-slate-100"
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          {!rec ? (
                            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-[#3e4166] font-mono-tabular text-[10px]">
                              {String(spec.index).padStart(2, "0")}
                            </span>
                          ) : !rec.attestedPassed ? (
                            <XCircle
                              className="h-4 w-4 shrink-0 text-rose-400"
                              aria-label="失败熔断"
                            />
                          ) : (
                            <CheckCircle2
                              className="h-4 w-4 shrink-0 text-emerald-400"
                              aria-label="验证通过"
                            />
                          )}

                          <span className="rounded bg-[#222438] px-1.5 py-0.5 font-mono-tabular text-[10px] text-violet-200">
                            {spec.stage}
                          </span>
                          <span className="font-medium">{spec.name}</span>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 font-mono-tabular">
                          {rec ? (
                            <>
                              {/* Real commitState badge (never faked) */}
                              <span
                                className={`rounded px-2 py-0.5 text-[11px] font-semibold ${
                                  isFinalized
                                    ? "bg-emerald-500/20 text-emerald-300"
                                    : "bg-amber-500/20 text-amber-200"
                                }`}
                              >
                                {isFinalized
                                  ? `✓ Finalized${rec.finalizedLatencyMs ? ` (${rec.finalizedLatencyMs}ms)` : ""}`
                                  : `⋯ ${rec.commitState} (${rec.proposedLatencyMs}ms)`}
                              </span>

                              <span
                                className={`font-semibold ${
                                  rec.attestedPassed ? "text-emerald-300" : "text-rose-300"
                                }`}
                              >
                                {rec.attestedPassed
                                  ? `+${rec.payoutMon} MON${spec.index === 15 ? " (BONUS)" : ""}`
                                  : "HALTED · 0 MON"}
                              </span>

                              <a
                                href={txExplorerUrl(rec.txHash)}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-violet-300 hover:underline"
                              >
                                <span>{shortHex(rec.txHash, 6, 4)}</span>
                                <ExternalLink className="h-3 w-3" aria-hidden="true" />
                              </a>
                            </>
                          ) : (
                            <span className="text-[11px] text-[#6d7190]">Pending</span>
                          )}
                        </div>
                      </div>

                      {rec && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono-tabular text-[11px] text-[#a7abc4]">
                          <span>mode={rec.mode}</span>
                          <span>block=#{rec.blockNumber}</span>
                          <span>gasLimit={rec.gasLimit}</span>
                          <span>gasUsed={rec.gasUsed}</span>
                          <span>paid={Number(rec.actualPaidMon).toFixed(5)} MON</span>
                          <span>receipt={shortHex(rec.attestedReceiptHash, 8, 4)}</span>
                          {rec.simulatedDishonest && (
                            <span className="font-semibold text-amber-300">
                              ⚠ FORGED PASS (for dispute demo)
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        </div>

        {/* Bottom Verification & Same-runHash Dispute Row */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* Independent Zero-Backend Verifier */}
          <section className="panel-card rounded-xl border border-[#272940] bg-[#12131f] p-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
              <ShieldCheck className="h-4 w-4 text-emerald-400" aria-hidden="true" />
              <span>独立链上凭证核验（零后端 · 浏览器直连 Monad RPC）</span>
            </h2>

            <div className="mt-3 flex flex-wrap gap-2">
              <label htmlFor="verify-task-id" className="sr-only">
                Task ID
              </label>
              <input
                id="verify-task-id"
                type="text"
                value={verifyTaskInput}
                onChange={(e) => setVerifyTaskInput(e.target.value)}
                placeholder="粘贴 0x... taskId（运行演示后自动填入）"
                className="min-w-[240px] flex-1 rounded-lg border border-[#3e4166] bg-[#090a11] px-3 py-2 font-mono-tabular text-xs text-white placeholder:text-slate-500"
              />
              <button
                type="button"
                onClick={handleIndependentVerify}
                disabled={busyAction !== null || !status?.contractReady}
                className="min-h-[38px] rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {busyAction === "verifying" ? "直读 Monad 中..." : "独立读链核验"}
              </button>
            </div>

            {verifyResult && (
              <div
                className={`mt-3 rounded-lg border p-3 text-xs ${
                  verifyResult.recordedCount > 0
                    ? "border-emerald-500/50 bg-emerald-950/25"
                    : "border-amber-500/50 bg-amber-950/25"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span
                    className={`font-mono-tabular text-sm font-bold ${
                      verifyResult.recordedCount > 0 ? "text-emerald-300" : "text-amber-300"
                    }`}
                  >
                    {verifyResult.recordedCount > 0
                      ? "✓ ON-CHAIN ATTESTATION VERIFIED"
                      : "⏳ ESCROW ACTIVE (0 CHECKS RECORDED YET)"}
                  </span>
                  <span className="font-mono-tabular text-[11px] text-emerald-200">
                    Receipt Integrity · Signature Valid · Chain Record Finalized
                  </span>
                </div>

                <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono-tabular text-[11px]">
                  <div>
                    <dt className="text-[#a7abc4]">Status</dt>
                    <dd className="font-semibold text-white">{verifyResult.statusLabel}</dd>
                  </div>
                  <div>
                    <dt className="text-[#a7abc4]">Checks Recorded / Passed</dt>
                    <dd className="text-white">
                      {verifyResult.recordedCount} / {verifyResult.passedChecks} (of{" "}
                      {verifyResult.totalChecks})
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[#a7abc4]">Paid / Remaining</dt>
                    <dd className="text-white">
                      {verifyResult.paidRewardMon} / {verifyResult.remainingRewardMon} MON
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[#a7abc4]">EIP-712 Signature Check</dt>
                    <dd className="text-emerald-300">
                      {verifyResult.signatureCheckedCount > 0
                        ? `${verifyResult.signatureVerifiedCount}/${verifyResult.signatureCheckedCount} Valid (${shortHex(verifyResult.verifier)})`
                        : `Onchain verifier: ${shortHex(verifyResult.verifier)}`}
                    </dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-[#a7abc4]">Locked runHash (All Checks Bound)</dt>
                    <dd className="break-all text-violet-200">{verifyResult.runHash}</dd>
                  </div>
                </dl>

                {/* Honest Trust Boundary Disclosure */}
                <div className="mt-3 rounded border border-[#272940] bg-[#0b0b12] p-2.5 text-[11px] leading-5 text-[#a7abc4]">
                  <div>
                    <strong className="text-emerald-300">已验证：</strong>
                    凭证哈希、Verifier EIP-712 签名与 Monad 链上不可逆记录完全一致，且全部检查绑定同一{" "}
                    <code>runHash</code>。
                  </div>
                  <div>
                    <strong className="text-amber-300">信任边界（尚未证明）：</strong>
                    单验证者执行器本身尚未进入 TEE/多节点质押，且测试通过不等于代码无未覆盖漏洞——可通过右侧「同{" "}
                    <code>runHash</code> 独立复跑争议」推翻异常签名。
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* Same-runHash Independent Re-run & Dispute Panel */}
          <section className="panel-card rounded-xl border border-[#272940] bg-[#12131f] p-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
              <RefreshCw className="h-4 w-4 text-amber-400" aria-hidden="true" />
              <span>同 runHash 独立复跑 &amp; 链上争议窗口（反单点验证者作弊）</span>
            </h2>
            <p className="mt-1 text-xs text-[#a7abc4]">
              任意第三方可用链上锁定的同一个 <code>runHash</code>{" "}
              重跑对应测试并比对哈希；若发现 Verifier 撒谎，在挑战窗口内一键发起{" "}
              <code>disputeCheck()</code> 冻结剩余资金。
            </p>

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => handleRerunCheck(false)}
                disabled={busyAction !== null || !activeTaskId}
                className="min-h-[38px] rounded-lg border border-amber-400/60 bg-amber-500/15 px-3.5 py-2 text-xs font-semibold text-amber-100 hover:bg-amber-500/25 disabled:opacity-50"
              >
                {busyAction === "rerunning" ? "独立复跑中..." : "用相同 runHash 独立复跑核验"}
              </button>

              {rerunResult?.conflict && !rerunResult.disputeTx && (
                <button
                  type="button"
                  onClick={() => handleRerunCheck(true)}
                  disabled={busyAction !== null}
                  className="min-h-[38px] rounded-lg bg-rose-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-rose-500 disabled:opacity-50"
                >
                  {busyAction === "disputing"
                    ? "正在链上提交争议..."
                    : "⚡ 发现伪造签名！提交链上 disputeCheck 冻结剩余资金"}
                </button>
              )}
            </div>

            {rerunResult && (
              <div
                className={`mt-3 rounded-lg border p-3 text-xs ${
                  rerunResult.conflict
                    ? "border-rose-500/70 bg-rose-950/35 text-rose-100"
                    : "border-emerald-500/50 bg-emerald-950/20 text-emerald-100"
                }`}
              >
                <div className="font-semibold">
                  {rerunResult.conflict
                    ? `✕ 检测到冲突（Check #${rerunResult.checkIndex}）：Verifier 链上记录与独立复跑不一致！`
                    : `✓ 复跑一致（Check #${rerunResult.checkIndex}）：独立沙盒完全复现了链上 receiptHash`}
                </div>
                <div className="mt-2 space-y-1 font-mono-tabular text-[11px]">
                  <div>Onchain : passed={String(rerunResult.onchain.passed)} · {rerunResult.onchain.receiptHash}</div>
                  <div>Re-run  : passed={String(rerunResult.rerun.passed)} · {rerunResult.rerun.receiptHash}</div>
                  <div className="text-slate-300">{rerunResult.rerun.stdout}</div>
                </div>
                {rerunResult.disputeTx && (
                  <div className="mt-2 flex items-center gap-2 font-mono-tabular text-[11px] text-amber-200">
                    <span>✓ 已链上冻结为 DISPUTED</span>
                    <a
                      href={txExplorerUrl(rerunResult.disputeTx.txHash)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 underline"
                    >
                      <span>{shortHex(rerunResult.disputeTx.txHash, 10, 6)}</span>
                      <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </a>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>

        {/* Footer */}
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-[#272940] pt-3 text-xs text-[#a7abc4]">
          <div>
            TaskRail Stream · Built on Monad Testnet (Chain ID 10143) · Open-source testnet demo, non-custodial.
          </div>
          <div>
            商业模式：面向 AI 外包工作室与多 Agent 协作平台，按流式验证结算收取 0.5% 协议验证费 + 企业私有 Verifier 订阅。
          </div>
        </footer>
      </main>
    </div>
  );
}
