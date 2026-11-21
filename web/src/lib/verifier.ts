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

// In-memory nonce lock per server instance to prevent collisions during rapid 16-check streaming
let cachedNonce: number | null = null;
let nonceLock: Promise<void> = Promise.resolve();

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
  // Deterministic demo AI agent payout address (distinct from employer/verifier)
  return "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
}

async function allocateNonce(address: `0x${string}`): Promise<number> {
  let release!: () => void;
  const prev = nonceLock;
  nonceLock = new Promise<void>((r) => {
    release = r;
  });
  await prev;
  try {
    const publicClient = getPublicClient();
    const chainNonce = await publicClient.getTransactionCount({
      address,
      blockTag: "pending",
    });
    if (cachedNonce === null || chainNonce > cachedNonce) {
      cachedNonce = chainNonce;
    }
    const assigned = cachedNonce;
    cachedNonce += 1;
    return assigned;
  } finally {
    release();
  }
}

export function resetNonceCache() {
  cachedNonce = null;
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
 * receipt confirmation; automatically falls back to standard `sendRawTransaction` + polling if needed.
 */
async function sendContractTxFast(params: {
  account: ReturnType<typeof privateKeyToAccount>;
  to: `0x${string}`;
  data: `0x${string}`;
  value?: bigint;
  gas: bigint;
  nonce: number;
}) {
  const publicClient = getPublicClient();
  const walletClient = createWalletClient({
    account: params.account,
    chain: monadTestnet,
    transport: http(MONAD_RPC_URL),
  });

  const fees = await publicClient.estimateFeesPerGas();
  const serialized = await walletClient.signTransaction({
    account: params.account,
    chain: monadTestnet,
    to: params.to,
    data: params.data,
    value: params.value ?? 0n,
    gas: params.gas,
    nonce: params.nonce,
    maxFeePerGas: fees.maxFeePerGas ?? 150_000_000_000n,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 2_000_000_000n,
    type: "eip1559",
  });

  const sentAtMs = Date.now();
  try {
    // Monad native synchronous receipt RPC (single round-trip)
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
    const blockNumber = BigInt(rawReceipt.blockNumber);
    const gasUsed = BigInt(rawReceipt.gasUsed);
    const effectiveGasPrice = BigInt(rawReceipt.effectiveGasPrice);
    const statusOk = rawReceipt.status === "0x1" || rawReceipt.status === "success";

    return {
      txHash: rawReceipt.transactionHash,
      sentAtMs,
      proposedAtMs,
      blockNumber,
      gasLimit: params.gas,
      gasUsed,
      effectiveGasPrice,
      txStatus: (statusOk ? "success" : "reverted") as "success" | "reverted",
      syncRpcUsed: true,
    };
  } catch {
    // Graceful fallback to standard async sendRawTransaction + fast polling
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
  }
}

/**
 * Signs an EIP-712 CheckAttestation and submits to Monad Testnet.
 * Uses tight explicit gas limits because Monad charges gas_limit * effectiveGasPrice.
 */
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
  const publicClient = getPublicClient();
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

  // Tight explicit gas limits tuned for Monad (charged by gas_limit, not gas_used)
  const estimatedGas = await publicClient.estimateContractGas({
    address: contractAddress,
    abi: TASKRAIL_ABI,
    account: account.address,
    functionName,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: args as any,
  });
  // Tight +6% buffer (Monad bills gas_limit directly)
  const gasLimit = estimatedGas + (estimatedGas * 6n) / 100n + 2000n;
  const data = encodeFunctionData({
    abi: TASKRAIL_ABI,
    functionName,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: args as any,
  });

  const nonce = await allocateNonce(account.address);

  let sent;
  try {
    sent = await sendContractTxFast({
      account,
      to: contractAddress,
      data,
      gas: gasLimit,
      nonce,
    });
  } catch (err) {
    resetNonceCache();
    throw err;
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

/**
 * Guest / mobile 1-click task creation helper (Testnet only!) so judges on mobile without MetaMask
 * can still trigger real Monad Testnet escrow locking & refund transactions live.
 */
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
  const publicClient = getPublicClient();
  const walletClient = createWalletClient({
    account: employer,
    chain: monadTestnet,
    transport: http(MONAD_RPC_URL),
  });

  const taskId = keccak256(toHex(`${params.label}-${Date.now()}-${Math.random()}`));
  const agent = getDefaultAgentAddress();
  const value = parseEther(params.rewardMon);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 900); // 15 min
  const challengeWindow = 120n; // 120s re-run dispute window

  const estimatedGas = await publicClient.estimateContractGas({
    address: contractAddress,
    abi: TASKRAIL_ABI,
    account: employer.address,
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
    value,
  });
  const gasLimit = estimatedGas + (estimatedGas * 6n) / 100n + 3000n;
  const nonce = await allocateNonce(employer.address);

  const sentAtMs = Date.now();
  let txHash: `0x${string}`;
  try {
    txHash = await walletClient.writeContract({
      address: contractAddress,
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
      value,
      gas: gasLimit,
      nonce,
    });
  } catch (err) {
    resetNonceCache();
    throw err;
  }

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    pollingInterval: 250,
  });
  const tx = await publicClient.getTransaction({ hash: txHash });
  const actualPaidMon = formatEther(tx.gas * receipt.effectiveGasPrice);

  return {
    taskId,
    txHash,
    employer: employer.address,
    agent,
    verifier: verifier.address,
    rewardMon: params.rewardMon,
    deadline: deadline.toString(),
    blockNumber: receipt.blockNumber.toString(),
    latencyMs: Date.now() - sentAtMs,
    gasLimit: tx.gas.toString(),
    gasUsed: receipt.gasUsed.toString(),
    actualPaidMon,
  };
}

export async function refundDemoTaskOnchain(taskId: `0x${string}`) {
  const employer = getDemoEmployerAccount();
  if (!employer) throw new Error("Server demo employer key not configured");
  const contractAddress = getContractAddress();
  const publicClient = getPublicClient();
  const walletClient = createWalletClient({
    account: employer,
    chain: monadTestnet,
    transport: http(MONAD_RPC_URL),
  });

  const estimatedGas = await publicClient.estimateContractGas({
    address: contractAddress,
    abi: TASKRAIL_ABI,
    account: employer.address,
    functionName: "refundRemaining",
    args: [taskId],
  });
  const gasLimit = estimatedGas + (estimatedGas * 6n) / 100n + 3000n;
  const nonce = await allocateNonce(employer.address);
  const sentAtMs = Date.now();

  let txHash: `0x${string}`;
  try {
    txHash = await walletClient.writeContract({
      address: contractAddress,
      abi: TASKRAIL_ABI,
      functionName: "refundRemaining",
      args: [taskId],
      gas: gasLimit,
      nonce,
    });
  } catch (err) {
    resetNonceCache();
    throw err;
  }

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    pollingInterval: 250,
  });
  const tx = await publicClient.getTransaction({ hash: txHash });
  return {
    txHash,
    blockNumber: receipt.blockNumber.toString(),
    latencyMs: Date.now() - sentAtMs,
    gasLimit: tx.gas.toString(),
    gasUsed: receipt.gasUsed.toString(),
    actualPaidMon: formatEther(tx.gas * receipt.effectiveGasPrice),
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
  const publicClient = getPublicClient();
  const walletClient = createWalletClient({
    account: challenger,
    chain: monadTestnet,
    transport: http(MONAD_RPC_URL),
  });

  const estimatedGas = await publicClient.estimateContractGas({
    address: contractAddress,
    abi: TASKRAIL_ABI,
    account: challenger.address,
    functionName: "disputeCheck",
    args: [params.taskId, params.checkIndex, params.counterReceiptHash, params.reason],
  });
  const gasLimit = estimatedGas + (estimatedGas * 6n) / 100n + 3000n;
  const nonce = await allocateNonce(challenger.address);
  const sentAtMs = Date.now();

  let txHash: `0x${string}`;
  try {
    txHash = await walletClient.writeContract({
      address: contractAddress,
      abi: TASKRAIL_ABI,
      functionName: "disputeCheck",
      args: [params.taskId, params.checkIndex, params.counterReceiptHash, params.reason],
      gas: gasLimit,
      nonce,
    });
  } catch (err) {
    resetNonceCache();
    throw err;
  }

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    pollingInterval: 250,
  });
  const tx = await publicClient.getTransaction({ hash: txHash });
  return {
    txHash,
    challenger: challenger.address,
    blockNumber: receipt.blockNumber.toString(),
    latencyMs: Date.now() - sentAtMs,
    gasLimit: tx.gas.toString(),
    gasUsed: receipt.gasUsed.toString(),
    actualPaidMon: formatEther(tx.gas * receipt.effectiveGasPrice),
  };
}
