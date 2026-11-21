export type PatchId = "patch-pass" | "patch-fail";

export type BugMutationId =
  | "drop_fee_precision"
  | "drop_owner_acl"
  | "drop_withdraw_cap"
  | "drop_reentrancy_lock";

export interface BugMutationSpec {
  id: BugMutationId;
  label: string;
  shortTag: string;
  targetCheckIndex: number;
  targetCheckName: string;
  severity: "CRITICAL" | "HIGH";
  description: string;
  diffSnippet: string[];
}

export interface TestCaseSpec {
  index: number;
  stage: "BUILD" | "UNIT";
  id: string;
  name: string;
  category: string;
  description: string;
}

export interface UnverifiedBoundaryItem {
  id: string;
  scope: string;
  reason: string;
  owner: "HUMAN_AUDIT" | "FORMAL_VERIFICATION" | "SUPPLY_CHAIN";
}

export const RUNNER_SPEC = "taskrail-vm-runner@1.1.0:node24:strict-isolated-context";

/**
 * Clean audited baseline implementation (16/16 checks pass).
 * Any selected BugMutationId dynamically mutates real lines of this source code
 * before compilation & execution inside isolated node:vm.
 */
export const BASELINE_VAULT_SOURCE = `
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

export const BUG_MUTATIONS: BugMutationSpec[] = [
  {
    id: "drop_fee_precision",
    label: "破坏手续费 BigInt 分母精度",
    shortTag: "FEE ×10 BUG",
    targetCheckIndex: 4,
    targetCheckName: "Check #04 · Fee Precision",
    severity: "HIGH",
    description: "将 quoteFee 分母 10000n 错写为 1000n，导致用户被多扣 10 倍手续费",
    diffSnippet: [
      "@@ -47,4 +47,4 @@ quoteFee(amount) {",
      "-    return (amt * this.feeBps) / 10000n;",
      "+    return (amt * this.feeBps) / 1000n; // MUTATED: 10x fee overcharge bug",
    ],
  },
  {
    id: "drop_owner_acl",
    label: "删除 Owner 权限校验 (ACL)",
    shortTag: "ACL BYPASS",
    targetCheckIndex: 5,
    targetCheckName: "Check #05 · Owner RBAC",
    severity: "CRITICAL",
    description: "重构时遗漏 setPaused() 与 emergencySweep() 的 owner 身份校验",
    diffSnippet: [
      "@@ -31,5 +31,5 @@ setPaused(caller, flag) {",
      "-    if (caller.toLowerCase() !== this.owner) throw new Error('UNAUTHORIZED');",
      "+    // MUTATED: AI refactor dropped owner ACL guard",
      "     this.paused = Boolean(flag);",
    ],
  },
  {
    id: "drop_withdraw_cap",
    label: "取消单笔提现风控上限",
    shortTag: "NO WITHDRAW CAP",
    targetCheckIndex: 10,
    targetCheckName: "Check #10 · Single Cap",
    severity: "HIGH",
    description: "移除 withdraw() 中 maxSingleWithdraw 限额校验，允许单笔掏空金库",
    diffSnippet: [
      "@@ -59,3 +59,3 @@ withdraw(caller, amount, nowTs, hook) {",
      "-    if (amt > this.maxSingleWithdraw) throw new Error('EXCEEDS_LIMIT');",
      "+    // MUTATED: single-tx withdrawal cap check removed",
    ],
  },
  {
    id: "drop_reentrancy_lock",
    label: "移除 CEI 重入锁保护",
    shortTag: "REENTRANCY",
    targetCheckIndex: 11,
    targetCheckName: "Check #11 · Reentrancy",
    severity: "CRITICAL",
    description: "移除 withdraw() 入口的 this.locked 重入锁检测，暴露嵌套回调攻击面",
    diffSnippet: [
      "@@ -54,3 +54,3 @@ withdraw(caller, amount, nowTs, hook) {",
      "-    if (this.locked) throw new Error('REENTRANCY');",
      "+    // MUTATED: reentrancy guard stripped during refactor",
    ],
  },
];

export const ALL_MUTATION_IDS: BugMutationId[] = BUG_MUTATIONS.map((m) => m.id);

export function normalizeMutations(input?: unknown): BugMutationId[] {
  if (!Array.isArray(input)) return [];
  const validSet = new Set<string>(ALL_MUTATION_IDS);
  const picked = new Set<BugMutationId>();
  for (const raw of input) {
    if (typeof raw === "string" && validSet.has(raw)) {
      picked.add(raw as BugMutationId);
    }
  }
  // Canonical deterministic ordering so runHash is 100% order-independent
  return ALL_MUTATION_IDS.filter((id) => picked.has(id));
}

export function resolveMutations(
  patchId?: PatchId,
  mutations?: unknown
): BugMutationId[] {
  if (Array.isArray(mutations)) {
    return normalizeMutations(mutations);
  }
  return patchId === "patch-fail" ? ["drop_owner_acl"] : [];
}

export function synthesizeVaultSource(mutations: BugMutationId[]): {
  mutations: BugMutationId[];
  sourceCode: string;
  diffPreview: string[];
  prNumber: string;
  title: string;
  agentName: string;
  summary: string;
  expectedFirstFailIndex: number | null;
} {
  const canonical = normalizeMutations(mutations);
  let code = BASELINE_VAULT_SOURCE;
  const diffLines: string[] = [];

  if (canonical.includes("drop_fee_precision")) {
    code = code.replace(
      `return (amt * this.feeBps) / 10000n;`,
      `return (amt * this.feeBps) / 1000n; // MUTATED: 10x fee overcharge bug`
    );
    diffLines.push(...BUG_MUTATIONS[0].diffSnippet);
  }

  if (canonical.includes("drop_owner_acl")) {
    code = code
      .replace(
        `  setPaused(caller, flag) {\n    if (caller.toLowerCase() !== this.owner) throw new Error("UNAUTHORIZED");\n    this.paused = Boolean(flag);\n  }`,
        `  setPaused(caller, flag) {\n    // MUTATED: AI refactor dropped owner ACL guard\n    this.paused = Boolean(flag);\n  }`
      )
      .replace(
        `  emergencySweep(caller, recipient, amount) {\n    if (caller.toLowerCase() !== this.owner) throw new Error("UNAUTHORIZED");`,
        `  emergencySweep(caller, recipient, amount) {\n    // MUTATED: skipped owner check`
      );
    diffLines.push(...BUG_MUTATIONS[1].diffSnippet);
  }

  if (canonical.includes("drop_withdraw_cap")) {
    code = code.replace(
      `if (amt > this.maxSingleWithdraw) throw new Error("EXCEEDS_LIMIT");`,
      `// MUTATED: single-tx withdrawal cap check removed`
    );
    diffLines.push(...BUG_MUTATIONS[2].diffSnippet);
  }

  if (canonical.includes("drop_reentrancy_lock")) {
    code = code.replace(
      `if (this.locked) throw new Error("REENTRANCY");`,
      `// MUTATED: reentrancy guard stripped during refactor`
    );
    diffLines.push(...BUG_MUTATIONS[3].diffSnippet);
  }

  if (canonical.length === 0) {
    return {
      mutations: canonical,
      sourceCode: code,
      diffPreview: [
        "@@ -31,6 +31,10 @@ class VaultGuard {",
        "+  setPaused(caller, flag) {",
        "+    if (caller.toLowerCase() !== this.owner) throw new Error('UNAUTHORIZED');",
        "+    this.paused = Boolean(flag);",
        "+  }",
        "+  if (this.locked) throw new Error('REENTRANCY');",
        "+  if (amt > this.maxSingleWithdraw) throw new Error('EXCEEDS_LIMIT');",
      ],
      prNumber: "PR #142",
      title: "feat(vault): verified CEI withdrawal guard & full owner ACL",
      agentName: "Claude-Code-Agent-07",
      summary:
        "Zero injected defects. Passes all 16 deterministic checks -> streams 15 micro-payouts + unlocks 40% final bonus.",
      expectedFirstFailIndex: null,
    };
  }

  const firstFail = Math.min(
    ...canonical.map(
      (id) => BUG_MUTATIONS.find((b) => b.id === id)!.targetCheckIndex
    )
  );
  const tags = canonical
    .map((id) => BUG_MUTATIONS.find((b) => b.id === id)!.shortTag)
    .join(" + ");

  const isDefaultPr143 =
    canonical.length === 1 && canonical[0] === "drop_owner_acl";

  return {
    mutations: canonical,
    sourceCode: code,
    diffPreview: diffLines,
    prNumber: isDefaultPr143 ? "PR #143" : "PR #143-MUTATED",
    title: isDefaultPr143
      ? "refactor(vault): simplify pause & sweep helper (ACL bug)"
      : `live-mutation(vault): injected [${tags}]`,
    agentName: isDefaultPr143
      ? "Codex-Refactor-Agent-03"
      : "Live-Mutated-Agent-PR",
    summary: `Sandbox executes real mutated code; expected to pass Checks #00..#${String(
      firstFail - 1
    ).padStart(2, "0")}, then throw AssertionError at Check #${String(
      firstFail
    ).padStart(2, "0")} -> instant HALTED circuit breaker.`,
    expectedFirstFailIndex: firstFail,
  };
}

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

export const UNVERIFIED_BOUNDARIES: UnverifiedBoundaryItem[] = [
  {
    id: "undecidable.product_spec_alignment",
    scope: "业务逻辑与产品需求偏差（Spec Drift）",
    reason: "单测只证明代码满足已写断言，无法判定需求本身是否合理或遗漏业务场景",
    owner: "HUMAN_AUDIT",
  },
  {
    id: "undecidable.zero_day_and_novel_vectors",
    scope: "测试集未覆盖的未知组合攻击 / 零日缺陷",
    reason: "熔断只能拦截已被测试覆盖的缺陷；未写入测试集的漏洞无法被自动发现",
    owner: "FORMAL_VERIFICATION",
  },
  {
    id: "undecidable.upstream_supply_chain",
    scope: "上游依赖投毒与单验证者执行器可信度",
    reason: "当前单验证者依赖同 runHash 复跑挑战约束，生产环境需升级 TEE 远程证明或 ERC-8004 质押多节点",
    owner: "SUPPLY_CHAIN",
  },
];
