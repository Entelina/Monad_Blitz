export type PatchId = "patch-pass" | "patch-fail";

export interface AgentPatch {
  id: PatchId;
  prNumber: string;
  title: string;
  agentName: string;
  commit: string;
  summary: string;
  diffPreview: string[];
  sourceCode: string;
}

export interface TestCaseSpec {
  index: number;
  stage: "BUILD" | "UNIT";
  id: string;
  name: string;
  category: string;
  description: string;
}

export const RUNNER_SPEC = "taskrail-vm-runner@1.0.0:node24:strict-isolated-context";

/**
 * Target audited Patch A (16/16 checks pass):
 * Real DeFi Vault Withdrawal Guard written by an AI Coding Agent.
 */
const PATCH_PASS_SOURCE = `
class VaultGuard {
  constructor(owner, feeBps = 25, maxSingleWithdraw = 10000n) {
    if (!owner || owner === "0x0000000000000000000000000000000000000000") {
      throw new Error("ZERO_OWNER");
    }
    if (feeBps < 0 || feeBps > 500) {
      throw new Error("FEE_OUT_OF_RANGE");
    }
    this.owner = owner.toLowerCase();
    this.feeBps = BigInt(feeBps);
    this.maxSingleWithdraw = BigInt(maxSingleWithdraw);
    this.paused = false;
    this.locked = false;
    this.balances = new Map();
    this.allowlist = new Set([this.owner]);
    this.collectedFees = 0n;
    this.timelockUntil = 0;
  }

  deposit(user, amount) {
    if (this.paused) throw new Error("PAUSED");
    const amt = BigInt(amount);
    if (amt <= 0n) throw new Error("ZERO_AMOUNT");
    const key = user.toLowerCase();
    this.balances.set(key, (this.balances.get(key) || 0n) + amt);
    return this.balances.get(key);
  }

  setPaused(caller, flag) {
    if (caller.toLowerCase() !== this.owner) throw new Error("UNAUTHORIZED");
    this.paused = Boolean(flag);
  }

  addAllowlist(caller, addr) {
    if (caller.toLowerCase() !== this.owner) throw new Error("UNAUTHORIZED");
    if (!addr || addr === "0x0000000000000000000000000000000000000000") {
      throw new Error("ZERO_ADDRESS");
    }
    this.allowlist.add(addr.toLowerCase());
  }

  setTimelock(caller, unlockTs) {
    if (caller.toLowerCase() !== this.owner) throw new Error("UNAUTHORIZED");
    this.timelockUntil = Number(unlockTs);
  }

  quoteFee(amount) {
    const amt = BigInt(amount);
    if (amt < 0n) throw new Error("NEGATIVE_AMOUNT");
    return (amt * this.feeBps) / 10000n;
  }

  withdraw(caller, amount, nowTs = 1000, hook = null) {
    if (this.paused) throw new Error("PAUSED");
    if (this.locked) throw new Error("REENTRANCY");
    if (Number(nowTs) < this.timelockUntil) throw new Error("TIMELOCKED");

    const amt = BigInt(amount);
    if (amt <= 0n) throw new Error("ZERO_AMOUNT");
    if (amt > this.maxSingleWithdraw) throw new Error("EXCEEDS_LIMIT");

    const key = caller.toLowerCase();
    const bal = this.balances.get(key) || 0n;
    if (bal < amt) throw new Error("INSUFFICIENT_BALANCE");

    this.locked = true;
    try {
      // Checks-Effects-Interactions: deduct before callback
      const fee = this.quoteFee(amt);
      const net = amt - fee;
      this.balances.set(key, bal - amt);
      this.collectedFees += fee;
      if (typeof hook === "function") hook();
      return { gross: amt, fee, net, remaining: this.balances.get(key) };
    } finally {
      this.locked = false;
    }
  }

  emergencySweep(caller, recipient, amount) {
    if (caller.toLowerCase() !== this.owner) throw new Error("UNAUTHORIZED");
    if (!this.paused) throw new Error("MUST_BE_PAUSED");
    if (!recipient || recipient === "0x0000000000000000000000000000000000000000") {
      throw new Error("ZERO_ADDRESS");
    }
    const amt = BigInt(amount);
    if (amt <= 0n || amt > this.collectedFees) throw new Error("INVALID_SWEEP");
    this.collectedFees -= amt;
    return { recipient: recipient.toLowerCase(), swept: amt };
  }
}
module.exports = { VaultGuard };
`;

/**
 * Target audited Patch B (Fails on Check #5: broken admin role check in setPaused/emergencySweep):
 * Passes build & basic deposit/withdraw/fee tests (Checks 0..4),
 * then triggers an auth bypass failure on Check #5 -> immediate onchain HALTED circuit breaker!
 */
const PATCH_FAIL_SOURCE = PATCH_PASS_SOURCE
  .replace(
    `  setPaused(caller, flag) {\n    if (caller.toLowerCase() !== this.owner) throw new Error("UNAUTHORIZED");\n    this.paused = Boolean(flag);\n  }`,
    `  setPaused(caller, flag) {\n    // BUG introduced by AI Agent refactor: missing owner role check!\n    this.paused = Boolean(flag);\n  }`
  )
  .replace(
    `  emergencySweep(caller, recipient, amount) {\n    if (caller.toLowerCase() !== this.owner) throw new Error("UNAUTHORIZED");`,
    `  emergencySweep(caller, recipient, amount) {\n    // BUG: skipped owner check during quick patch`
  );

export const AGENT_PATCHES: Record<PatchId, AgentPatch> = {
  "patch-pass": {
    id: "patch-pass",
    prNumber: "PR #142",
    title: "feat(vault): implement CEI withdrawal guard & owner ACL",
    agentName: "Claude-Code-Agent-07",
    commit: "7f4c91ae3b2d88f1092a4c7129e8d31b4a0f1190",
    summary: "Complete implementation with strict owner RBAC, CEI reentrancy lock, fee math, timelock, and emergency sweep checks.",
    diffPreview: [
      "@@ -31,6 +31,10 @@ class VaultGuard {",
      "+  setPaused(caller, flag) {",
      "+    if (caller.toLowerCase() !== this.owner) throw new Error('UNAUTHORIZED');",
      "+    this.paused = Boolean(flag);",
      "+  }",
      "+  emergencySweep(caller, recipient, amount) {",
      "+    if (caller.toLowerCase() !== this.owner) throw new Error('UNAUTHORIZED');",
    ],
    sourceCode: PATCH_PASS_SOURCE,
  },
  "patch-fail": {
    id: "patch-fail",
    prNumber: "PR #143",
    title: "refactor(vault): simplify pause & sweep helper (contains ACL bug)",
    agentName: "Codex-Refactor-Agent-03",
    commit: "3d8e20bf91a4c621d8b3009a1e72c45f88b0e214",
    summary: "Passes syntax & happy-path tests (#0-#4), but AI agent accidentally dropped owner check in setPaused/emergencySweep -> caught at Check #5.",
    diffPreview: [
      "@@ -31,6 +31,8 @@ class VaultGuard {",
      "   setPaused(caller, flag) {",
      "-    if (caller.toLowerCase() !== this.owner) throw new Error('UNAUTHORIZED');",
      "+    // AI refactor removed guard by mistake",
      "     this.paused = Boolean(flag);",
      "   }",
    ],
    sourceCode: PATCH_FAIL_SOURCE,
  },
};

export const TEST_SUITE_SPEC: TestCaseSpec[] = [
  { index: 0, stage: "BUILD", id: "build.compile_and_static_gate", name: "Syntax Compile & Static Security Gate", category: "Build", description: "Parses JS AST in isolated VM & blocks eval/Function/process access" },
  { index: 1, stage: "UNIT", id: "unit.ctor_reject_zero_owner", name: "Reject zero owner address in constructor", category: "Init", description: "Constructor must throw ZERO_OWNER for 0x000...000" },
  { index: 2, stage: "UNIT", id: "unit.ctor_fee_cap_500bps", name: "Enforce max protocol fee cap (<= 500 bps)", category: "Init", description: "Rejects feeBps > 500 or negative values" },
  { index: 3, stage: "UNIT", id: "unit.deposit_accumulates_balance", name: "Deposit accurately accumulates user balance", category: "Core", description: "Multiple deposits sum accurately using BigInt" },
  { index: 4, stage: "UNIT", id: "unit.fee_quote_bigint_precision", name: "Fee calculation matches 25 bps BigInt precision", category: "Math", description: "Verifies exact integer floor division for 10,000 wei" },
  { index: 5, stage: "UNIT", id: "unit.rbac_block_unauth_pause", name: "RBAC: block unauthorized caller from pausing vault", category: "Security", description: "Non-owner calling setPaused() must throw UNAUTHORIZED" },
  { index: 6, stage: "UNIT", id: "unit.rbac_block_unauth_sweep", name: "RBAC: block unauthorized emergencySweep", category: "Security", description: "Non-owner calling emergencySweep() must throw UNAUTHORIZED" },
  { index: 7, stage: "UNIT", id: "unit.withdraw_happy_path_net", name: "Withdraw deducts fee and returns exact net amount", category: "Core", description: "Withdraws 4000 with 25 bps fee -> net 3990, fee 10" },
  { index: 8, stage: "UNIT", id: "unit.withdraw_reject_zero", name: "Reject zero-amount withdrawal", category: "Validation", description: "Zero withdrawal must throw ZERO_AMOUNT" },
  { index: 9, stage: "UNIT", id: "unit.withdraw_reject_over_balance", name: "Reject withdrawal exceeding balance", category: "Validation", description: "Prevents overdraft via INSUFFICIENT_BALANCE" },
  { index: 10, stage: "UNIT", id: "unit.withdraw_enforce_single_cap", name: "Enforce single-transaction withdrawal limit", category: "Risk", description: "Blocks withdrawal above maxSingleWithdraw" },
  { index: 11, stage: "UNIT", id: "unit.reentrancy_guard_blocks_nested", name: "Reentrancy guard blocks nested withdraw callback", category: "Security", description: "Simulated reentrant hook triggers REENTRANCY error" },
  { index: 12, stage: "UNIT", id: "unit.pause_halts_deposits_and_withdrawals", name: "Paused vault halts deposits and withdrawals", category: "Safety", description: "Owner pause stops all fund movements" },
  { index: 13, stage: "UNIT", id: "unit.timelock_blocks_early_withdraw", name: "Timelock rejects withdrawal before unlockTs", category: "Risk", description: "Enforces TIMELOCKED prior to unlock timestamp" },
  { index: 14, stage: "UNIT", id: "unit.allowlist_rejects_zero_addr", name: "Allowlist rejects zero address & non-owner", category: "Access", description: "Checks owner ACL and ZERO_ADDRESS rejection" },
  { index: 15, stage: "UNIT", id: "unit.emergency_sweep_requires_pause_and_owner", name: "Emergency sweep requires paused state & exact fee cap", category: "Security", description: "Full end-to-end invariant check -> releases final 40% bonus" },
];
