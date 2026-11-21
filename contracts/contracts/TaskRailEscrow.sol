// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title TaskRailEscrow
 * @notice Streaming per-test-case verification & atomic micro-escrow for AI Coding Agents on Monad.
 * @dev Designed for Monad's 300ms slots, 600ms finality, MIP-8 page-warmed storage, and low gas cost:
 *      - Compact struct layout packs hot fields onto consecutive slots (same 4KB MIP-8 page).
 *      - Native MON transfers strictly use `.call{value: ...}("")` (never `.transfer()` / `.send()`).
 *      - Supports both:
 *          1) `recordCheckDirect` (authorized verifier msg.sender, avoids Monad's 2x ecRecover precompile gas)
 *          2) `recordCheckWithSig` (permissionless relayer/anyone submitting verifier's EIP-712 attestation)
 *      - Enforces a single `runHash` binding all checks to the exact commit + diff + test suite + runner config.
 *      - Enforces immediate circuit breaker (`HALTED`) on any failed check, deadline expiry refunds,
 *        and a same-`runHash` re-run dispute window (`disputeCheck`) to surface verifier dishonesty onchain.
 *      - Emits ERC-8004 Validation Registry compatible attestation semantics (`taskId`, `agent`, `passed`, `receiptHash`).
 */
contract TaskRailEscrow is ReentrancyGuard, EIP712 {
    using ECDSA for bytes32;

    enum TaskStatus {
        OPEN,       // 0: Active and accepting streaming checks
        COMPLETED,  // 1: All checks passed; full reward streamed
        HALTED,     // 2: Failed check triggered circuit breaker; remaining reward refundable
        DISPUTED,   // 3: Same-runHash re-run disputed an attested check; remaining reward frozen/refundable
        REFUNDED    // 4: Remaining reward refunded to employer
    }

    struct Task {
        // Slot 0
        address employer;
        uint64 deadline;
        uint16 totalChecks;
        uint16 passedChecks;
        // Slot 1
        address agent;
        uint64 challengeWindow;
        uint16 nextCheckIndex;
        uint16 finalBonusBps; // e.g. 4000 = 40% final completion bonus; 0 = equal per-check split
        // Slot 2
        address verifier;
        uint64 lastCheckAt;
        TaskStatus status;
        bool exists;
        // Slot 3
        uint256 totalReward;
        // Slot 4
        uint256 remainingReward;
        // Slot 5
        uint256 paidReward;
        // Slot 6
        bytes32 runHash;
    }

    struct CheckRecord {
        bytes32 receiptHash;
        uint256 payout;
        uint64 recordedAt;
        uint16 checkIndex;
        bool passed;
        bool disputed;
        bool viaSignature;
    }

    struct DisputeRecord {
        address challenger;
        bytes32 counterReceiptHash;
        uint64 disputedAt;
        uint16 checkIndex;
        string reason;
    }

    bytes32 public constant CHECK_ATTESTATION_TYPEHASH = keccak256(
        "CheckAttestation(bytes32 taskId,bytes32 runHash,uint16 checkIndex,bool passed,bytes32 receiptHash)"
    );

    uint16 public constant MAX_CHECKS = 64;
    uint16 public constant MIN_CHECKS = 2;
    uint16 public constant MAX_FINAL_BONUS_BPS = 8000;
    uint64 public constant MIN_DEADLINE_BUFFER = 60; // Guard against Monad 1s timestamp granularity

    mapping(bytes32 => Task) private _tasks;
    mapping(bytes32 => mapping(uint16 => CheckRecord)) private _checks;
    mapping(bytes32 => DisputeRecord) private _disputes;

    // --- Events (Aligned with ERC-8004 validation attestation semantics) ---

    event TaskCreated(
        bytes32 indexed taskId,
        address indexed employer,
        address indexed agent,
        address verifier,
        uint256 totalReward,
        uint16 totalChecks,
        uint16 finalBonusBps,
        uint64 deadline,
        uint64 challengeWindow,
        bytes32 presetRunHash
    );

    event CheckAttested(
        bytes32 indexed taskId,
        address indexed agent,
        uint16 indexed checkIndex,
        bool passed,
        bytes32 runHash,
        bytes32 receiptHash,
        uint256 payout,
        bool viaSignature
    );

    event TaskHalted(
        bytes32 indexed taskId,
        uint16 failedCheckIndex,
        bytes32 runHash,
        bytes32 receiptHash,
        uint256 remainingRefundable
    );

    event TaskCompleted(
        bytes32 indexed taskId,
        address indexed agent,
        bytes32 runHash,
        uint256 totalPaid
    );

    event CheckDisputed(
        bytes32 indexed taskId,
        uint16 indexed checkIndex,
        address indexed challenger,
        bytes32 runHash,
        bytes32 attestedReceiptHash,
        bytes32 counterReceiptHash,
        string reason
    );

    event RemainingRefunded(
        bytes32 indexed taskId,
        address indexed employer,
        uint256 amount,
        bool expired
    );

    // --- Custom Errors ---

    error TaskAlreadyExists();
    error TaskNotFound();
    error InvalidAddress();
    error InvalidReward();
    error InvalidCheckCount();
    error InvalidBonusBps();
    error DeadlineTooSoon();
    error TaskNotOpen();
    error TaskExpired();
    error UnauthorizedVerifier();
    error InvalidSignature();
    error InvalidCheckOrder(uint16 expected, uint16 provided);
    error InvalidRunHash();
    error RunHashMismatch(bytes32 expected, bytes32 provided);
    error InvalidReceiptHash();
    error NothingToRefund();
    error RefundNotAllowed();
    error OnlyEmployer();
    error CheckNotRecorded();
    error ChallengeWindowClosed();
    error CounterReceiptMatchesAttested();
    error TransferFailed();

    constructor() EIP712("TaskRailEscrow", "1") {}

    /**
     * @notice Lock MON bounty for a streaming verification task.
     * @param taskId Unique task identifier (e.g. keccak256 of repo + PR + nonce).
     * @param agent AI coding agent payout address.
     * @param verifier Authorized verifier address whose direct tx or EIP-712 signature attests checks.
     * @param totalChecks Number of sequential checks (2..64, e.g. 16 = 1 build gate + 15 unit tests).
     * @param finalBonusBps Portion of totalReward (in bps, 0..8000) held as final completion bonus.
     * @param deadline Unix timestamp after which checks are rejected and employer can refund remaining MON.
     * @param challengeWindow Seconds after last check during which anyone can submit a same-runHash dispute.
     * @param presetRunHash Optional pre-committed runHash; pass bytes32(0) to lock on check 0.
     */
    function createTask(
        bytes32 taskId,
        address agent,
        address verifier,
        uint16 totalChecks,
        uint16 finalBonusBps,
        uint64 deadline,
        uint64 challengeWindow,
        bytes32 presetRunHash
    ) external payable {
        if (_tasks[taskId].exists) revert TaskAlreadyExists();
        if (agent == address(0) || verifier == address(0)) revert InvalidAddress();
        if (msg.value == 0) revert InvalidReward();
        if (totalChecks < MIN_CHECKS || totalChecks > MAX_CHECKS) revert InvalidCheckCount();
        if (finalBonusBps > MAX_FINAL_BONUS_BPS) revert InvalidBonusBps();
        if (deadline < block.timestamp + MIN_DEADLINE_BUFFER) revert DeadlineTooSoon();

        Task storage t = _tasks[taskId];
        t.employer = msg.sender;
        t.agent = agent;
        t.verifier = verifier;
        t.deadline = deadline;
        t.challengeWindow = challengeWindow;
        t.totalChecks = totalChecks;
        t.finalBonusBps = finalBonusBps;
        t.status = TaskStatus.OPEN;
        t.exists = true;
        t.totalReward = msg.value;
        t.remainingReward = msg.value;
        t.runHash = presetRunHash;

        emit TaskCreated(
            taskId,
            msg.sender,
            agent,
            verifier,
            msg.value,
            totalChecks,
            finalBonusBps,
            deadline,
            challengeWindow,
            presetRunHash
        );
    }

    /**
     * @notice Fast streaming path: authorized verifier submits check directly as msg.sender.
     * @dev Avoids Monad's 2x ecRecover precompile overhead (6,000 gas) for high-frequency per-test streams.
     */
    function recordCheckDirect(
        bytes32 taskId,
        uint16 checkIndex,
        bool passed,
        bytes32 runHash,
        bytes32 receiptHash
    ) external nonReentrant {
        Task storage t = _tasks[taskId];
        if (!t.exists) revert TaskNotFound();
        if (msg.sender != t.verifier) revert UnauthorizedVerifier();

        _processCheck(t, taskId, checkIndex, passed, runHash, receiptHash, false);
    }

    /**
     * @notice Permissionless attestation path: anyone submits a check signed by the task verifier via EIP-712.
     */
    function recordCheckWithSig(
        bytes32 taskId,
        uint16 checkIndex,
        bool passed,
        bytes32 runHash,
        bytes32 receiptHash,
        bytes calldata signature
    ) external nonReentrant {
        Task storage t = _tasks[taskId];
        if (!t.exists) revert TaskNotFound();

        bytes32 digest = hashCheckAttestation(taskId, runHash, checkIndex, passed, receiptHash);
        address signer = digest.recover(signature);
        if (signer != t.verifier) revert InvalidSignature();

        _processCheck(t, taskId, checkIndex, passed, runHash, receiptHash, true);
    }

    /**
     * @notice Same-runHash re-run dispute hook: employer or independent verifier challenges an attested check
     *         within the challenge window by posting a conflicting receiptHash computed from the exact same runHash.
     */
    function disputeCheck(
        bytes32 taskId,
        uint16 checkIndex,
        bytes32 counterReceiptHash,
        string calldata reason
    ) external {
        Task storage t = _tasks[taskId];
        if (!t.exists) revert TaskNotFound();
        if (checkIndex >= t.nextCheckIndex) revert CheckNotRecorded();
        if (counterReceiptHash == bytes32(0)) revert InvalidReceiptHash();

        CheckRecord storage rec = _checks[taskId][checkIndex];
        if (counterReceiptHash == rec.receiptHash) revert CounterReceiptMatchesAttested();

        if (t.challengeWindow > 0 && block.timestamp > uint256(t.lastCheckAt) + uint256(t.challengeWindow)) {
            revert ChallengeWindowClosed();
        }

        rec.disputed = true;
        if (t.status == TaskStatus.OPEN || t.status == TaskStatus.COMPLETED) {
            t.status = TaskStatus.DISPUTED;
        }

        _disputes[taskId] = DisputeRecord({
            challenger: msg.sender,
            counterReceiptHash: counterReceiptHash,
            disputedAt: uint64(block.timestamp),
            checkIndex: checkIndex,
            reason: reason
        });

        emit CheckDisputed(
            taskId,
            checkIndex,
            msg.sender,
            t.runHash,
            rec.receiptHash,
            counterReceiptHash,
            reason
        );
    }

    /**
     * @notice Refund remaining unreleased reward to employer after circuit breaker halt, dispute, or deadline expiry.
     */
    function refundRemaining(bytes32 taskId) external nonReentrant {
        Task storage t = _tasks[taskId];
        if (!t.exists) revert TaskNotFound();
        if (msg.sender != t.employer) revert OnlyEmployer();

        bool isExpired = (t.status == TaskStatus.OPEN && block.timestamp > t.deadline);
        bool canRefund = (t.status == TaskStatus.HALTED || t.status == TaskStatus.DISPUTED || isExpired);
        if (!canRefund) revert RefundNotAllowed();

        uint256 amount = t.remainingReward;
        if (amount == 0) revert NothingToRefund();

        // CEI: update state before external call
        t.remainingReward = 0;
        t.status = TaskStatus.REFUNDED;

        (bool ok, ) = payable(t.employer).call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit RemainingRefunded(taskId, t.employer, amount, isExpired);
    }

    // --- Internal Core Logic ---

    function _processCheck(
        Task storage t,
        bytes32 taskId,
        uint16 checkIndex,
        bool passed,
        bytes32 runHash,
        bytes32 receiptHash,
        bool viaSignature
    ) internal {
        if (t.status != TaskStatus.OPEN) revert TaskNotOpen();
        if (block.timestamp > t.deadline) revert TaskExpired();
        if (checkIndex != t.nextCheckIndex) revert InvalidCheckOrder(t.nextCheckIndex, checkIndex);
        if (runHash == bytes32(0)) revert InvalidRunHash();
        if (receiptHash == bytes32(0)) revert InvalidReceiptHash();

        if (t.runHash == bytes32(0)) {
            t.runHash = runHash;
        } else if (t.runHash != runHash) {
            revert RunHashMismatch(t.runHash, runHash);
        }

        uint256 payout = 0;
        bool isLastCheck = (checkIndex + 1 == t.totalChecks);

        if (passed) {
            payout = _computePayout(t, isLastCheck);
            t.passedChecks += 1;
            t.nextCheckIndex = checkIndex + 1;
            t.remainingReward -= payout;
            t.paidReward += payout;
            t.lastCheckAt = uint64(block.timestamp);

            if (isLastCheck) {
                t.status = TaskStatus.COMPLETED;
            }
        } else {
            t.nextCheckIndex = checkIndex + 1;
            t.lastCheckAt = uint64(block.timestamp);
            t.status = TaskStatus.HALTED;
        }

        _checks[taskId][checkIndex] = CheckRecord({
            receiptHash: receiptHash,
            payout: payout,
            recordedAt: uint64(block.timestamp),
            checkIndex: checkIndex,
            passed: passed,
            disputed: false,
            viaSignature: viaSignature
        });

        emit CheckAttested(
            taskId,
            t.agent,
            checkIndex,
            passed,
            runHash,
            receiptHash,
            payout,
            viaSignature
        );

        if (passed && payout > 0) {
            // CEI: transfer after all state updates; use .call{value:} for Monad cold-access safety
            (bool ok, ) = payable(t.agent).call{value: payout}("");
            if (!ok) revert TransferFailed();
        }

        if (!passed) {
            emit TaskHalted(taskId, checkIndex, runHash, receiptHash, t.remainingReward);
        } else if (isLastCheck) {
            emit TaskCompleted(taskId, t.agent, runHash, t.paidReward);
        }
    }

    function _computePayout(Task storage t, bool isLastCheck) internal view returns (uint256) {
        if (isLastCheck) {
            // Absorb any integer division dust so zero wei can ever be trapped
            return t.remainingReward;
        }
        uint256 streamPool = (t.totalReward * (10000 - uint256(t.finalBonusBps))) / 10000;
        uint256 perStep = streamPool / uint256(t.totalChecks - 1);
        return perStep > t.remainingReward ? t.remainingReward : perStep;
    }

    // --- Trustless Read / Independent Verification Views ---

    function hashCheckAttestation(
        bytes32 taskId,
        bytes32 runHash,
        uint16 checkIndex,
        bool passed,
        bytes32 receiptHash
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(CHECK_ATTESTATION_TYPEHASH, taskId, runHash, checkIndex, passed, receiptHash)
        );
        return _hashTypedDataV4(structHash);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function getTask(bytes32 taskId) external view returns (Task memory) {
        if (!_tasks[taskId].exists) revert TaskNotFound();
        return _tasks[taskId];
    }

    function getCheck(bytes32 taskId, uint16 checkIndex) external view returns (CheckRecord memory) {
        return _checks[taskId][checkIndex];
    }

    function getAllChecks(bytes32 taskId) external view returns (CheckRecord[] memory) {
        Task storage t = _tasks[taskId];
        if (!t.exists) revert TaskNotFound();
        uint16 count = t.nextCheckIndex;
        CheckRecord[] memory list = new CheckRecord[](count);
        for (uint16 i = 0; i < count; i++) {
            list[i] = _checks[taskId][i];
        }
        return list;
    }

    function getDispute(bytes32 taskId) external view returns (DisputeRecord memory) {
        return _disputes[taskId];
    }

    function previewCheckPayout(bytes32 taskId, uint16 checkIndex) external view returns (uint256) {
        Task storage t = _tasks[taskId];
        if (!t.exists) revert TaskNotFound();
        if (checkIndex >= t.totalChecks) revert InvalidCheckOrder(t.totalChecks - 1, checkIndex);
        bool isLast = (checkIndex + 1 == t.totalChecks);
        uint256 streamPool = (t.totalReward * (10000 - uint256(t.finalBonusBps))) / 10000;
        uint256 perStep = streamPool / uint256(t.totalChecks - 1);
        if (!isLast) return perStep;
        return t.totalReward - perStep * uint256(t.totalChecks - 1);
    }
}
