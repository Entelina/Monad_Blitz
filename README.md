# TaskRail Stream

> **Per-Test-Case Live Code Verification & Atomic Micro-Escrow on Monad Testnet**  
> Built from scratch at **Monad Blitz@广州** (`eventId=18`).

## 一句话说明

雇主在 Monad 测试网锁仓一笔 AI 代码任务赏金，AI Agent 提交代码 PR 后，隔离验证执行器逐条运行真实构建与 15 条细粒度单元测试——**每通过 1 条测试，600ms 级别就在 Monad 上链存证并原子释放对应微额赏金；一旦某条安全或权限单测失败，合约当场 `HALTED` 熔断，剩余大头资金可由雇主一键退回。** 任何第三方均可脱离后端直连 Monad RPC 独立核验凭证，并可在挑战窗口内用相同 `runHash` 独立复跑推翻异常验证者签名。

## 为什么必须建在 Monad 上？

- **逐条测试用例流式微结算（16 笔连续真实交易）**：在传统慢链/高 Gas 链上，把验收拆细到单条 `unit test` 粒度实时上链放款，既等不起分钟级最终性，也付不起远超微赏金的 Gas。Monad 的 **300ms 出块、600ms 确定性最终性** 和低廉手续费让“每跑通一条单测 = 一次不可逆链上证明与微结算”同时成立。
- **真实追踪 `monadNewHeads` `commitState`**：前端通过 WebSocket 直连 `wss://testnet-rpc.monad.xyz` 订阅 `monadNewHeads`，真实展示每笔交易从 `Proposed → Voted → Finalized` 的实测毫秒数（绝不伪造定时器）。
- **深度适配 Monad 协议特性**：
  - **按 `gas_limit` 计费**：发交易前紧凑估算并只加最小缓冲（`+6%`），前端按 `tx.gas × effectiveGasPrice` 展示真实实付成本。
  - **2× `ecRecover` 预编译成本优化**：合约同时提供 `recordCheckDirect`（授权验证器直发，省去 Monad 6,000 gas 的 `ecRecover`）与 `recordCheckWithSig`（无许可 EIP-712 中继验签），可在界面实时切换对比 Gas。
  - **MIP-8 4KB 存储页优化**：`Task` 核心热字段紧凑排布在连续槽位中；资金转账严格使用 `.call{value: ...}("")` 规避 Monad 冷访问 2300 gas revert。

## 架构与目录

```text
.
├── .monskills                      # MONSKILLS 元数据 (chain=monad-testnet)
├── contracts/                      # Hardhat + OpenZeppelin + Viem 智能合约
│   ├── contracts/TaskRailEscrow.sol
│   ├── test/TaskRailEscrow.test.ts # 5 组完整单测（全绿/熔断退款/EIP-712/超时/复跑争议）
│   └── scripts/                    # deploy.ts / verify.ts (devnads verify API) / smoke-test.ts
└── web/                            # Next.js App Router 单仓（直接部署 Vercel 公网）
    └── src/
        ├── lib/suite.ts            # 预审计双 Patch（PR #142 全绿 / PR #143 越权漏洞）+ 16 条真实单测
        ├── lib/runner.ts           # Node 原生 node:vm 净空安全沙盒 + 确定性 runHash / receiptHash
        ├── lib/monadWs.ts          # Monad monadNewHeads WebSocket commitState 追踪器
        └── app/                    # 驾驶舱 UI + Serverless API (/api/demo-create, /api/run-check, /api/rerun-verify, /api/refund)
```

## 5 分钟本地运行

### 1. 合约编译、测试与部署（Monad Testnet `10143`）

```bash
cd contracts
pnpm install
pnpm test

# 配置测试网私钥（仅使用测试网 burner 钱包！）
cp .env.example .env
pnpm deploy:testnet
pnpm verify:testnet   # 调用 https://agents.devnads.com/v1/verify 一次验证三个浏览器
pnpm smoke:testnet    # 实测测试网真实延迟与 tx.gas * effectiveGasPrice
```

### 2. 启动前端与验证引擎

```bash
cd web
pnpm install
cp .env.example .env.local
# 填入合约地址与测试网 Verifier 私钥
pnpm dev
```

打开 `http://localhost:3000` 即可体验：
1. **PR #143（ACL 越权漏洞版）**：前 5 项过关流式微放款 → 第 6 项越权单测红灯爆错 → 合约当场 `HALTED` 熔断 → 一键退回剩余 80% MON。
2. **PR #142（完整修复版）**：16 条真实单测逐条上链流式微放款，末项自动解锁 40% 尾款（0 wei 尘埃残余）。
3. **独立读链核验 & 同 `runHash` 复跑争议**：零后端直连 Monad RPC 验签；勾选「模拟恶意 Verifier 造假」后可一键复跑抓包并链上 `disputeCheck()` 冻结资金。

## 商业模型

面向 AI 软件外包工作室与多 Agent 协作平台，按流式验证结算金额收取 **0.5% 协议验证费**，并向企业提供私有隔离 Verifier 节点订阅与合规审计凭证导出。

## 信任边界声明

- **已验证**：`receiptHash`、Verifier EIP-712 签名、全部检查绑定同一 `runHash` 与 Monad 链上不可逆状态。
- **当前原型边界**：单验证者执行器尚未接入 TEE 远程证明或去中心化质押仲裁；已通过合约内 `disputeCheck`（同 `runHash` 复跑挑战窗口）预留反作弊接口，下一阶段升级为 TEE + ERC-8004 多验证者网络。
