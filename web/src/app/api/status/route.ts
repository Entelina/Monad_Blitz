import { NextResponse } from "next/server";
import { getContractAddress, MONAD_RPC_URL, MONAD_WSS_URL } from "@/lib/chain";
import { computeRunHash } from "@/lib/runner";
import { AGENT_PATCHES, TEST_SUITE_SPEC } from "@/lib/suite";
import {
  getDefaultAgentAddress,
  getDemoEmployerAccount,
  getVerifierAccount,
} from "@/lib/verifier";

export const dynamic = "force-dynamic";

export async function GET() {
  const contractAddress = getContractAddress();
  const verifier = getVerifierAccount();
  const demoEmployer = getDemoEmployerAccount();
  const agentAddress = getDefaultAgentAddress();

  return NextResponse.json({
    chainId: 10143,
    rpcUrl: MONAD_RPC_URL,
    wssUrl: MONAD_WSS_URL,
    contractAddress,
    contractReady: !/^0x0+$/.test(contractAddress),
    verifierAddress:
      verifier?.address ||
      process.env.NEXT_PUBLIC_VERIFIER_ADDRESS ||
      "0x0000000000000000000000000000000000000000",
    verifierReady: Boolean(verifier),
    demoEmployerAddress: demoEmployer?.address || null,
    demoModeReady: Boolean(demoEmployer && verifier && !/^0x0+$/.test(contractAddress)),
    agentAddress,
    patches: {
      "patch-pass": {
        ...AGENT_PATCHES["patch-pass"],
        runHash: computeRunHash("patch-pass"),
      },
      "patch-fail": {
        ...AGENT_PATCHES["patch-fail"],
        runHash: computeRunHash("patch-fail"),
      },
    },
    tests: TEST_SUITE_SPEC,
  });
}
