import { createWalletClient, custom, parseEther } from "viem";
import { monadTestnet } from "viem/chains";
import { TASKRAIL_ABI } from "./abi";
import { getContractAddress, getPublicClient, MONAD_RPC_URL } from "./chain";

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
  }
}

export async function connectBrowserWallet(): Promise<`0x${string}`> {
  if (typeof window === "undefined" || !window.ethereum) {
    throw new Error("未检测到浏览器钱包扩展（请安装 MetaMask 或 Rabby，或直接切到右侧「1-Click Demo Wallet」免钱包体验）");
  }
  const accounts = (await window.ethereum.request({
    method: "eth_requestAccounts",
  })) as string[];
  if (!accounts || accounts.length === 0) {
    throw new Error("未授权任何钱包账户");
  }

  // Ensure Monad Testnet (Chain ID 10143 = 0x279f)
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x279f" }],
    });
  } catch (err: unknown) {
    const code = (err as { code?: number })?.code;
    if (code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: "0x279f",
            chainName: "Monad Testnet",
            nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
            rpcUrls: [MONAD_RPC_URL],
            blockExplorerUrls: ["https://testnet.monadscan.com"],
          },
        ],
      });
    } else {
      throw err;
    }
  }

  return accounts[0] as `0x${string}`;
}

export async function browserCreateTask(params: {
  account: `0x${string}`;
  taskId: `0x${string}`;
  agent: `0x${string}`;
  verifier: `0x${string}`;
  totalChecks: number;
  finalBonusBps: number;
  deadline: bigint;
  challengeWindow: bigint;
  runHash: `0x${string}`;
  rewardMon: string;
}) {
  if (!window.ethereum) throw new Error("Wallet not found");
  const contractAddress = getContractAddress();
  const publicClient = getPublicClient();
  const walletClient = createWalletClient({
    account: params.account,
    chain: monadTestnet,
    transport: custom(window.ethereum),
  });

  const value = parseEther(params.rewardMon);
  const estimate = await publicClient.estimateContractGas({
    address: contractAddress,
    abi: TASKRAIL_ABI,
    account: params.account,
    functionName: "createTask",
    args: [
      params.taskId,
      params.agent,
      params.verifier,
      params.totalChecks,
      params.finalBonusBps,
      params.deadline,
      params.challengeWindow,
      params.runHash,
    ],
    value,
  });
  const gas = estimate + (estimate * 6n) / 100n + 3000n;

  const txHash = await walletClient.writeContract({
    address: contractAddress,
    abi: TASKRAIL_ABI,
    functionName: "createTask",
    args: [
      params.taskId,
      params.agent,
      params.verifier,
      params.totalChecks,
      params.finalBonusBps,
      params.deadline,
      params.challengeWindow,
      params.runHash,
    ],
    value,
    gas,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, pollingInterval: 250 });
  return { txHash, blockNumber: receipt.blockNumber.toString() };
}

export async function browserRefundRemaining(params: {
  account: `0x${string}`;
  taskId: `0x${string}`;
}) {
  if (!window.ethereum) throw new Error("Wallet not found");
  const contractAddress = getContractAddress();
  const publicClient = getPublicClient();
  const walletClient = createWalletClient({
    account: params.account,
    chain: monadTestnet,
    transport: custom(window.ethereum),
  });

  const estimate = await publicClient.estimateContractGas({
    address: contractAddress,
    abi: TASKRAIL_ABI,
    account: params.account,
    functionName: "refundRemaining",
    args: [params.taskId],
  });
  const gas = estimate + (estimate * 6n) / 100n + 3000n;

  const txHash = await walletClient.writeContract({
    address: contractAddress,
    abi: TASKRAIL_ABI,
    functionName: "refundRemaining",
    args: [params.taskId],
    gas,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, pollingInterval: 250 });
  return { txHash, blockNumber: receipt.blockNumber.toString() };
}
