import { createPublicClient, http } from "viem";
import { monadTestnet } from "viem/chains";

export const MONAD_RPC_URL =
  process.env.NEXT_PUBLIC_MONAD_RPC || "https://testnet-rpc.monad.xyz";

export const MONAD_WSS_URL =
  process.env.NEXT_PUBLIC_MONAD_WSS || "wss://testnet-rpc.monad.xyz";

export const MONAD_EXPLORER_URL = "https://testnet.monadscan.com";

export function getPublicClient() {
  return createPublicClient({
    chain: monadTestnet,
    transport: http(MONAD_RPC_URL, {
      retryCount: 2,
      retryDelay: 300,
    }),
  });
}

export function getContractAddress(): `0x${string}` {
  const addr = process.env.NEXT_PUBLIC_CONTRACT_ADDRESS;
  if (!addr || !addr.startsWith("0x") || addr.length !== 42) {
    return "0x0000000000000000000000000000000000000000";
  }
  return addr as `0x${string}`;
}

export function txExplorerUrl(hash: string) {
  return `${MONAD_EXPLORER_URL}/tx/${hash}`;
}

export function addressExplorerUrl(addr: string) {
  return `${MONAD_EXPLORER_URL}/address/${addr}`;
}
