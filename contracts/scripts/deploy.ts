import fs from "fs";
import path from "path";
import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";

async function main() {
  const rawPk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!rawPk || /^0x0+$/.test(rawPk)) {
    throw new Error("DEPLOYER_PRIVATE_KEY missing in contracts/.env");
  }
  const pk = (rawPk.startsWith("0x") ? rawPk : `0x${rawPk}`) as `0x${string}`;
  const account = privateKeyToAccount(pk);
  const rpcUrl = process.env.MONAD_TESTNET_RPC || "https://testnet-rpc.monad.xyz";

  const publicClient = createPublicClient({
    chain: monadTestnet,
    transport: http(rpcUrl),
  });
  const walletClient = createWalletClient({
    account,
    chain: monadTestnet,
    transport: http(rpcUrl),
  });

  const balance = await publicClient.getBalance({ address: account.address });
  console.log("Deploying TaskRailEscrow to Monad Testnet (chainId=10143)...");
  console.log("  Deployer:", account.address);
  console.log("  Balance :", formatEther(balance), "MON");

  if (balance === 0n) {
    throw new Error(`Zero MON balance on ${account.address}. Fund from faucet first.`);
  }

  const artifactPath = path.join(
    __dirname,
    "..",
    "artifacts",
    "contracts",
    "TaskRailEscrow.sol",
    "TaskRailEscrow.json"
  );
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

  const t0 = Date.now();
  const deployHash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode as `0x${string}`,
    account,
  });
  console.log("  Deploy Tx:", deployHash);

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: deployHash,
    pollingInterval: 300,
  });
  const tx = await publicClient.getTransaction({ hash: deployHash });
  const contractAddress = receipt.contractAddress;
  if (!contractAddress) {
    throw new Error("Deployment succeeded but contractAddress is null");
  }

  const actualCost = tx.gas * receipt.effectiveGasPrice;
  console.log("Deployed TaskRailEscrow:", contractAddress);
  console.log(`  Block     : #${receipt.blockNumber} (${Date.now() - t0}ms)`);
  console.log(`  Gas Limit : ${tx.gas} | Gas Used: ${receipt.gasUsed}`);
  console.log(`  Actual Fee: ${formatEther(actualCost)} MON (gas_limit * effectiveGasPrice)`);
  console.log(`  Explorer  : https://testnet.monadscan.com/address/${contractAddress}`);

  const deployment = {
    network: "monadTestnet",
    chainId: 10143,
    address: contractAddress,
    deployTxHash: deployHash,
    deployer: account.address,
    blockNumber: receipt.blockNumber.toString(),
    deployedAt: new Date().toISOString(),
  };

  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "monadTestnet.json"),
    JSON.stringify(deployment, null, 2) + "\n",
    "utf8"
  );

  // Auto-update web/.env.local if present
  const webEnvLocal = path.join(__dirname, "..", "..", "web", ".env.local");
  if (fs.existsSync(webEnvLocal)) {
    const raw = fs.readFileSync(webEnvLocal, "utf8");
    const updated = raw.replace(
      /^NEXT_PUBLIC_CONTRACT_ADDRESS=.*$/m,
      `NEXT_PUBLIC_CONTRACT_ADDRESS=${contractAddress}`
    );
    fs.writeFileSync(webEnvLocal, updated, "utf8");
    console.log("Updated web/.env.local NEXT_PUBLIC_CONTRACT_ADDRESS");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
