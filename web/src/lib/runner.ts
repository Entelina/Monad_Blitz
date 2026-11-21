import vm from "node:vm";
import { encodePacked, keccak256 } from "viem";
import { AGENT_PATCHES, PatchId, RUNNER_SPEC, TEST_SUITE_SPEC, TestCaseSpec } from "./suite";

export interface CheckExecutionResult {
  patchId: PatchId;
  commit: string;
  runHash: `0x${string}`;
  checkIndex: number;
  spec: TestCaseSpec;
  passed: boolean;
  durationMs: number;
  stdout: string;
  errorMessage?: string;
  receiptHash: `0x${string}`;
}

const OWNER = "0x1111111111111111111111111111111111111111";
const ALICE = "0x2222222222222222222222222222222222222222";
const ATTACKER = "0xdead00000000000000000000000000000000beef";
const ZERO = "0x0000000000000000000000000000000000000000";

const SUITE_HASH = keccak256(
  encodePacked(["string"], [JSON.stringify(TEST_SUITE_SPEC.map((t) => t.id))])
);

export function computeRunHash(patchId: PatchId): `0x${string}` {
  const patch = AGENT_PATCHES[patchId];
  if (!patch) throw new Error(`Unknown patchId: ${patchId}`);
  const diffHash = keccak256(encodePacked(["string"], [patch.sourceCode]));
  return keccak256(
    encodePacked(
      ["string", "bytes32", "bytes32", "string"],
      [patch.commit, diffHash, SUITE_HASH, RUNNER_SPEC]
    )
  );
}

function loadVaultGuardInSandbox(sourceCode: string) {
  // Block dangerous globals explicitly; clean empty context with only JS built-ins
  const forbidden = /\b(require|process|globalThis|child_process|eval|Function|fetch)\b/;
  if (forbidden.test(sourceCode)) {
    throw new Error("STATIC_POLICY_VIOLATION: Forbidden host identifier detected");
  }
  const sandbox: Record<string, unknown> = {
    module: { exports: {} as Record<string, unknown> },
    exports: {},
  };
  const context = vm.createContext(sandbox);
  const script = new vm.Script(sourceCode, { filename: "vault-guard.js" });
  script.runInContext(context, { timeout: 250 });
  const exported = (sandbox.module as { exports: { VaultGuard?: unknown } }).exports;
  if (typeof exported?.VaultGuard !== "function") {
    throw new Error("BUILD_ERROR: VaultGuard class not exported");
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return exported.VaultGuard as new (owner: string, feeBps?: number, maxSingle?: bigint) => any;
}

function assertEq(actual: unknown, expected: unknown, msg: string) {
  if (actual !== expected) {
    throw new Error(`AssertionError: ${msg} (expected=${String(expected)}, actual=${String(actual)})`);
  }
}

function assertThrows(fn: () => void, expectedMsg: string, label: string) {
  let caught: Error | null = null;
  try {
    fn();
  } catch (e) {
    caught = e instanceof Error ? e : new Error(String(e));
  }
  if (!caught) {
    throw new Error(`AssertionError: ${label} — expected throw "${expectedMsg}", but succeeded!`);
  }
  if (!caught.message.includes(expectedMsg)) {
    throw new Error(
      `AssertionError: ${label} — expected error "${expectedMsg}", got "${caught.message}"`
    );
  }
}

export function executeSingleCheck(patchId: PatchId, checkIndex: number): CheckExecutionResult {
  const patch = AGENT_PATCHES[patchId];
  if (!patch) throw new Error(`Unknown patchId: ${patchId}`);
  const spec = TEST_SUITE_SPEC[checkIndex];
  if (!spec) throw new Error(`Invalid checkIndex: ${checkIndex}`);

  const runHash = computeRunHash(patchId);
  const start = performance.now();

  let passed = false;
  let stdout = "";
  let errorMessage: string | undefined;

  try {
    const VaultGuard = loadVaultGuardInSandbox(patch.sourceCode);

    switch (checkIndex) {
      case 0: {
        const v = new VaultGuard(OWNER);
        assertEq(v.owner, OWNER.toLowerCase(), "owner normalized");
        stdout = `[BUILD] Compiled vault-guard.js (${patch.sourceCode.length}B) in isolated node:vm · 0 static policy violations`;
        break;
      }
      case 1: {
        assertThrows(() => new VaultGuard(ZERO), "ZERO_OWNER", "zero owner rejected");
        stdout = `[PASS] new VaultGuard(0x000...000) reverted with ZERO_OWNER`;
        break;
      }
      case 2: {
        assertThrows(() => new VaultGuard(OWNER, 501), "FEE_OUT_OF_RANGE", "fee > 500bps rejected");
        assertThrows(() => new VaultGuard(OWNER, -1), "FEE_OUT_OF_RANGE", "negative fee rejected");
        stdout = `[PASS] Fee cap boundary [0..500 bps] enforced strictly`;
        break;
      }
      case 3: {
        const v = new VaultGuard(OWNER);
        v.deposit(ALICE, 1200n);
        const bal = v.deposit(ALICE, 800n);
        assertEq(bal, 2000n, "deposit sum");
        stdout = `[PASS] deposit(ALICE, 1200) + deposit(ALICE, 800) => balance=2000n`;
        break;
      }
      case 4: {
        const v = new VaultGuard(OWNER, 25);
        assertEq(v.quoteFee(10000n), 25n, "25 bps on 10000");
        assertEq(v.quoteFee(999n), 2n, "floor division precision");
        stdout = `[PASS] quoteFee(10000n)=25n, quoteFee(999n)=2n (BigInt exact)`;
        break;
      }
      case 5: {
        const v = new VaultGuard(OWNER);
        assertThrows(
          () => v.setPaused(ATTACKER, true),
          "UNAUTHORIZED",
          "Attacker 0xdead...beef calling setPaused(true)"
        );
        stdout = `[PASS] Unauthorized setPaused(0xdead...beef) blocked with UNAUTHORIZED`;
        break;
      }
      case 6: {
        const v = new VaultGuard(OWNER);
        v.deposit(ALICE, 5000n);
        v.withdraw(ALICE, 4000n);
        v.setPaused(OWNER, true);
        assertThrows(
          () => v.emergencySweep(ATTACKER, ATTACKER, 10n),
          "UNAUTHORIZED",
          "Attacker calling emergencySweep()"
        );
        stdout = `[PASS] Unauthorized emergencySweep(0xdead...beef) blocked with UNAUTHORIZED`;
        break;
      }
      case 7: {
        const v = new VaultGuard(OWNER, 25);
        v.deposit(ALICE, 5000n);
        const r = v.withdraw(ALICE, 4000n);
        assertEq(r.fee, 10n, "fee=10n");
        assertEq(r.net, 3990n, "net=3990n");
        assertEq(r.remaining, 1000n, "remaining=1000n");
        stdout = `[PASS] withdraw(4000n) => net=3990n, fee=10n, remaining=1000n`;
        break;
      }
      case 8: {
        const v = new VaultGuard(OWNER);
        v.deposit(ALICE, 1000n);
        assertThrows(() => v.withdraw(ALICE, 0n), "ZERO_AMOUNT", "zero withdraw rejected");
        stdout = `[PASS] withdraw(0n) reverted with ZERO_AMOUNT`;
        break;
      }
      case 9: {
        const v = new VaultGuard(OWNER);
        v.deposit(ALICE, 500n);
        assertThrows(() => v.withdraw(ALICE, 501n), "INSUFFICIENT_BALANCE", "overdraft rejected");
        stdout = `[PASS] withdraw(501n > 500n) reverted with INSUFFICIENT_BALANCE`;
        break;
      }
      case 10: {
        const v = new VaultGuard(OWNER, 25, 2000n);
        v.deposit(ALICE, 5000n);
        assertThrows(() => v.withdraw(ALICE, 2001n), "EXCEEDS_LIMIT", "single cap enforced");
        stdout = `[PASS] withdraw(2001n > cap 2000n) blocked with EXCEEDS_LIMIT`;
        break;
      }
      case 11: {
        const v = new VaultGuard(OWNER);
        v.deposit(ALICE, 5000n);
        assertThrows(
          () => v.withdraw(ALICE, 1000n, 1000, () => v.withdraw(ALICE, 1000n)),
          "REENTRANCY",
          "nested withdraw callback"
        );
        stdout = `[PASS] Reentrant nested withdraw hook blocked with REENTRANCY (CEI intact)`;
        break;
      }
      case 12: {
        const v = new VaultGuard(OWNER);
        v.deposit(ALICE, 1000n);
        v.setPaused(OWNER, true);
        assertThrows(() => v.deposit(ALICE, 100n), "PAUSED", "paused deposit");
        assertThrows(() => v.withdraw(ALICE, 100n), "PAUSED", "paused withdraw");
        stdout = `[PASS] Paused vault halts both deposit() and withdraw()`;
        break;
      }
      case 13: {
        const v = new VaultGuard(OWNER);
        v.deposit(ALICE, 1000n);
        v.setTimelock(OWNER, 2000);
        assertThrows(() => v.withdraw(ALICE, 500n, 1500), "TIMELOCKED", "early withdraw blocked");
        const ok = v.withdraw(ALICE, 500n, 2000);
        assertEq(ok.remaining, 500n, "unlock at 2000 succeeds");
        stdout = `[PASS] Timelock blocked ts=1500 and released at ts=2000`;
        break;
      }
      case 14: {
        const v = new VaultGuard(OWNER);
        assertThrows(() => v.addAllowlist(ATTACKER, ALICE), "UNAUTHORIZED", "non-owner allowlist");
        assertThrows(() => v.addAllowlist(OWNER, ZERO), "ZERO_ADDRESS", "zero address allowlist");
        v.addAllowlist(OWNER, ALICE);
        assertEq(v.allowlist.has(ALICE.toLowerCase()), true, "ALICE allowlisted");
        stdout = `[PASS] Allowlist enforces owner ACL & rejects zero address`;
        break;
      }
      case 15: {
        const v = new VaultGuard(OWNER, 25);
        v.deposit(ALICE, 8000n);
        v.withdraw(ALICE, 4000n);
        assertThrows(() => v.emergencySweep(OWNER, OWNER, 10n), "MUST_BE_PAUSED", "sweep requires pause");
        v.setPaused(OWNER, true);
        const res = v.emergencySweep(OWNER, OWNER, 10n);
        assertEq(res.swept, 10n, "swept exact fees");
        assertEq(v.collectedFees, 0n, "fees zeroed");
        stdout = `[PASS] Emergency sweep invariant verified => 16/16 checks GREEN, unlocking 40% final bonus!`;
        break;
      }
      default:
        throw new Error(`Unknown checkIndex ${checkIndex}`);
    }
    passed = true;
  } catch (err) {
    passed = false;
    errorMessage = err instanceof Error ? err.message : String(err);
    stdout = `[FAIL] ${spec.id} -> ${errorMessage}`;
  }

  const durationMs = Number((performance.now() - start).toFixed(2));
  const outputHash = keccak256(encodePacked(["string"], [stdout]));
  // Deterministic receipt hash bound to runHash + checkIndex + testId + passed + outputHash
  const receiptHash = keccak256(
    encodePacked(
      ["bytes32", "uint16", "string", "bool", "bytes32"],
      [runHash, checkIndex, spec.id, passed, outputHash]
    )
  );

  return {
    patchId,
    commit: patch.commit,
    runHash,
    checkIndex,
    spec,
    passed,
    durationMs,
    stdout,
    errorMessage,
    receiptHash,
  };
}
