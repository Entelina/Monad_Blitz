"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bug,
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
import type {
  BugMutationId,
  BugMutationSpec,
  TestCaseSpec,
  UnverifiedBoundaryItem,
} from "@/lib/suite";

interface SynthesizedPreset {
  mutations: BugMutationId[];
  prNumber: string;
  title: string;
  agentName: string;
  summary: string;
  commit: string;
  runHash: `0x${string}`;
  diffPreview: string[];
  expectedFirstFailIndex: number | null;
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
  bugMutations: BugMutationSpec[];
  unverifiedBoundaries: UnverifiedBoundaryItem[];
  presets: Record<string, SynthesizedPreset>;
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
  mutations: BugMutationId[];
  runHash: string;
  checkIndex: number;
  conflict: boolean;
  onchain: { passed: boolean; receiptHash: string; disputed: boolean };
  rerun: { passed: boolean; receiptHash: string; stdout: string; durationMs: number };
  disputeTx?: { txHash: string; latencyMs: number; actualPaidMon: string } | null;
}

const MUTATION_ORDER: BugMutationId[] = [
  "drop_fee_precision",
  "drop_owner_acl",
  "drop_withdraw_cap",
  "drop_reentrancy_lock",
];

function shortHex(hex?: string | null, left = 6, right = 4) {
  if (!hex) return "—";
  if (hex.length <= left + right + 3) return hex;
  return `${hex.slice(0, left)}...${hex.slice(-right)}`;
}

export default function HomePage() {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  // Default to PR #143 (ACL bypass bug -> halts at Check #05)
  const [selectedMutations, setSelectedMutations] = useState<BugMutationId[]>([
    "drop_owner_acl",
  ]);
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
      text: "$ taskrail-vm --network monad-testnet --chain-id 10143 --sync-rpc enabled",
      kind: "info",
    },
    {
      id: "boot-1",
      text: "READY // Toggle any Live Bug Mutator switch above to synthesize new code + runHash, then stream or burst to Monad.",
      kind: "info",
    },
  ]);

  const [streamItems, setStreamItems] = useState<StreamCheckItem[]>([]);
  const [burstSummary, setBurstSummary] = useState<{
    count: number;
    sandboxTotalMs: number;
    broadcastMs: number;
    allConfirmedMs: number;
    spannedBlocks: string[];
  } | null>(null);
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

  // Load backend config & all 16 precomputed mutation presets
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
    const terminal = terminalEndRef.current?.parentElement;
    if (terminal) terminal.scrollTop = terminal.scrollHeight;
  }, [terminalLines]);

  const canonicalMutations = useMemo(
    () => MUTATION_ORDER.filter((m) => selectedMutations.includes(m)),
    [selectedMutations]
  );

  const activePreset = useMemo<SynthesizedPreset | null>(() => {
    if (!status?.presets) return null;
    const key = canonicalMutations.join(",");
    return status.presets[key] || status.presets[""] || null;
  }, [status, canonicalMutations]);

  const totalRewardNum = Number(rewardMon) || 1.6;
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

  const copyText = (key: string, val: string) => {
    navigator.clipboard?.writeText(val);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  };

  const resetRunState = () => {
    stopStreamRef.current = true;
    setActiveTaskId(null);
    setCreateTxHash(null);
    setRefundTxHash(null);
    setTaskStatus("IDLE");
    setStreamItems([]);
    setBurstSummary(null);
    setVerifyResult(null);
    setRerunResult(null);
    setErrorBanner(null);
  };

  const toggleMutation = (id: BugMutationId) => {
    if (busyAction !== null) return;
    if (activeTaskId && ["OPEN", "HALTED", "DISPUTED"].includes(taskStatus)) {
      setErrorBanner("当前任务尚未结束。请先完成验证或退回剩余资金，再切换场景。");
      return;
    }
    resetRunState();
    setSelectedMutations((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const applyPresetMutations = (next: BugMutationId[]) => {
    if (busyAction !== null) return;
    if (activeTaskId && ["OPEN", "HALTED", "DISPUTED"].includes(taskStatus)) {
      setErrorBanner("当前任务尚未结束。请先完成验证或退回剩余资金，再切换场景。");
      return;
    }
    resetRunState();
    setSelectedMutations(next);
    if (next.length === 0) setSimulateDishonest(false);
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

  const handleLockEscrow = async (): Promise<`0x${string}` | null> => {
    if (activeTaskId && ["OPEN", "HALTED", "DISPUTED"].includes(taskStatus)) {
      setErrorBanner("当前任务尚未结束。请先完成验证或退回剩余资金，再创建新任务。");
      return null;
    }
    if (!status?.contractReady || !activePreset) {
      setErrorBanner("尚未部署或配置 NEXT_PUBLIC_CONTRACT_ADDRESS");
      return null;
    }
    setErrorBanner(null);
    setBusyAction("locking");
    setRefundTxHash(null);
    setStreamItems([]);
    setBurstSummary(null);
    setVerifyResult(null);
    setRerunResult(null);

    try {
      pushTerminal(
        `$ lock-escrow --mutations [${canonicalMutations.join(",") || "none"}] --reward ${rewardMon}MON --runHash ${shortHex(activePreset.runHash, 10, 6)}`,
        "info"
      );

      if (useDemoWallet) {
        const res = await fetch("/api/demo-create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mutations: canonicalMutations,
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
        const taskId = keccak256(
          toHex(`${canonicalMutations.join("+") || "clean"}-${Date.now()}-${Math.random()}`)
        );
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
          runHash: activePreset.runHash,
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
      setErrorBanner("请先锁仓创建任务，或直接点击「一键逐条流式演示」");
      return;
    }
    setErrorBanner(null);
    setBusyAction("streaming");
    stopStreamRef.current = false;

    const firstExpectedFail = activePreset?.expectedFirstFailIndex ?? null;

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

        const dishonestThisCheck =
          simulateDishonest && firstExpectedFail !== null && i === firstExpectedFail;

        const res = await fetch("/api/run-check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            taskId: tid,
            mutations: canonicalMutations,
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

        pushTerminal(`${exec.stdout} (${exec.durationMs}ms)`, exec.passed ? "pass" : "fail");

        const isLast = i === totalChecks - 1;
        const payout = attestedPassed
          ? isLast
            ? Math.max(0, totalRewardNum - currentPaid)
            : stepPayoutMon
          : 0;
        currentPaid += payout;

        const existingState = trackerRef.current?.getBlockState(chain.blockNumber);
        const initialCommitState: MonadCommitState = existingState || "Proposed";

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
          finalizedLatencyMs: undefined,
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
            `[DEMO ATTACK] Dishonest verifier forged PASS on failing Check #${i}! tx=${shortHex(chain.txHash, 10, 6)} — Click "同 runHash 独立复跑" below to catch & freeze onchain!`,
            "fail"
          );
          setLiveAnnouncement(`已模拟恶意验证者伪造第 ${i} 项通过，请点击下方同 runHash 复跑抓包并发起链上争议`);
          break;
        }

        if (!attestedPassed) {
          setTaskStatus("HALTED");
          pushTerminal(
            `[CIRCUIT BREAKER] TaskRailEscrow HALTED at Check #${i}! Remaining ${(totalRewardNum - currentPaid).toFixed(4)} MON protected for employer refund.`,
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

  const handlePipelineBurstDemo = async () => {
    const tid = await handleLockEscrow();
    if (!tid) return;
    setErrorBanner(null);
    setBusyAction("bursting");
    setBurstSummary(null);

    pushTerminal(
      `$ pipeline-burst --task ${shortHex(tid, 10, 6)} --mutations [${canonicalMutations.join(",") || "none"}] --mode ${submitMode} --concurrent-nonces`,
      "info"
    );

    try {
      const res = await fetch("/api/run-burst", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId: tid,
          mutations: canonicalMutations,
          mode: submitMode,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Pipeline burst failed");

      let runningPaid = 0;
      const mapped: StreamCheckItem[] = data.items.map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (entry: any) => {
          const exec = entry.execution;
          const chain = entry.chain;
          const attestedPassed: boolean = entry.attested.passed;
          const isLast = exec.checkIndex === totalChecks - 1;
          const payout = attestedPassed
            ? isLast
              ? Math.max(0, totalRewardNum - runningPaid)
              : stepPayoutMon
            : 0;
          runningPaid += payout;

          pushTerminal(`${exec.stdout} (${exec.durationMs}ms)`, exec.passed ? "pass" : "fail");

          const existingState = trackerRef.current?.getBlockState(chain.blockNumber);
          const initialCommitState: MonadCommitState = existingState || "Proposed";

          return {
            checkIndex: exec.checkIndex,
            stage: exec.spec.stage,
            testId: exec.spec.id,
            name: exec.spec.name,
            passed: exec.passed,
            attestedPassed,
            simulatedDishonest: false,
            durationMs: exec.durationMs,
            stdout: exec.stdout,
            errorMessage: exec.errorMessage,
            runHash: exec.runHash,
            receiptHash: exec.receiptHash,
            attestedReceiptHash: entry.attested.receiptHash,
            txHash: chain.txHash,
            mode: chain.mode,
            signature: chain.signature,
            verifierAddress: chain.verifierAddress,
            sentAtMs: chain.sentAtMs,
            proposedLatencyMs: chain.proposedLatencyMs,
            finalizedLatencyMs: undefined,
            commitState: initialCommitState,
            blockNumber: chain.blockNumber,
            gasLimit: chain.gasLimit,
            gasUsed: chain.gasUsed,
            actualPaidMon: chain.actualPaidMon,
            payoutMon: payout.toFixed(4),
          };
        }
      );

      setStreamItems(mapped);
      setBurstSummary({
        count: mapped.length,
        sandboxTotalMs: data.sandboxTotalMs,
        broadcastMs: data.broadcastMs,
        allConfirmedMs: data.allConfirmedMs,
        spannedBlocks: data.spannedBlocks,
      });

      if (data.halted) {
        setTaskStatus("HALTED");
        pushTerminal(
          `[BURST HALTED] ${mapped.length} txs packed in ${data.spannedBlocks.length} Monad block(s) (${data.allConfirmedMs}ms) -> HALTED! Remaining ${(totalRewardNum - runningPaid).toFixed(4)} MON ready for refund.`,
          "fail"
        );
      } else {
        setTaskStatus("COMPLETED");
        pushTerminal(
          `[MONAD BURST COMPLETED] ${mapped.length}/16 per-test txs broadcast in ${data.broadcastMs}ms, all confirmed in ${data.allConfirmedMs}ms across ${data.spannedBlocks.length} Monad 300ms block(s) (#${data.spannedBlocks[0]}..#${data.spannedBlocks[data.spannedBlocks.length - 1]})! Total paid: ${totalRewardNum.toFixed(4)} MON.`,
          "chain"
        );
      }
      setLiveAnnouncement(
        `Monad 并发齐射完成：${mapped.length} 笔真实测试验证交易打包进 ${data.spannedBlocks.length} 个区块`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorBanner(msg);
      pushTerminal(`[ERROR] Pipeline burst failed: ${msg}`, "fail");
    } finally {
      setBusyAction(null);
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
      if (activeTaskId?.toLowerCase() === targetId.toLowerCase()) {
        setTaskStatus(TASK_STATUS_LABEL[Number(task.status)] || taskStatus);
      }
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
    <div className="min-h-screen text-[#e6f2f8]">
      <a href="#main-console" className="skip-link bg-cyan-500 text-slate-950 px-3 py-2 font-semibold">
        跳到主控制台
      </a>

      <div className="sr-only" role="status" aria-live="polite">
        {liveAnnouncement}
      </div>

      {/* Top Mission Control Header (M.A.V.E.N. Style) */}
      <header className="sticky top-0 z-20 border-b border-cyan-400/20 bg-[#05080f]/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-3 px-4 py-2.5">
          <div className="flex items-center gap-3">
            <div className="hud-chamfer-sm flex h-8 w-8 items-center justify-center bg-gradient-to-br from-[#836ef9] to-[#22d3ee] text-slate-950">
              <Zap className="h-4 w-4 stroke-[2.5]" aria-hidden="true" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-mono-tabular text-sm font-bold tracking-wider text-white">
                  TASKRAIL STREAM
                </span>
                <span className="hud-chamfer-sm bg-cyan-400/15 px-1.5 py-0.5 font-mono-tabular text-[10px] font-semibold tracking-widest text-cyan-300">
                  V1.1 · MONAD BLITZ GZ
                </span>
              </div>
              <p className="font-mono-tabular text-[10px] tracking-wider uppercase text-[#8aa0b4]">
                // MACHINE-EXECUTED CODE VERIFICATION &amp; ATOMIC MICRO-ESCROW
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs font-mono-tabular">
            <div className="hud-chamfer-sm flex items-center gap-2 border border-cyan-400/25 bg-[#0a1020] px-3 py-1.5">
              <span
                className={`hud-led h-2 w-2 rounded-full ${wsConnected ? "bg-[#a3e635] text-[#a3e635]" : "bg-amber-400 text-amber-400"}`}
                aria-hidden="true"
              />
              <span className="text-[#8aa0b4]">MONAD TESTNET (10143)</span>
              {latestHead ? (
                <span className="text-cyan-300">
                  #{latestHead.blockNumber} · {latestHead.commitState.toUpperCase()}
                </span>
              ) : (
                <span className="text-amber-300">SYNCING WS...</span>
              )}
            </div>

            {status?.contractReady && (
              <a
                href={addressExplorerUrl(status.contractAddress)}
                target="_blank"
                rel="noreferrer"
                className="hud-chamfer-sm flex items-center gap-1.5 border border-cyan-400/25 bg-[#0a1020] px-3 py-1.5 text-cyan-200 hover:border-cyan-400"
              >
                <span>ESCROW {shortHex(status.contractAddress)}</span>
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            )}

            <button
              type="button"
              onClick={handleConnectWallet}
              className="hud-chamfer-sm flex min-h-[32px] items-center gap-1.5 border border-[#836ef9]/70 bg-[#836ef9]/20 px-3 py-1.5 font-semibold text-violet-100 hover:bg-[#836ef9]/35"
            >
              <Wallet className="h-3.5 w-3.5" aria-hidden="true" />
              <span>
                {walletAddress ? shortHex(walletAddress) : "CONNECT WALLET"}
              </span>
            </button>
          </div>
        </div>
      </header>

      <main id="main-console" tabIndex={-1} className="mx-auto max-w-[1440px] space-y-4 px-4 py-4">
        {/* FIRST-SCREEN HERO DIFFERENTIATION BANNER (Tallyfold Two-Tone Typography + Monad Proof Bar) */}
        <section className="hud-panel p-4 sm:p-5">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 lg:items-center">
            <div className="lg:col-span-8">
              <div className="flex flex-wrap items-center gap-2 font-mono-tabular text-[11px] uppercase tracking-widest">
                <span className="inline-flex items-center gap-1.5 text-[#a3e635]">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#a3e635]" aria-hidden="true" />
                  AI 代码交付 · 按验收进度结算
                </span>
              </div>
              <h1 className="mt-2 text-2xl font-bold leading-tight tracking-tight sm:text-3xl">
                <span className="text-white">每通过一项验收，结算一笔。</span>{" "}
                <span className="text-cyan-300">遇到漏洞，停止后续支付。</span>
              </h1>
              <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-300">
                为代码交付与安全审计提供逐项验收原型：雇主锁定赏金，验证器执行预设测试；
                通过的部分立即结算，失败后雇主可取回未支付的余额。
              </p>
              <p className="mt-3 text-xs leading-relaxed text-amber-200">
                原型信任边界：当前依赖单一验证器；争议不会自动裁决真伪，也不能追回已支付的款项。
              </p>
            </div>

            {/* Why Monad Real Measured Proof Strip */}
            <div className="grid grid-cols-3 gap-2 font-mono-tabular lg:col-span-4">
              <div className="border border-cyan-400/20 bg-[#070b16] p-2.5">
                <div className="text-[10px] uppercase tracking-wider text-[#8aa0b4]">
                  历史样例 · RPC
                </div>
                <div className="mt-0.5 text-lg font-bold text-cyan-300">156ms</div>
                <div className="text-[10px] text-[#5a6d82]">eth_sendRawTxSync</div>
              </div>
              <div className="border border-cyan-400/20 bg-[#070b16] p-2.5">
                <div className="text-[10px] uppercase tracking-wider text-[#8aa0b4]">
                  历史样例 · FINALITY
                </div>
                <div className="mt-0.5 text-lg font-bold text-[#a3e635]">965ms</div>
                <div className="text-[10px] text-[#5a6d82]">monadNewHeads 实测</div>
              </div>
              <div className="border border-cyan-400/20 bg-[#070b16] p-2.5">
                <div className="text-[10px] uppercase tracking-wider text-[#8aa0b4]">
                  BURST PACKING
                </div>
                <div className="mt-0.5 text-lg font-bold text-violet-300">16 TX/1 BLK</div>
                <div className="text-[10px] text-[#8aa0b4]">历史区块 #81491937</div>
              </div>
            </div>
          </div>
        </section>

        {errorBanner && (
          <div
            role="alert"
            className="hud-panel hud-panel-alert flex items-start justify-between gap-3 px-4 py-3 text-sm text-rose-100"
          >
            <div className="flex min-w-0 flex-1 items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" aria-hidden="true" />
              <span className="break-all font-mono-tabular text-xs">{errorBanner}</span>
            </div>
            <button
              type="button"
              onClick={() => setErrorBanner(null)}
              className="shrink-0 font-mono-tabular text-xs underline text-rose-200 hover:text-white"
            >
              CLOSE
            </button>
          </div>
        )}

        {/* LIVE BUG MUTATOR + ACTION DECK */}
        <section className="hud-panel p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-cyan-400/15 pb-3">
            <div className="flex flex-wrap items-center gap-2">
              <Bug className="h-4 w-4 text-rose-400" aria-hidden="true" />
              <h2 className="font-mono-tabular text-xs font-bold uppercase tracking-widest text-white">
              ① 选择演示场景 · 注入预设漏洞或选择全绿
              </h2>
            </div>

            <div className="flex flex-wrap items-center gap-2 font-mono-tabular text-[11px]">
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => applyPresetMutations(["drop_owner_acl"])}
                className={`hud-chamfer-sm border px-2.5 py-1 transition ${
                  canonicalMutations.length === 1 && canonicalMutations[0] === "drop_owner_acl"
                    ? "border-rose-400 bg-rose-500/25 text-rose-100"
                    : "border-cyan-400/20 bg-[#070b16] text-[#8aa0b4] hover:text-white"
                }`}
              >
                预设: PR #143 越权熔断
              </button>
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => applyPresetMutations([])}
                className={`hud-chamfer-sm border px-2.5 py-1 transition ${
                  canonicalMutations.length === 0
                    ? "border-[#a3e635] bg-[#a3e635]/20 text-[#d9f99d]"
                    : "border-cyan-400/20 bg-[#070b16] text-[#8aa0b4] hover:text-white"
                }`}
              >
                预设: PR #142 零漏洞 16/16 全绿
              </button>
              <span
                className={`hud-chamfer-sm px-2.5 py-1 font-semibold ${
                  activePreset?.expectedFirstFailIndex === null
                    ? "bg-[#a3e635]/20 text-[#a3e635]"
                    : "bg-rose-500/20 text-rose-300"
                }`}
              >
                {!activePreset
                  ? "正在加载演示配置…"
                  : activePreset.expectedFirstFailIndex === null
                  ? "✓ PREDICTED: 16/16 ALL PASS"
                  : `✕ WILL HALT @ CHECK #${String(activePreset?.expectedFirstFailIndex).padStart(2, "0")}`}
              </span>
            </div>
          </div>

          {/* 4 Live Bug Mutation Toggles */}
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {(status?.bugMutations || []).map((bug) => {
              const active = canonicalMutations.includes(bug.id);
              return (
                <button
                  key={bug.id}
                  type="button"
                  aria-pressed={active}
                  disabled={busyAction !== null}
                  onClick={() => toggleMutation(bug.id)}
                  className={`flex flex-col items-start gap-1 border p-2.5 text-left transition disabled:opacity-50 ${
                    active
                      ? "border-rose-400/80 bg-rose-950/35 text-rose-50"
                      : "border-cyan-400/15 bg-[#070b16] text-[#8aa0b4] hover:border-cyan-400/45 hover:text-slate-100"
                  }`}
                >
                  <div className="flex w-full items-center justify-between gap-2 font-mono-tabular text-[10px]">
                    <span
                      className={`hud-chamfer-sm px-1.5 py-0.5 font-bold ${
                        active
                          ? "bg-rose-500 text-slate-950"
                          : "bg-cyan-400/15 text-cyan-300"
                      }`}
                    >
                      {active ? `✕ INJECTED · ${bug.shortTag}` : `○ CLEAN · ${bug.shortTag}`}
                    </span>
                    <span className={active ? "text-rose-300" : "text-[#5a6d82]"}>
                      {bug.targetCheckName}
                    </span>
                  </div>
                  <div className="text-xs font-semibold text-white">{bug.label}</div>
                  <div className="text-[11px] leading-snug text-[#8aa0b4]">{bug.description}</div>
                </button>
              );
            })}
          </div>

          {/* Execution Options + Primary Action Buttons */}
          <p className="mt-3 text-sm text-slate-300">
            ② 运行逐项演示 · ③ 若触发熔断，点击退款。交易使用 Monad 测试网 MON。
          </p>
          <p className="mt-1 text-xs leading-relaxed text-[#a7b9cb]">
            演示任务创建时预先绑定代码、测试编号与运行器标识；当前未完整绑定测试实现或运行环境。
          </p>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-cyan-400/15 pt-3 text-xs">
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={handleOneClickDemo}
                disabled={busyAction !== null || !status?.contractReady}
                className="hud-chamfer flex min-h-[40px] items-center gap-2 bg-cyan-400 px-4 py-2 text-xs font-bold tracking-wide text-slate-950 hover:bg-cyan-300 disabled:opacity-50"
              >
                <Zap className="h-4 w-4 stroke-[2.5]" aria-hidden="true" />
                <span>
                  {busyAction === "locking"
                    ? "LOCKING ESCROW ON MONAD..."
                    : busyAction === "streaming"
                      ? `STREAMING CHECKS (${streamItems.length}/${totalChecks})...`
                      : "一键逐条流式演示（锁仓 → 真实跑测 → 逐笔上链）"}
                </span>
              </button>

              <button
                type="button"
                onClick={handlePipelineBurstDemo}
                disabled={busyAction !== null || !status?.contractReady || simulateDishonest}
                className="hud-chamfer flex min-h-[40px] items-center gap-2 border border-[#a3e635]/70 bg-[#a3e635]/15 px-4 py-2 text-xs font-bold text-[#d9f99d] hover:bg-[#a3e635]/25 disabled:opacity-50"
              >
                <Flame className="h-4 w-4 text-[#a3e635]" aria-hidden="true" />
                <span>
                  {busyAction === "bursting"
                    ? "MONAD PIPELINE BURSTING..."
                      : "⚡ 运行 16 项并发结算"}
                </span>
              </button>

              <button
                type="button"
                onClick={handleLockEscrow}
                disabled={busyAction !== null || !status?.contractReady}
                className="hud-chamfer-sm flex min-h-[38px] items-center gap-1.5 border border-cyan-400/25 bg-[#070b16] px-3 py-1.5 font-mono-tabular text-[11px] text-slate-200 hover:border-cyan-400 disabled:opacity-50"
              >
                <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                <span>STEP 1: LOCK</span>
              </button>

              <button
                type="button"
                onClick={() => runVerificationStream()}
                disabled={busyAction !== null || !activeTaskId || taskStatus !== "OPEN"}
                className="hud-chamfer-sm flex min-h-[38px] items-center gap-1.5 border border-cyan-400/25 bg-[#070b16] px-3 py-1.5 font-mono-tabular text-[11px] text-slate-200 hover:border-cyan-400 disabled:opacity-50"
              >
                <Play className="h-3.5 w-3.5" aria-hidden="true" />
                <span>STEP 2: STREAM</span>
              </button>

              {(taskStatus === "HALTED" || taskStatus === "DISPUTED") && remainingMon > 0 && (
                <button
                  type="button"
                  onClick={handleRefund}
                  disabled={busyAction !== null}
                  className="hud-chamfer flex min-h-[40px] items-center gap-1.5 bg-rose-500 px-4 py-2 text-xs font-bold text-slate-950 hover:bg-rose-400 disabled:opacity-50"
                >
                  <RotateCcw className="h-4 w-4 stroke-[2.5]" aria-hidden="true" />
                  <span>
                    {busyAction === "refunding"
                      ? "REFUNDING..."
                      : `STEP 3: 一键退回剩余 ${remainingMon.toFixed(4)} MON`}
                  </span>
                </button>
              )}

              {busyAction === "streaming" && (
                <button
                  type="button"
                  onClick={() => {
                    stopStreamRef.current = true;
                  }}
                  className="hud-chamfer-sm min-h-[38px] border border-amber-400/60 bg-amber-950/40 px-3 py-1.5 font-mono-tabular text-[11px] text-amber-200"
                >
                  STOP
                </button>
              )}
            </div>

            {/* Compact Config Toggles */}
            <div className="flex flex-wrap items-center gap-2.5 font-mono-tabular text-[11px]">
              <div className="flex items-center gap-1.5">
                <label htmlFor="reward-select" className="text-[#8aa0b4]">
                  ESCROW
                </label>
                <select
                  id="reward-select"
                  value={rewardMon}
                  disabled={busyAction !== null || Boolean(activeTaskId)}
                  onChange={(e) => setRewardMon(e.target.value)}
                  className="border border-cyan-400/25 bg-[#070b16] px-2 py-1 text-white"
                >
                  <option value="0.4">0.4 MON</option>
                  <option value="0.8">0.8 MON</option>
                  <option value="1.6">1.6 MON</option>
                  <option value="2.0">2.0 MON</option>
                </select>
              </div>

              <div className="flex items-center gap-1.5">
                <label htmlFor="mode-select" className="text-[#8aa0b4]">
                  PATH
                </label>
                <select
                  id="mode-select"
                  value={submitMode}
                  disabled={busyAction !== null}
                  onChange={(e) => setSubmitMode(e.target.value as "direct" | "eip712")}
                  className="border border-cyan-400/25 bg-[#070b16] px-2 py-1 text-white"
                >
                  <option value="direct">Direct (170k · 省 2× ecRecover)</option>
                  <option value="eip712">EIP-712 链上验签 (195k)</option>
                </select>
              </div>

              <label className="flex cursor-pointer items-center gap-1.5 border border-cyan-400/20 bg-[#070b16] px-2 py-1 text-[#8aa0b4]">
                <input
                  type="checkbox"
                  checked={useDemoWallet}
                  disabled={!status?.demoModeReady || busyAction !== null}
                  onChange={(e) => setUseDemoWallet(e.target.checked)}
                />
                <span>Demo Wallet</span>
              </label>

              {canonicalMutations.length > 0 && (
                <label className="flex cursor-pointer items-center gap-1.5 border border-amber-400/40 bg-amber-950/30 px-2 py-1 text-amber-200">
                  <input
                    type="checkbox"
                    checked={simulateDishonest}
                    disabled={busyAction !== null}
                    onChange={(e) => setSimulateDishonest(e.target.checked)}
                  />
                  <span>模拟恶意 Verifier 造假</span>
                </label>
              )}
            </div>
          </div>

          {activeTaskId && (
            <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-cyan-400/10 pt-2.5 font-mono-tabular text-[11px]">
              <span className="text-[#8aa0b4]">ACTIVE TASK_ID:</span>
              <span className="text-cyan-200">{shortHex(activeTaskId, 14, 8)}</span>
              <button
                type="button"
                onClick={() => copyText("taskId", activeTaskId)}
                className="flex items-center gap-1 border border-cyan-400/25 px-2 py-0.5 text-[#8aa0b4] hover:text-white"
                aria-label="复制 TaskID"
              >
                <Copy className="h-3 w-3" aria-hidden="true" />
                <span>{copiedKey === "taskId" ? "COPIED" : "COPY"}</span>
              </button>
              {createTxHash && (
                <a
                  href={txExplorerUrl(createTxHash)}
                  target="_blank"
                  rel="noreferrer"
                  className="hud-chamfer-sm flex items-center gap-1 bg-cyan-400/15 px-2 py-0.5 text-cyan-200 hover:bg-cyan-400/25"
                >
                  <span>LOCK TX</span>
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
              )}
              {refundTxHash && (
                <a
                  href={txExplorerUrl(refundTxHash)}
                  target="_blank"
                  rel="noreferrer"
                  className="hud-chamfer-sm flex items-center gap-1 bg-[#a3e635]/20 px-2 py-0.5 text-[#a3e635] hover:bg-[#a3e635]/30"
                >
                  <span>REFUND TX</span>
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
              )}
            </div>
          )}
        </section>

        {/* CORE SPLIT WORKSPACE: LEFT = CODE DIFF + LIVE SANDBOX TERMINAL | RIGHT = MONAD STREAMING ESCROW */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          {/* LEFT COLUMN */}
          <div className="flex flex-col gap-4 lg:col-span-5">
            {/* Dynamic Mutated Code Diff Card */}
            <section className="hud-panel p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-mono-tabular text-xs font-bold uppercase tracking-widest text-white">
                  // TARGET DIFF · {activePreset?.prNumber || "PR"}
                </h2>
                <span className="hud-chamfer-sm bg-[#836ef9]/25 px-2 py-0.5 font-mono-tabular text-[10px] text-violet-200">
                  {activePreset?.agentName || "Agent"}
                </span>
              </div>
              <p className="mt-1.5 text-xs font-medium text-slate-200">{activePreset?.title}</p>
              <p className="mt-0.5 text-xs text-[#8aa0b4]">{activePreset?.summary}</p>

              <div className="mt-2.5 flex flex-wrap items-center gap-2 font-mono-tabular text-[10px]">
                <span className="border border-cyan-400/20 bg-[#05080f] px-2 py-0.5 text-[#8aa0b4]">
                  COMMIT {shortHex(activePreset?.commit, 8, 4)}
                </span>
                <span className="border border-cyan-400/35 bg-cyan-950/30 px-2 py-0.5 text-cyan-200">
                  RUN_HASH {shortHex(activePreset?.runHash, 10, 6)}
                </span>
              </div>

              <pre className="mt-3 max-h-[175px] overflow-auto border border-cyan-400/15 bg-[#05080f] p-3 font-mono-tabular text-[11px] leading-5">
                {activePreset?.diffPreview.map((line, idx) => (
                  <div
                    key={idx}
                    className={
                      line.startsWith("+")
                        ? "bg-emerald-950/45 text-[#a3e635]"
                        : line.startsWith("-")
                          ? "bg-rose-950/50 text-rose-300"
                          : line.startsWith("@@")
                            ? "text-cyan-300"
                            : "text-slate-300"
                    }
                  >
                    {line}
                  </div>
                ))}
              </pre>
            </section>

            {/* Live Sandbox Terminal */}
            <section className="hud-panel flex flex-1 flex-col p-4">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="flex items-center gap-2 font-mono-tabular text-xs font-bold uppercase tracking-widest text-white">
                  <Terminal className="h-3.5 w-3.5 text-cyan-300" aria-hidden="true" />
                  <span>// ISOLATED NODE:VM TERMINAL</span>
                </h2>
                <span className="font-mono-tabular text-[10px] text-[#8aa0b4]">
                  1 BUILD GATE + 15 UNIT TESTS
                </span>
              </div>
              <div className="h-[410px] overflow-y-auto border border-cyan-400/15 bg-[#04060c] p-3 font-mono-tabular text-[11.5px] leading-6">
                {terminalLines.map((l) => (
                  <div
                    key={l.id}
                    className={
                      l.kind === "pass"
                        ? "text-[#a3e635]"
                        : l.kind === "fail"
                          ? "font-semibold text-rose-300"
                          : l.kind === "chain"
                            ? "text-cyan-300"
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

          {/* RIGHT COLUMN */}
          <div className="flex flex-col gap-4 lg:col-span-7">
            {/* 4 M.A.V.E.N. Style KPI Cards */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="hud-panel p-3.5">
                <div className="font-mono-tabular text-[10px] uppercase tracking-wider text-[#8aa0b4]">
                  // AGENT PAID
                </div>
                <div className="mt-1 font-mono-tabular text-xl font-bold text-[#a3e635]">
                  {paidMon.toFixed(4)} <span className="text-xs font-normal">MON</span>
                </div>
                <div className="mt-2 h-1 w-full bg-[#132036]">
                  <div
                    className="h-full bg-cyan-400 transition-all duration-300"
                    style={{
                      width: `${Math.min(100, (paidMon / Math.max(0.0001, totalRewardNum)) * 100)}%`,
                    }}
                  />
                </div>
              </div>

              <div
                className={`hud-panel p-3.5 ${
                  taskStatus === "HALTED" || taskStatus === "DISPUTED"
                    ? "hud-panel-alert"
                    : taskStatus === "REFUNDED"
                      ? "hud-panel-lime"
                      : ""
                }`}
              >
                <div className="font-mono-tabular text-[10px] uppercase tracking-wider text-[#8aa0b4]">
                  {taskStatus === "REFUNDED"
                    ? "// REFUNDED"
                    : taskStatus === "HALTED" || taskStatus === "DISPUTED"
                      ? "// HALT PROTECTED"
                      : taskStatus === "IDLE" ? "// 待锁定金额" : "// ESCROW REMAINING"}
                </div>
                <div className="mt-1 font-mono-tabular text-xl font-bold text-white">
                  {remainingMon.toFixed(4)}{" "}
                  <span className="text-xs font-normal text-[#8aa0b4]">MON</span>
                </div>
                <div className="mt-1 font-mono-tabular text-[10px] font-semibold text-cyan-300">
                  STATE: {taskStatus}
                </div>
              </div>

              <div className="hud-panel p-3.5">
                <div className="font-mono-tabular text-[10px] uppercase tracking-wider text-[#8aa0b4]">
                  // 客户端观察耗时
                </div>
                <div className="mt-1 font-mono-tabular text-xl font-bold text-cyan-300">
                  {avgFinalityMs !== null ? `约 ${avgFinalityMs}ms` : "—"}
                </div>
                <div className="mt-1 font-mono-tabular text-[10px] text-[#8aa0b4]">
                  {avgFinalityMs !== null ? "最终状态观察值，可能受时钟偏差影响" : "等待可用的最终状态计时"}
                </div>
              </div>

              <div className="hud-panel p-3.5">
                <div className="font-mono-tabular text-[10px] uppercase tracking-wider text-[#8aa0b4]">
                  // 检查交易 GAS
                </div>
                <div className="mt-1 font-mono-tabular text-xl font-bold text-amber-300">
                  {totalGasPaidMon.toFixed(4)} <span className="text-xs font-normal">MON</span>
                </div>
                <div className="mt-1 font-mono-tabular text-[10px] text-[#8aa0b4]">
                  不含锁仓与退款交易
                </div>
              </div>
            </div>

            {/* 16-Check Streaming Waterfall + Unverified Boundary Card */}
            <section className="hud-panel flex-1 p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="flex items-center gap-2 font-mono-tabular text-xs font-bold uppercase tracking-widest text-white">
                  <Activity className="h-4 w-4 text-cyan-300" aria-hidden="true" />
                  <span>// MONAD PER-TEST STREAMING PAYOUT WATERFALL</span>
                </h2>
                <span className="font-mono-tabular text-[11px] text-[#8aa0b4]">
                  ONCHAIN {streamItems.length}/{totalChecks} · STEP {stepPayoutMon.toFixed(4)} MON + 40% BONUS
                </span>
              </div>

              {burstSummary && (
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border border-[#a3e635]/50 bg-[#a3e635]/10 px-3 py-2 font-mono-tabular text-xs text-[#d9f99d]">
                  <span className="font-bold">
                    ⚡ MONAD BURST: {burstSummary.count} 笔真实测试验证交易打包进{" "}
                    {burstSummary.spannedBlocks.length} 个 Monad 区块（#
                    {burstSummary.spannedBlocks[0]}
                    {burstSummary.spannedBlocks.length > 1
                      ? `..#${burstSummary.spannedBlocks[burstSummary.spannedBlocks.length - 1]}`
                      : ""}
                    ）
                  </span>
                  <span className="text-cyan-300">
                    VM {burstSummary.sandboxTotalMs}ms · BROADCAST {burstSummary.broadcastMs}ms · CONFIRMED {burstSummary.allConfirmedMs}ms
                  </span>
                </div>
              )}

              <div className="h-[515px] space-y-2 overflow-y-auto pr-1">
                {(status?.tests || []).map((spec) => {
                  const rec = streamItems.find((x) => x.checkIndex === spec.index);
                  const isFinalized =
                    rec?.commitState === "Finalized" || rec?.commitState === "Verified";

                  return (
                    <div
                      key={spec.index}
                      className={`border px-3 py-2 text-xs transition ${
                        !rec
                          ? "border-cyan-400/10 bg-[#070b16]/80 text-[#7288a0]"
                          : !rec.attestedPassed
                            ? "border-rose-400/80 bg-rose-950/35 text-rose-100"
                            : rec.simulatedDishonest
                              ? "border-amber-400/80 bg-amber-950/35 text-amber-100"
                              : "border-cyan-400/30 bg-[#0d1426] text-slate-100"
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          {!rec ? (
                            <span className="inline-flex h-5 w-5 items-center justify-center border border-cyan-400/20 font-mono-tabular text-[10px]">
                              {String(spec.index).padStart(2, "0")}
                            </span>
                          ) : !rec.attestedPassed ? (
                            <XCircle
                              className="h-4 w-4 shrink-0 text-rose-400"
                              aria-label="失败熔断"
                            />
                          ) : (
                            <CheckCircle2
                              className="h-4 w-4 shrink-0 text-[#a3e635]"
                              aria-label="验证通过"
                            />
                          )}

                          <span className="hud-chamfer-sm bg-cyan-400/15 px-1.5 py-0.5 font-mono-tabular text-[10px] font-semibold text-cyan-200">
                            {spec.stage}
                          </span>
                          <span className="font-medium">{spec.name}</span>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 font-mono-tabular">
                          {rec ? (
                            <>
                              <span
                                className={`hud-chamfer-sm px-2 py-0.5 text-[10px] font-bold ${
                                  isFinalized
                                    ? "bg-[#a3e635]/20 text-[#a3e635]"
                                    : "bg-amber-500/20 text-amber-200"
                                }`}
                              >
                                {isFinalized
                                  ? `✓ FINALIZED${rec.finalizedLatencyMs ? ` ${rec.finalizedLatencyMs}ms` : ""}`
                                  : `⋯ ${rec.commitState.toUpperCase()} ${rec.proposedLatencyMs}ms`}
                              </span>

                              <span
                                className={`font-bold ${
                                  rec.attestedPassed ? "text-[#a3e635]" : "text-rose-300"
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
                                className="inline-flex items-center gap-1 text-cyan-300 hover:underline"
                              >
                                <span>{shortHex(rec.txHash, 6, 4)}</span>
                                <ExternalLink className="h-3 w-3" aria-hidden="true" />
                              </a>
                            </>
                          ) : (
                            <span className="text-[10px] uppercase tracking-wider text-[#5a6d82]">
                              QUEUED
                            </span>
                          )}
                        </div>
                      </div>

                      {rec && (
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono-tabular text-[10.5px] text-[#8aa0b4]">
                          <span>mode={rec.mode}</span>
                          <span>block=#{rec.blockNumber}</span>
                          <span>gasLimit={rec.gasLimit}</span>
                          <span>paid={Number(rec.actualPaidMon).toFixed(5)} MON</span>
                          <span>receipt={shortHex(rec.attestedReceiptHash, 8, 4)}</span>
                          {rec.simulatedDishonest && (
                            <span className="font-semibold text-amber-300">
                              ⚠ FORGED PASS (ready for dispute)
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* EXPLICIT UNDECIDABLE / UNVERIFIED SAFETY BOUNDARY CARD (Addressing Mentor Feedback) */}
                <div className="mt-3 border border-amber-400/45 bg-amber-950/20 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 font-mono-tabular text-[11px]">
                    <span className="flex items-center gap-1.5 font-bold text-amber-300">
                      <ShieldAlert className="h-4 w-4" aria-hidden="true" />
                      ⚠ UNDECIDABLE BY TESTS · HUMAN AUDIT REQUIRED（未覆盖安全边界）
                    </span>
                    <span className="hud-chamfer-sm bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold text-amber-200">
                      HONEST BOUNDARY
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-amber-100/85">
                    熔断只能拦住已写入测试集的确定性漏洞（上述 16 条红线），<strong>测试通过 ≠ 代码绝对安全</strong>。以下维度明确标为机器不可判定，必须交由人类审计：
                  </p>
                  <ul className="mt-2 space-y-1.5 text-[11px]">
                    {(status?.unverifiedBoundaries || []).map((b) => (
                      <li
                        key={b.id}
                        className="flex flex-wrap items-baseline justify-between gap-2 border-t border-amber-400/15 pt-1.5"
                      >
                        <div>
                          <span className="font-semibold text-amber-200">{b.scope}：</span>
                          <span className="text-[#a7b9cb]">{b.reason}</span>
                        </div>
                        <span className="font-mono-tabular text-[10px] text-amber-300">
                          [{b.owner}]
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </section>
          </div>
        </div>

        {/* BOTTOM DUAL VERIFICATION & DISPUTE ROW */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <section className="hud-panel p-4">
            <h2 className="flex items-center gap-2 font-mono-tabular text-xs font-bold uppercase tracking-widest text-white">
              <ShieldCheck className="h-4 w-4 text-[#a3e635]" aria-hidden="true" />
              <span>// ZERO-BACKEND ONCHAIN ATTESTATION VERIFIER</span>
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
                className="min-w-[240px] flex-1 border border-cyan-400/25 bg-[#05080f] px-3 py-2 font-mono-tabular text-xs text-white placeholder:text-[#5a6d82]"
              />
              <button
                type="button"
                onClick={handleIndependentVerify}
                disabled={busyAction !== null || !status?.contractReady}
                className="hud-chamfer-sm min-h-[38px] bg-[#a3e635] px-4 py-2 font-mono-tabular text-xs font-bold text-slate-950 hover:bg-[#bef264] disabled:opacity-50"
              >
                {busyAction === "verifying" ? "READING RPC..." : "独立读链核验"}
              </button>
            </div>

            {verifyResult && (
              <div
                className={`mt-3 border p-3 text-xs ${
                  verifyResult.recordedCount > 0
                    ? "border-[#a3e635]/50 bg-[#a3e635]/10"
                    : "border-amber-400/50 bg-amber-950/25"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span
                    className={`font-mono-tabular text-sm font-bold ${
                      verifyResult.recordedCount > 0 ? "text-[#a3e635]" : "text-amber-300"
                    }`}
                  >
                    {verifyResult.recordedCount > 0
                      ? "✓ ON-CHAIN ATTESTATION VERIFIED"
                      : "⏳ ESCROW ACTIVE (0 CHECKS RECORDED YET)"}
                  </span>
                  <span className="font-mono-tabular text-[10px] text-cyan-200">
                    读取合约记录；签名仅对本次持有的签名核验
                  </span>
                </div>

                <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono-tabular text-[11px]">
                  <div>
                    <dt className="text-[#8aa0b4]">STATUS</dt>
                    <dd className="font-semibold text-white">{verifyResult.statusLabel}</dd>
                  </div>
                  <div>
                    <dt className="text-[#8aa0b4]">RECORDED / PASSED</dt>
                    <dd className="text-white">
                      {verifyResult.recordedCount} / {verifyResult.passedChecks} (of{" "}
                      {verifyResult.totalChecks})
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[#8aa0b4]">PAID / REMAINING</dt>
                    <dd className="text-white">
                      {verifyResult.paidRewardMon} / {verifyResult.remainingRewardMon} MON
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[#8aa0b4]">EIP-712 SIGNATURES</dt>
                    <dd className="text-[#a3e635]">
                      {verifyResult.signatureCheckedCount > 0
                        ? `${verifyResult.signatureVerifiedCount}/${verifyResult.signatureCheckedCount} Valid (${shortHex(verifyResult.verifier)})`
                        : `Verifier: ${shortHex(verifyResult.verifier)}`}
                    </dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-[#8aa0b4]">LOCKED RUN_HASH (ALL CHECKS BOUND)</dt>
                    <dd className="break-all text-cyan-200">{verifyResult.runHash}</dd>
                  </div>
                </dl>
              </div>
            )}
          </section>

          <section className="hud-panel p-4">
            <h2 className="flex items-center gap-2 font-mono-tabular text-xs font-bold uppercase tracking-widest text-white">
              <RefreshCw className="h-4 w-4 text-amber-300" aria-hidden="true" />
              <span>// SAME-RUNHASH INDEPENDENT RE-RUN &amp; DISPUTE WINDOW</span>
            </h2>
            <p className="mt-1.5 text-xs text-[#8aa0b4]">
              演示服务根据链上 <code className="text-cyan-200">runHash</code> 匹配预设变异组合并复跑，
              比对 <code className="text-cyan-200">receiptHash</code>。争议可记录冲突并停止后续结算；
              合约不验证复跑是否诚实，也不追回已支付款项。
            </p>

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => handleRerunCheck(false)}
                disabled={busyAction !== null || !activeTaskId}
                className="hud-chamfer-sm min-h-[38px] border border-amber-400/60 bg-amber-500/15 px-3.5 py-2 font-mono-tabular text-xs font-semibold text-amber-100 hover:bg-amber-500/25 disabled:opacity-50"
              >
                {busyAction === "rerunning" ? "RE-RUNNING VM..." : "在演示服务中复跑核验"}
              </button>

              {rerunResult?.conflict && !rerunResult.disputeTx && (
                <button
                  type="button"
                  onClick={() => handleRerunCheck(true)}
                  disabled={busyAction !== null}
                  className="hud-chamfer-sm min-h-[38px] bg-rose-500 px-3.5 py-2 font-mono-tabular text-xs font-bold text-slate-950 hover:bg-rose-400 disabled:opacity-50"
                >
                  {busyAction === "disputing"
                    ? "SUBMITTING DISPUTE..."
                    : "提交链上争议记录"}
                </button>
              )}
            </div>

            {rerunResult && (
              <div
                className={`mt-3 border p-3 text-xs ${
                  rerunResult.conflict
                    ? "border-rose-400/70 bg-rose-950/35 text-rose-100"
                    : "border-[#a3e635]/50 bg-[#a3e635]/10 text-[#d9f99d]"
                }`}
              >
                <div className="font-semibold">
                  {rerunResult.conflict
                    ? `✕ 检测到冲突（Check #${rerunResult.checkIndex}）：Verifier 链上签名与独立复跑不一致！`
                    : `✓ 复跑一致（Check #${rerunResult.checkIndex}）：独立沙盒完全复现链上 receiptHash`}
                </div>
                <div className="mt-2 space-y-1 font-mono-tabular text-[11px]">
                  <div>
                    ONCHAIN: passed={String(rerunResult.onchain.passed)} ·{" "}
                    {rerunResult.onchain.receiptHash}
                  </div>
                  <div>
                    RE-RUN : passed={String(rerunResult.rerun.passed)} ·{" "}
                    {rerunResult.rerun.receiptHash}
                  </div>
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

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-cyan-400/15 pt-3 font-mono-tabular text-[11px] text-[#8aa0b4]">
          <div>
            TASKRAIL STREAM // MONAD TESTNET (10143) // NON-CUSTODIAL OPEN-SOURCE PROTOTYPE
          </div>
          <div>
            商业演进：短期切入 AI 安全红队针对性攻击测试（PoC 抓出漏洞按条结算），长期拓展多 Agent 外包流式验证（0.5% 协议费 + 企业私有 Verifier）
          </div>
        </footer>
      </main>
    </div>
  );
}
