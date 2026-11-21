import fs from "fs";
import path from "path";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatEther,
  http,
  keccak256,
  parseEther,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";

function loadWebEnv(): Record<string, string> {
  const raw = fs.readFileSync(path.join(__dirname, "..", "..", "web", ".env.local"), "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const EIP712_TYPES = {
  CheckAttestation: [
    { name: "taskId", type: "bytes32" },
    { name: "runHash", type: "bytes32" },
    { name: "checkIndex", type: "uint16" },
    { name: "passed", type: "bool" },
    { name: "receiptHash", type: "bytes32" },
  ],
} as const;

async function probeMinGas(
  pub: ReturnType<typeof createPublicClient>,
  from: `0x${string}`,
  to: `0x${string}`,
  data: `0x${string}`,
  low: number,
  high: number
) {
  let lo = low;
  let hi = high;
  while (hi - lo > 2500) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      await pub.request({
        method: "eth_call",
        params: [{ from, to, data, gas: "0x" + mid.toString(16), gasPrice: "0x174876e800" }, "latest"],
      });
      hi = mid;
    } catch {
      lo = mid;
    }
  }
  return hi;
}

async function main() {
  const env = loadWebEnv();
  const rpc = env.NEXT_PUBLIC_MONAD_RPC || "https://testnet-rpc.monad.xyz";
  const contractAddress = env.NEXT_PUBLIC_CONTRACT_ADDRESS as `0x${string}`;
  const agentAddress = env.NEXT_PUBLIC_AGENT_ADDRESS as `0x${string}`;
  const employer = privateKeyToAccount(env.DEMO_EMPLOYER_PRIVATE_KEY as `0x${string}`);
  const verifier = privateKeyToAccount(env.VERIFIER_PRIVATE_KEY as `0x${string}`);

  const artifact = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "artifacts", "contracts", "TaskRailEscrow.sol", "TaskRailEscrow.json"),
      "utf8"
    )
  );
  const abi = artifact.abi;

  const pub = createPublicClient({ chain: monadTestnet, transport: http(rpc) });
  const empWal = createWalletClient({ account: employer, chain: monadTestnet, transport: http(rpc) });
  const verWal = createWalletClient({ account: verifier, chain: monadTestnet, transport: http(rpc) });

  // 1) Top up Verifier EOA if below 30 MON
  const vBalBefore = await pub.getBalance({ address: verifier.address });
  const eBalBefore = await pub.getBalance({ address: employer.address });
  console.log("=== 0. Balances ===");
  console.log(`  Employer (${employer.address}): ${formatEther(eBalBefore)} MON`);
  console.log(`  Verifier (${verifier.address}): ${formatEther(vBalBefore)} MON`);
  if (vBalBefore < parseEther("30") && eBalBefore > parseEther("40")) {
    const topupHash = await empWal.sendTransaction({
      to: verifier.address,
      value: parseEther("20"),
      gas: 21_000n,
    });
    await pub.waitForTransactionReceipt({ hash: topupHash, pollingInterval: 250 });
    console.log(`  Topped up Verifier +20 MON (tx=${topupHash})`);
  }

  // 2) Benchmark Direct vs EIP-712 + Dispute on a 4-check task
  console.log("\n=== 1. Direct vs EIP-712 + Dispute Real Monad Testnet Benchmark ===");
  const taskIdA = keccak256(toHex(`bench-sig-dispute-${Date.now()}`));
  const runHashA = keccak256(toHex("bench-run-A"));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 900);

  const createA = await empWal.writeContract({
    address: contractAddress,
    abi,
    functionName: "createTask",
    args: [taskIdA, agentAddress, verifier.address, 4, 4000, deadline, 120n, runHashA],
    value: parseEther("0.4"),
    gas: 250_000n,
  });
  await pub.waitForTransactionReceipt({ hash: createA, pollingInterval: 250 });

  // Probe & run Check #0 via recordCheckDirect
  const r0 = keccak256(toHex("rec-0"));
  const dataDirect = encodeFunctionData({
    abi,
    functionName: "recordCheckDirect",
    args: [taskIdA, 0, true, runHashA, r0],
  });
  const minDirect = await probeMinGas(pub, verifier.address, contractAddress, dataDirect, 100_000, 260_000);
  const directLimit = BigInt(minDirect + 10_000);
  const txDirect = await verWal.writeContract({
    address: contractAddress,
    abi,
    functionName: "recordCheckDirect",
    args: [taskIdA, 0, true, runHashA, r0],
    gas: directLimit,
  });
  const recDirect = await pub.waitForTransactionReceipt({ hash: txDirect, pollingInterval: 250 });
  console.log(
    `  [Direct] minGas~=${minDirect}, sentGas=${directLimit}, status=${recDirect.status}, paid=${formatEther(directLimit * recDirect.effectiveGasPrice)} MON, tx=${txDirect}`
  );

  // Probe & run Check #1 via recordCheckWithSig (submitted by employer as permissionless relayer!)
  const r1 = keccak256(toHex("rec-1"));
  const sig1 = await verWal.signTypedData({
    account: verifier,
    domain: {
      name: "TaskRailEscrow",
      version: "1",
      chainId: monadTestnet.id,
      verifyingContract: contractAddress,
    },
    types: EIP712_TYPES,
    primaryType: "CheckAttestation",
    message: {
      taskId: taskIdA,
      runHash: runHashA,
      checkIndex: 1,
      passed: true,
      receiptHash: r1,
    },
  });
  const dataSig = encodeFunctionData({
    abi,
    functionName: "recordCheckWithSig",
    args: [taskIdA, 1, true, runHashA, r1, sig1],
  });
  const minSig = await probeMinGas(pub, employer.address, contractAddress, dataSig, 120_000, 320_000);
  const sigLimit = BigInt(minSig + 12_000);
  const txSig = await empWal.writeContract({
    address: contractAddress,
    abi,
    functionName: "recordCheckWithSig",
    args: [taskIdA, 1, true, runHashA, r1, sig1],
    gas: sigLimit,
  });
  const recSig = await pub.waitForTransactionReceipt({ hash: txSig, pollingInterval: 250 });
  console.log(
    `  [EIP-712] minGas~=${minSig}, sentGas=${sigLimit}, status=${recSig.status}, paid=${formatEther(sigLimit * recSig.effectiveGasPrice)} MON, tx=${txSig}`
  );
  console.log(`  [Delta] EIP-712 overhead on Monad = +${minSig - minDirect} gas`);

  // Probe & run disputeCheck with realistic reason string
  const counterR1 = keccak256(toHex("counter-rec-1"));
  const reason = `Independent re-run on runHash ${runHashA.slice(0, 10)}... returned passed=false (onchain=true)`;
  const dataDispute = encodeFunctionData({
    abi,
    functionName: "disputeCheck",
    args: [taskIdA, 1, counterR1, reason],
  });
  const minDispute = await probeMinGas(pub, employer.address, contractAddress, dataDispute, 100_000, 420_000);
  const disputeLimit = BigInt(minDispute + 15_000);
  const txDispute = await empWal.writeContract({
    address: contractAddress,
    abi,
    functionName: "disputeCheck",
    args: [taskIdA, 1, counterR1, reason],
    gas: disputeLimit,
  });
  const recDispute = await pub.waitForTransactionReceipt({ hash: txDispute, pollingInterval: 250 });
  console.log(
    `  [Dispute] minGas~=${minDispute}, sentGas=${disputeLimit}, status=${recDispute.status}, paid=${formatEther(disputeLimit * recDispute.effectiveGasPrice)} MON, tx=${txDispute}`
  );

  // Refund after dispute
  const txRef = await empWal.writeContract({
    address: contractAddress,
    abi,
    functionName: "refundRemaining",
    args: [taskIdA],
    gas: 110_000n,
  });
  const recRef = await pub.waitForTransactionReceipt({ hash: txRef, pollingInterval: 250 });
  console.log(`  [Refund after Dispute] status=${recRef.status}, tx=${txRef}`);

  // 3) Benchmark 16-Check Pipeline Burst on Monad Testnet!
  console.log("\n=== 2. 16-Check Pipeline Burst (Concurrent Nonce Fire) ===");
  const taskIdBurst = keccak256(toHex(`bench-burst16-${Date.now()}`));
  const runHashBurst = keccak256(toHex("bench-run-burst-16"));
  const createB = await empWal.writeContract({
    address: contractAddress,
    abi,
    functionName: "createTask",
    args: [taskIdBurst, agentAddress, verifier.address, 16, 4000, deadline, 120n, runHashBurst],
    value: parseEther("1.6"),
    gas: 250_000n,
  });
  await pub.waitForTransactionReceipt({ hash: createB, pollingInterval: 250 });

  const startNonce = await pub.getTransactionCount({ address: verifier.address, blockTag: "pending" });
  const fees = await pub.estimateFeesPerGas();
  const maxFeePerGas =
    fees.maxFeePerGas && fees.maxFeePerGas > 105_000_000_000n
      ? fees.maxFeePerGas
      : 115_000_000_000n;
  const maxPriorityFeePerGas = 2_000_000_000n;

  const tBurst0 = Date.now();
  const hashes: `0x${string}`[] = [];
  // Fire all 16 sequentially signed transactions concurrently via pipelined nonces!
  const sendPromises = Array.from({ length: 16 }, async (_, idx) => {
    const data = encodeFunctionData({
      abi,
      functionName: "recordCheckDirect",
      args: [taskIdBurst, idx, true, runHashBurst, keccak256(toHex(`burst-rec-${idx}`))],
    });
    const serialized = await verWal.signTransaction({
      account: verifier,
      chain: monadTestnet,
      to: contractAddress,
      data,
      gas: BigInt(minDirect + 12_000),
      nonce: startNonce + idx,
      maxFeePerGas,
      maxPriorityFeePerGas,
      type: "eip1559",
    });
    return pub.sendRawTransaction({ serializedTransaction: serialized });
  });

  const sentHashes = await Promise.all(sendPromises);
  hashes.push(...sentHashes);
  const tBroadcast = Date.now() - tBurst0;

  const receipts = await Promise.all(
    hashes.map((h) => pub.waitForTransactionReceipt({ hash: h, pollingInterval: 250 }))
  );
  const tAllConfirmed = Date.now() - tBurst0;
  const okCount = receipts.filter((r) => r.status === "success").length;
  const blocks = [...new Set(receipts.map((r) => r.blockNumber.toString()))].sort();

  const finalTask = (await pub.readContract({
    address: contractAddress,
    abi,
    functionName: "getTask",
    args: [taskIdBurst],
  })) as { status: number; passedChecks: number; remainingReward: bigint; paidReward: bigint };

  console.log(`  Broadcast all 16 txs in : ${tBroadcast}ms`);
  console.log(`  All 16 confirmed in     : ${tAllConfirmed}ms`);
  console.log(`  Success count           : ${okCount}/16`);
  console.log(`  Spanned Monad blocks    : ${blocks.length} blocks (${blocks[0]} .. ${blocks[blocks.length - 1]})`);
  console.log(
    `  Final Onchain Task      : status=${finalTask.status} (1=COMPLETED), passed=${finalTask.passedChecks}/16, paid=${formatEther(finalTask.paidReward)} MON, remaining=${formatEther(finalTask.remainingReward)} MON`
  );
  console.log(`  First / Last Burst Tx   : ${hashes[0]} / ${hashes[15]}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
