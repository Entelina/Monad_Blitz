import fs from "fs";
import path from "path";
import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseEther,
  toHex,
  formatEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";

async function main() {
  const pk = process.env.DEPLOYER_PRIVATE_KEY as `0x${string}` | undefined;
  if (!pk || pk === "0x0000000000000000000000000000000000000000000000000000000000000000") {
    throw new Error("Set DEPLOYER_PRIVATE_KEY in contracts/.env first.");
  }

  const deployment = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", "monadTestnet.json"), "utf8")
  );
  const artifact = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "artifacts", "contracts", "TaskRailEscrow.sol", "TaskRailEscrow.json"),
      "utf8"
    )
  );

  const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
  const rpcUrl = process.env.MONAD_TESTNET_RPC || "https://testnet-rpc.monad.xyz";
  const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: monadTestnet, transport: http(rpcUrl) });

  const taskId = keccak256(toHex(`smoke-${Date.now()}`));
  const runHash = keccak256(toHex("smoke-run-v1"));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

  console.log("1) Sending createTask on Monad Testnet...");
  const t0 = Date.now();
  const createHash = await walletClient.writeContract({
    address: deployment.address,
    abi: artifact.abi,
    functionName: "createTask",
    args: [taskId, account.address, account.address, 2, 4000, deadline, 60n, runHash],
    value: parseEther("0.1"),
    gas: 220_000n,
  });
  const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
  const createTx = await publicClient.getTransaction({ hash: createHash });
  const createCost = createTx.gas * createReceipt.effectiveGasPrice;
  console.log(
    `   createTask tx=${createHash} (${Date.now() - t0}ms) gasUsed=${createReceipt.gasUsed} gasLimit=${createTx.gas} actualPaid=${formatEther(createCost)} MON`
  );

  console.log("2) Sending recordCheckDirect(passed=true)...");
  const t1 = Date.now();
  const c0Hash = await walletClient.writeContract({
    address: deployment.address,
    abi: artifact.abi,
    functionName: "recordCheckDirect",
    args: [taskId, 0, true, runHash, keccak256(toHex("receipt-0"))],
    gas: 160_000n,
  });
  const c0Receipt = await publicClient.waitForTransactionReceipt({ hash: c0Hash });
  const c0Tx = await publicClient.getTransaction({ hash: c0Hash });
  const c0Cost = c0Tx.gas * c0Receipt.effectiveGasPrice;
  console.log(
    `   recordCheckDirect(pass) tx=${c0Hash} (${Date.now() - t1}ms) gasUsed=${c0Receipt.gasUsed} gasLimit=${c0Tx.gas} actualPaid=${formatEther(c0Cost)} MON`
  );

  console.log("3) Sending recordCheckDirect(passed=false -> HALT)...");
  const t2 = Date.now();
  const c1Hash = await walletClient.writeContract({
    address: deployment.address,
    abi: artifact.abi,
    functionName: "recordCheckDirect",
    args: [taskId, 1, false, runHash, keccak256(toHex("receipt-1-fail"))],
    gas: 140_000n,
  });
  const c1Receipt = await publicClient.waitForTransactionReceipt({ hash: c1Hash });
  const c1Tx = await publicClient.getTransaction({ hash: c1Hash });
  const c1Cost = c1Tx.gas * c1Receipt.effectiveGasPrice;
  console.log(
    `   recordCheckDirect(halt) tx=${c1Hash} (${Date.now() - t2}ms) gasUsed=${c1Receipt.gasUsed} gasLimit=${c1Tx.gas} actualPaid=${formatEther(c1Cost)} MON`
  );

  console.log(`Explorer: https://testnet.monadscan.com/tx/${c0Hash}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
