import { NextResponse } from "next/server";
import { getContractAddress, MONAD_RPC_URL, MONAD_WSS_URL } from "@/lib/chain";
import { computeCommitAndRunHash } from "@/lib/runner";
import {
  ALL_MUTATION_IDS,
  BUG_MUTATIONS,
  BugMutationId,
  synthesizeVaultSource,
  TEST_SUITE_SPEC,
  UNVERIFIED_BOUNDARIES,
} from "@/lib/suite";
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

  // Precompute all 2^4 = 16 whitelisted mutation combinations so the UI shows exact live commit, diff & runHash instantaneously
  const presets: Record<
    string,
    {
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
  > = {};

  const n = ALL_MUTATION_IDS.length;
  for (let mask = 0; mask < 1 << n; mask++) {
    const combo: BugMutationId[] = [];
    for (let bit = 0; bit < n; bit++) {
      if ((mask & (1 << bit)) !== 0) combo.push(ALL_MUTATION_IDS[bit]);
    }
    const key = combo.join(",");
    const syn = synthesizeVaultSource(combo);
    const { commit, runHash } = computeCommitAndRunHash(combo);
    presets[key] = {
      mutations: combo,
      prNumber: syn.prNumber,
      title: syn.title,
      agentName: syn.agentName,
      summary: syn.summary,
      commit,
      runHash,
      diffPreview: syn.diffPreview,
      expectedFirstFailIndex: syn.expectedFirstFailIndex,
    };
  }

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
    bugMutations: BUG_MUTATIONS,
    unverifiedBoundaries: UNVERIFIED_BOUNDARIES,
    presets,
    tests: TEST_SUITE_SPEC,
  });
}
