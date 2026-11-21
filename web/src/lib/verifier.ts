import {
  createWalletClient,
  encodeFunctionData,
  formatEther,
  http,
  keccak256,
  parseEther,
  toHex,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { EIP712_TYPES, TASKRAIL_ABI } from "./abi";
import { getContractAddress, getPublicClient, MONAD_RPC_URL } from "./chain";

// Per-address in-memory nonce manager to support rapid streaming without collisions
const cachedNonces = new Map<string, number>();
let nonceLock: Promise<void> = Promise.resolve();

// Short-TTL fee cache so streaming checks don't burn extra RPC round-trips (public RPC = 20 rps)
let feeCache: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; ts: number } | null = null;

// Tight explicit gas limits calibrated on Monad Testnet (Monad bills gas_limit * effectiveGasPrice,
// and un-capped eth_estimateGas can hit Monad's 3-block 10 MON reserve balance check).
const GAS_LIMITS = {
  createTask: 250_000n,
  recordCheckDirectPass: 195_000n,
  recordCheckDirectHalt: 165_000n,
  recordCheckSigPass: 225_000n,
  recordCheckSigHalt: 195_000n,
  refundRemaining: 110_000n,
  disputeCheck: 170_000n,
} as const;

function normalizePk(raw: string | undefined): `0x${string}` | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || /^0x0+$/.test(trimmed)) return null;
  return (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as `0x${string}`;
}

export function getVerifierAccount() {
  const pk = normalizePk(process.env.VERIFIER_PRIVATE_KEY);
  if (!pk) return null;
  return privateKeyToAccount(pk);
}

export function getDemoEmployerAccount() {
  const pk = normalizePk(process.env.DEMO_EMPLOYER_PRIVATE_KEY || process.env.VERIFIER_PRIVATE_KEY);
  if (!pk) return null;
  return privateKeyToAccount(pk);
}

export function getDefaultAgentAddress(): `0x${string}` {
  const envAddr = process.env.NEXT_PUBLIC_AGENT_ADDRESS;
  if (envAddr && envAddr.startsWith("0x") && envAddr.length === 42 && !/^0x0+$/.test(envAddr)) {
    return envAddr as `0x${string}`;
  }
  return "0x4AfcF8169183217601a1948EE6e08d7caf31A33F";
}

async function allocateNonce(address: `0x${string}`): Promise<number> {
  let release!: () => void;
  const prev = nonceLock;
  nonceLock = new Promise<void>((r) => {
    release = r;
  });
  await prev;
  try {
    const key = address.toLowerCase();
    const publicClient = getPublicClient();
    const chainNonce = await publicClient.getTransactionCount({
      address,
      blockTag: "pending",
    });
    const cur = cachedNonces.get(key);
    const assigned = cur === undefined || chainNonce > cur ? chainNonce : cur;
    cachedNonces.set(key, assigned + 1);
    return assigned;
  } finally {
    release();
  }
}

export function resetNonceCache(address?: `0x${string}`) {
  if (address) {
    cachedNonces.delete(address.toLowerCase());
  } else {
    cachedNonces.clear();
  }
}

async function getCachedFees() {
  const now = Date.now();
  if (feeCache && now - feeCache.ts < 15_000) {
    return feeCache;
  }
  try {
    const publicClient = getPublicClient();
    const fees = await publicClient.estimateFeesPerGas();
    // Monad minimum base fee is 100 gwei; keep tight cap to avoid reserve balance spikes
    const maxFeePerGas =
      fees.maxFeePerGas && fees.maxFeePerGas > 105_000_000_000n
        ? fees.maxFeePerGas
        : 115_000_000_000n;
    const maxPriorityFeePerGas =
      fees.maxPriorityFeePerGas && fees.maxPriorityFeePerGas > 1_000_000_000n
        ? fees.maxPriorityFeePerGas
        : 2_000_000_000n;
    feeCache = { maxFeePerGas, maxPriorityFeePerGas, ts: now };
    return feeCache;
  } catch {
    return {
      maxFeePerGas: 115_000_000_000n,
      maxPriorityFeePerGas: 2_000_000_000n,
      ts: now,
    };
  }
}

export interface AttestTxResult {
  txHash: `0x${string}`;
  mode: "direct" | "eip712";
  syncRpcUsed: boolean;
  signature?: `0x${string}`;
  verifierAddress: `0x${string}`;
  sentAtMs: number;
  proposedAtMs: number;
  proposedLatencyMs: number;
  blockNumber: string;
  gasLimit: string;
  gasUsed: string;
  effectiveGasPrice: string;
  actualPaidMon: string; // Monad charges gas_limit * effectiveGasPrice
  txStatus: "success" | "reverted";
}

/**
 * Signs locally and broadcasts via Monad's native `eth_sendRawTransactionSync` RPC for single-RTT
 * receipt confirmation; automatically falls back to standard `sendRawTransaction` + fast polling.
 */
async function sendContractTxFast(params: {
  account: ReturnType<typeof privateKeyToAccount>;
  to: `0x${string}`;
  data: `0x${string}`;
  value?: bigint;
  gas: bigint;
}) {
  const publicClient = getPublicClient();
  const walletClient = createWalletClient({
    account: params.account,
    chain: monadTestnet,
    transport: http(MONAD_RPC_URL),
  });
  const fees = await getCachedFees();

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const nonce = await allocateNonce(params.account.address);
    const serialized = await walletClient.signTransaction({
      account: params.account,
      chain: monadTestnet,
      to: params.to,
      data: params.data,
      value: params.value ?? 0n,
      gas: params.gas,
      nonce,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      type: "eip1559",
    });

    const sentAtMs = Date.now();
    try {
      const rawReceipt = (await publicClient.request({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        method: "eth_sendRawTransactionSync" as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        params: [serialized] as any,
      })) as {
        transactionHash: `0x${string}`;
        blockNumber: `0x${string}` | bigint;
        gasUsed: `0x${string}` | bigint;
        effectiveGasPrice: `0x${string}` | bigint;
        status: `0x${string}` | "success" | "reverted";
      };

      const proposedAtMs = Date.now();
      const statusOk = rawReceipt.status === "0x1" || rawReceipt.status === "success";
      return {
        txHash: rawReceipt.transactionHash,
        sentAtMs,
        proposedAtMs,
        blockNumber: BigInt(rawReceipt.blockNumber),
        gasLimit: params.gas,
        gasUsed: BigInt(rawReceipt.gasUsed),
        effectiveGasPrice: BigInt(rawReceipt.effectiveGasPrice),
        txStatus: (statusOk ? "success" : "reverted") as "success" | "reverted",
        syncRpcUsed: true,
      };
    } catch (syncErr) {
      const syncMsg = syncErr instanceof Error ? syncErr.message : String(syncErr);
      // If method unsupported / timeout, fall back to standard sendRawTransaction
      if (
        syncMsg.toLowerCase().includes("reserve balance") ||
        syncMsg.toLowerCase().includes("nonce")
      ) {
        resetNonceCache(params.account.address);
        lastErr = syncErr;
        await new Promise((r) => setTimeout(r, 600));
        continue;
      }

      try {
        const txHash = await publicClient.sendRawTransaction({
          serializedTransaction: serialized,
        });
        const receipt: TransactionReceipt = await publicClient.waitForTransactionReceipt({
          hash: txHash,
          pollingInterval: 250,
          timeout: 20_000,
        });
        const proposedAtMs = Date.now();
        return {
          txHash,
          sentAtMs,
          proposedAtMs,
          blockNumber: receipt.blockNumber,
          gasLimit: params.gas,
          gasUsed: receipt.gasUsed,
          effectiveGasPrice: receipt.effectiveGasPrice,
          txStatus: receipt.status,
          syncRpcUsed: false,
        };
      } catch (fallbackErr) {
        resetNonceCache(params.account.address);
        lastErr = fallbackErr;
        await new Promise((r) => setTimeout(r, 600));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function submitCheckOnchain(params: {
  taskId: `0x${string}`;
  checkIndex: number;
  passed: boolean;
  runHash: `0x${string}`;
  receiptHash: `0x${string}`;
  mode?: "direct" | "eip712";
}): Promise<AttestTxResult> {
  const account = getVerifierAccount();
  if (!account) {
    throw new Error("VERIFIER_PRIVATE_KEY is not configured on the server");
  }
  const contractAddress = getContractAddress();
  if (/^0x0+$/.test(contractAddress)) {
    throw new Error("NEXT_PUBLIC_CONTRACT_ADDRESS is not configured");
  }

  const mode = params.mode || "direct";
  const walletClient = createWalletClient({
    account,
    chain: monadTestnet,
    transport: http(MONAD_RPC_URL),
  });

  // Always produce EIP-712 signature so independent verifier UI can cryptographically verify the attestation
  const signature = await walletClient.signTypedData({
    account,
    domain: {
      name: "TaskRailEscrow",
      version: "1",
      chainId: monadTestnet.id,
      verifyingContract: contractAddress,
    },
    types: EIP712_TYPES,
    primaryType: "CheckAttestation",
    message: {
      taskId: params.taskId,
      runHash: params.runHash,
      checkIndex: params.checkIndex,
      passed: params.passed,
      receiptHash: params.receiptHash,
    },
  });

  const functionName = mode === "eip712" ? "recordCheckWithSig" : "recordCheckDirect";
  const args =
    mode === "eip712"
      ? ([
          params.taskId,
          params.checkIndex,
          params.passed,
          params.runHash,
          params.receiptHash,
          signature,
        ] as const)
      : ([
          params.taskId,
          params.checkIndex,
          params.passed,
          params.runHash,
          params.receiptHash,
        ] as const);

  const gasLimit =
    mode === "eip712"
      ? params.passed
        ? GAS_LIMITS.recordCheckSigPass
        : GAS_LIMITS.recordCheckSigHalt
      : params.passed
        ? GAS_LIMITS.recordCheckDirectPass
        : GAS_LIMITS.recordCheckDirectHalt;

  const data = encodeFunctionData({
    abi: TASKRAIL_ABI,
    functionName,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: args as any,
  });

  const sent = await sendContractTxFast({
    account,
    to: contractAddress,
    data,
    gas: gasLimit,
  });

  if (sent.txStatus !== "success") {
    throw new Error(
      `Onchain check #${params.checkIndex} reverted (tx=${sent.txHash}, gasLimit=${sent.gasLimit})`
    );
  }

  const actualPaidWei = sent.gasLimit * sent.effectiveGasPrice;

  return {
    txHash: sent.txHash,
    mode,
    syncRpcUsed: sent.syncRpcUsed,
    signature,
    verifierAddress: account.address,
    sentAtMs: sent.sentAtMs,
    proposedAtMs: sent.proposedAtMs,
    proposedLatencyMs: sent.proposedAtMs - sent.sentAtMs,
    blockNumber: sent.blockNumber.toString(),
    gasLimit: sent.gasLimit.toString(),
    gasUsed: sent.gasUsed.toString(),
    effectiveGasPrice: sent.effectiveGasPrice.toString(),
    actualPaidMon: formatEther(actualPaidWei),
    txStatus: sent.txStatus,
  };
}

export async function createDemoTaskOnchain(params: {
  label: string;
  totalChecks: number;
  finalBonusBps: number;
  rewardMon: string;
  runHash: `0x${string}`;
}) {
  const employer = getDemoEmployerAccount();
  const verifier = getVerifierAccount();
  if (!employer || !verifier) {
    throw new Error("Server testnet demo keys not configured");
  }
  const contractAddress = getContractAddress();
  const taskId = keccak256(toHex(`${params.label}-${Date.now()}-${Math.random()}`));
  const agent = getDefaultAgentAddress();
  const value = parseEther(params.rewardMon);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 900);
  const challengeWindow = 120n;

  const data = encodeFunctionData({
    abi: TASKRAIL_ABI,
    functionName: "createTask",
    args: [
      taskId,
      agent,
      verifier.address,
      params.totalChecks,
      params.finalBonusBps,
      deadline,
      challengeWindow,
      params.runHash,
    ],
  });

  const sent = await sendContractTxFast({
    account: employer,
    to: contractAddress,
    data,
    value,
    gas: GAS_LIMITS.createTask,
  });
  if (sent.txStatus !== "success") {
    throw new Error(`createTask reverted onchain (tx=${sent.txHash})`);
  }

  return {
    taskId,
    txHash: sent.txHash,
    employer: employer.address,
    agent,
    verifier: verifier.address,
    rewardMon: params.rewardMon,
    deadline: deadline.toString(),
    blockNumber: sent.blockNumber.toString(),
    latencyMs: sent.proposedAtMs - sent.sentAtMs,
    gasLimit: sent.gasLimit.toString(),
    gasUsed: sent.gasUsed.toString(),
    actualPaidMon: formatEther(sent.gasLimit * sent.effectiveGasPrice),
  };
}

export async function refundDemoTaskOnchain(taskId: `0x${string}`) {
  const employer = getDemoEmployerAccount();
  if (!employer) throw new Error("Server demo employer key not configured");
  const contractAddress = getContractAddress();

  const data = encodeFunctionData({
    abi: TASKRAIL_ABI,
    functionName: "refundRemaining",
    args: [taskId],
  });

  const sent = await sendContractTxFast({
    account: employer,
    to: contractAddress,
    data,
    gas: GAS_LIMITS.refundRemaining,
  });
  if (sent.txStatus !== "success") {
    throw new Error(`refundRemaining reverted onchain (tx=${sent.txHash})`);
  }

  return {
    txHash: sent.txHash,
    blockNumber: sent.blockNumber.toString(),
    latencyMs: sent.proposedAtMs - sent.sentAtMs,
    gasLimit: sent.gasLimit.toString(),
    gasUsed: sent.gasUsed.toString(),
    actualPaidMon: formatEther(sent.gasLimit * sent.effectiveGasPrice),
  };
}

export async function disputeDemoCheckOnchain(params: {
  taskId: `0x${string}`;
  checkIndex: number;
  counterReceiptHash: `0x${string}`;
  reason: string;
}) {
  const challenger = getDemoEmployerAccount();
  if (!challenger) throw new Error("Server demo challenger key not configured");
  const contractAddress = getContractAddress();

  const data = encodeFunctionData({
    abi: TASKRAIL_ABI,
    functionName: "disputeCheck",
    args: [params.taskId, params.checkIndex, params.counterReceiptHash, params.reason],
  });

  const sent = await sendContractTxFast({
    account: challenger,
    to: contractAddress,
    data,
    gas: GAS_LIMITS.disputeCheck,
  });

  return {
    txHash: sent.txHash,
    challenger: challenger.address,
    blockNumber: sent.blockNumber.toString(),
    latencyMs: sent.proposedAtMs - sent.sentAtMs,
    gasLimit: sent.gasLimit.toString(),
    gasUsed: sent.gasUsed.toString(),
    actualPaidMon: formatEther(sent.gasLimit * sent.effectiveGasPrice),
  };
}
