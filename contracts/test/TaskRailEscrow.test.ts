import { expect } from "chai";
import hre from "hardhat";
import { keccak256, parseEther, toHex, encodePacked } from "viem";
import { time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";

describe("TaskRailEscrow", function () {
  async function deployFixture() {
    const [employer, agent, verifier, relayer, challenger] =
      await hre.viem.getWalletClients();
    const publicClient = await hre.viem.getPublicClient();
    const escrow = await hre.viem.deployContract("TaskRailEscrow");
    return { escrow, employer, agent, verifier, relayer, challenger, publicClient };
  }

  function makeTaskId(label: string) {
    return keccak256(toHex(label));
  }

  function makeRunHash(commit: string) {
    return keccak256(encodePacked(["string", "string"], ["run:", commit]));
  }

  function makeReceipt(checkIdx: number, passed: boolean, salt = "v1") {
    return keccak256(
      encodePacked(["uint16", "bool", "string"], [checkIdx, passed, salt])
    );
  }

  it("streams 16 consecutive checks (direct path) with zero trapped wei and completes", async function () {
    const { escrow, employer, agent, verifier, publicClient } = await deployFixture();
    const now = BigInt(await time.latest());
    const taskId = makeTaskId("task-pass-16");
    const runHash = makeRunHash("commit-abc123");
    const totalReward = parseEther("2.0"); // 15 * 0.08 + 0.80 final bonus = 2.0 MON
    const totalChecks = 16;
    const finalBonusBps = 4000;

    await escrow.write.createTask(
      [taskId, agent.account.address, verifier.account.address, totalChecks, finalBonusBps, now + 600n, 60n, "0x0000000000000000000000000000000000000000000000000000000000000000"],
      { value: totalReward, account: employer.account }
    );

    const agentBalBefore = await publicClient.getBalance({ address: agent.account.address });
    let totalGasUsed = 0n;

    for (let i = 0; i < totalChecks; i++) {
      const hash = await escrow.write.recordCheckDirect(
        [taskId, i, true, runHash, makeReceipt(i, true)],
        { account: verifier.account }
      );
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      totalGasUsed += receipt.gasUsed;
    }

    const agentBalAfter = await publicClient.getBalance({ address: agent.account.address });
    expect(agentBalAfter - agentBalBefore).to.equal(totalReward);

    const task = await escrow.read.getTask([taskId]);
    expect(task.status).to.equal(1); // COMPLETED
    expect(task.passedChecks).to.equal(16);
    expect(task.remainingReward).to.equal(0n);
    expect(task.paidReward).to.equal(totalReward);
    expect(task.runHash).to.equal(runHash);

    const contractBal = await publicClient.getBalance({ address: escrow.address });
    expect(contractBal).to.equal(0n);

    const checks = await escrow.read.getAllChecks([taskId]);
    expect(checks.length).to.equal(16);
    expect(checks[0].payout).to.equal(parseEther("0.08"));
    expect(checks[15].payout).to.equal(parseEther("0.8"));
    console.log(`    [gas] 16 direct checks avg gasUsed = ${totalGasUsed / 16n}`);
  });

  it("halts immediately on check 5 failure and refunds 80% remaining reward to employer", async function () {
    const { escrow, employer, agent, verifier, publicClient } = await deployFixture();
    const now = BigInt(await time.latest());
    const taskId = makeTaskId("task-halt-at-5");
    const runHash = makeRunHash("commit-bad-auth");
    const totalReward = parseEther("2.0");

    await escrow.write.createTask(
      [taskId, agent.account.address, verifier.account.address, 16, 4000, now + 600n, 60n, runHash],
      { value: totalReward, account: employer.account }
    );

    // Checks 0..4 pass (5 * 0.08 = 0.40 MON streamed)
    for (let i = 0; i < 5; i++) {
      await escrow.write.recordCheckDirect(
        [taskId, i, true, runHash, makeReceipt(i, true)],
        { account: verifier.account }
      );
    }

    // Check 5 fails -> immediate circuit breaker
    await escrow.write.recordCheckDirect(
      [taskId, 5, false, runHash, makeReceipt(5, false)],
      { account: verifier.account }
    );

    const haltedTask = await escrow.read.getTask([taskId]);
    expect(haltedTask.status).to.equal(2); // HALTED
    expect(haltedTask.paidReward).to.equal(parseEther("0.4"));
    expect(haltedTask.remainingReward).to.equal(parseEther("1.6"));

    // Subsequent check must revert
    let reverted = false;
    try {
      await escrow.write.recordCheckDirect(
        [taskId, 6, true, runHash, makeReceipt(6, true)],
        { account: verifier.account }
      );
    } catch {
      reverted = true;
    }
    expect(reverted).to.equal(true);

    // Employer refunds remaining 1.6 MON
    const empBefore = await publicClient.getBalance({ address: employer.account.address });
    const refundHash = await escrow.write.refundRemaining([taskId], {
      account: employer.account,
    });
    const refundReceipt = await publicClient.waitForTransactionReceipt({ hash: refundHash });
    const empAfter = await publicClient.getBalance({ address: employer.account.address });
    const gasCost = refundReceipt.gasUsed * refundReceipt.effectiveGasPrice;

    expect(empAfter + gasCost - empBefore).to.equal(parseEther("1.6"));

    const refundedTask = await escrow.read.getTask([taskId]);
    expect(refundedTask.status).to.equal(4); // REFUNDED
    expect(refundedTask.remainingReward).to.equal(0n);
  });

  it("verifies EIP-712 signature path and compares gas vs direct path", async function () {
    const { escrow, employer, agent, verifier, relayer, publicClient } = await deployFixture();
    const now = BigInt(await time.latest());
    const taskId = makeTaskId("task-eip712");
    const runHash = makeRunHash("commit-sig-1");
    const chainId = await publicClient.getChainId();

    await escrow.write.createTask(
      [taskId, agent.account.address, verifier.account.address, 4, 4000, now + 600n, 60n, runHash],
      { value: parseEther("1.0"), account: employer.account }
    );

    const receipt0 = makeReceipt(0, true);
    const sig0 = await verifier.signTypedData({
      domain: {
        name: "TaskRailEscrow",
        version: "1",
        chainId,
        verifyingContract: escrow.address,
      },
      types: {
        CheckAttestation: [
          { name: "taskId", type: "bytes32" },
          { name: "runHash", type: "bytes32" },
          { name: "checkIndex", type: "uint16" },
          { name: "passed", type: "bool" },
          { name: "receiptHash", type: "bytes32" },
        ],
      },
      primaryType: "CheckAttestation",
      message: {
        taskId,
        runHash,
        checkIndex: 0,
        passed: true,
        receiptHash: receipt0,
      },
    });

    // Relayer (not verifier) submits with verifier EIP-712 signature
    const txSig = await escrow.write.recordCheckWithSig(
      [taskId, 0, true, runHash, receipt0, sig0],
      { account: relayer.account }
    );
    const rSig = await publicClient.waitForTransactionReceipt({ hash: txSig });

    // Direct path for check 1
    const txDirect = await escrow.write.recordCheckDirect(
      [taskId, 1, true, runHash, makeReceipt(1, true)],
      { account: verifier.account }
    );
    const rDirect = await publicClient.waitForTransactionReceipt({ hash: txDirect });

    console.log(
      `    [gas] recordCheckWithSig = ${rSig.gasUsed}, recordCheckDirect = ${rDirect.gasUsed}`
    );
    expect(rSig.gasUsed > rDirect.gasUsed).to.equal(true);

    // Reject forged signature from non-verifier
    const forgedSig = await relayer.signTypedData({
      domain: {
        name: "TaskRailEscrow",
        version: "1",
        chainId,
        verifyingContract: escrow.address,
      },
      types: {
        CheckAttestation: [
          { name: "taskId", type: "bytes32" },
          { name: "runHash", type: "bytes32" },
          { name: "checkIndex", type: "uint16" },
          { name: "passed", type: "bool" },
          { name: "receiptHash", type: "bytes32" },
        ],
      },
      primaryType: "CheckAttestation",
      message: {
        taskId,
        runHash,
        checkIndex: 2,
        passed: true,
        receiptHash: makeReceipt(2, true),
      },
    });

    let sigFailed = false;
    try {
      await escrow.write.recordCheckWithSig(
        [taskId, 2, true, runHash, makeReceipt(2, true), forgedSig],
        { account: relayer.account }
      );
    } catch {
      sigFailed = true;
    }
    expect(sigFailed).to.equal(true);
  });

  it("blocks mixed runHash attacks and allows deadline expiry refunds", async function () {
    const { escrow, employer, agent, verifier } = await deployFixture();
    const now = BigInt(await time.latest());
    const taskId = makeTaskId("task-runhash-and-expiry");
    const runHashA = makeRunHash("commit-A");
    const runHashB = makeRunHash("commit-B");

    await escrow.write.createTask(
      [taskId, agent.account.address, verifier.account.address, 4, 4000, now + 120n, 60n, "0x0000000000000000000000000000000000000000000000000000000000000000"],
      { value: parseEther("1.0"), account: employer.account }
    );

    // Check 0 locks runHashA
    await escrow.write.recordCheckDirect(
      [taskId, 0, true, runHashA, makeReceipt(0, true)],
      { account: verifier.account }
    );

    // Check 1 with runHashB must revert
    let mismatchReverted = false;
    try {
      await escrow.write.recordCheckDirect(
        [taskId, 1, true, runHashB, makeReceipt(1, true)],
        { account: verifier.account }
      );
    } catch {
      mismatchReverted = true;
    }
    expect(mismatchReverted).to.equal(true);

    // Advance past deadline
    await time.increase(130);

    // Check after deadline must revert
    let expiredReverted = false;
    try {
      await escrow.write.recordCheckDirect(
        [taskId, 1, true, runHashA, makeReceipt(1, true)],
        { account: verifier.account }
      );
    } catch {
      expiredReverted = true;
    }
    expect(expiredReverted).to.equal(true);

    // Employer can refund remaining 0.8 MON after deadline
    await escrow.write.refundRemaining([taskId], { account: employer.account });
    const t = await escrow.read.getTask([taskId]);
    expect(t.status).to.equal(4); // REFUNDED
    expect(t.remainingReward).to.equal(0n);
  });

  it("supports same-runHash independent re-run dispute freezing remaining funds", async function () {
    const { escrow, employer, agent, verifier, challenger } = await deployFixture();
    const now = BigInt(await time.latest());
    const taskId = makeTaskId("task-dispute");
    const runHash = makeRunHash("commit-dispute");

    await escrow.write.createTask(
      [taskId, agent.account.address, verifier.account.address, 4, 4000, now + 600n, 120n, runHash],
      { value: parseEther("1.0"), account: employer.account }
    );

    // Verifier falsely attests check 0 as passed
    await escrow.write.recordCheckDirect(
      [taskId, 0, true, runHash, makeReceipt(0, true, "forged-pass")],
      { account: verifier.account }
    );

    // Independent challenger re-runs same runHash and gets conflicting receiptHash
    const counterReceipt = makeReceipt(0, false, "independent-rerun-fail");
    await escrow.write.disputeCheck(
      [taskId, 0, counterReceipt, "Independent re-run on same runHash failed assertion"],
      { account: challenger.account }
    );

    const task = await escrow.read.getTask([taskId]);
    expect(task.status).to.equal(3); // DISPUTED

    // Verifier is blocked from streaming further checks
    let blocked = false;
    try {
      await escrow.write.recordCheckDirect(
        [taskId, 1, true, runHash, makeReceipt(1, true)],
        { account: verifier.account }
      );
    } catch {
      blocked = true;
    }
    expect(blocked).to.equal(true);

    // Employer can recover remaining unreleased reward
    await escrow.write.refundRemaining([taskId], { account: employer.account });
    const finalTask = await escrow.read.getTask([taskId]);
    expect(finalTask.status).to.equal(4);
    expect(finalTask.remainingReward).to.equal(0n);
  });
});
