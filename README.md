# agentdeck

> 自托管、多服务器异构 CLI agent 群聊编排层（MVP）
> working name，名字可再改；代码零外部依赖，Node.js ≥ 18 直接跑。

## 这是什么

一个很薄的编排核心：多个 CLI agent（Claude Code、Codex，以及任何其他家的 CLI）
接在同一个群聊里协作时，由它负责两件事——

1. **谁来干**：agent 自报能力，任务按能力被路由给最合适的那一个；
2. **只干一次**：同一个任务只允许一个 agent 认领执行，别人重复收到直接跳过。

核心只做「消息进出 + 状态机」，不依赖任何一家 CLI 的私有开关/私有协议。
每家 agent 只需写一个很薄的 adapter，把群消息翻译成本项目的协议消息喂进来、
把处理结果翻译回去即可。

## 为什么需要它

真实场景：3 台沙盒服务器，每台跑着 Claude Code + Codex，一共 6 个 agent，
全部接进同一个群。于是真实痛点立刻出现：

- **重复唤醒 / 撞车**：群里一条消息，6 个 agent 同时被唤醒，同一个任务被两三个人
  同时开工，互相覆盖、重复回复、白烧 token。今天在群里就真实发生过
  listener 与定时巡检撞车、同一 agent 被重复唤醒。
- **派错人**：生成图片的活被派给没有生图能力的 agent，只能回一句「我做不了」；
  看图的活派给不能读图的 agent，同样白跑一趟。
- **死了没人接**：领了任务的 agent 进程挂了/机器暂停了，任务就永远卡住，
  没有超时接管机制。

本项目就是把这三件事收进一个可复用的核心里：去重、带租约的认领、能力路由。

## 最小协议

只有 4 种消息类型，全部是普通 JSON 对象（构造与校验见 `src/protocol.js`）：

| 类型 | 方向 | 关键字段 | 说明 |
|---|---|---|---|
| `register` | agent → 编排器 | `agentId, server, runtime, capabilities[], keywords[]` | 上线自报能力，如 `code`、`image-gen`、`image-read` |
| `task` | 群/用户 → 编排器 | `taskId, content, requiredTags[], keywords[]` | 一个任务；`taskId` 是稳定标识，重复投递时不变 |
| `heartbeat` | agent → 编排器 | `agentId` | 保活；编排器顺带为它持有的 claim 续租 |
| `result` | agent → 编排器 | `taskId, agentId, status, output` | 交结果；任务进入终态 `done`，迟到投递不再执行 |

每条消息都带 `id`（消息级唯一，用于去重）和 `ts`。

示例：

```json
{ "id": "…uuid…", "type": "register", "agentId": "01-claude", "server": "01",
  "runtime": "claude-code", "capabilities": ["code", "image-gen"], "keywords": ["画图"] }
{ "id": "…uuid…", "type": "task", "taskId": "task-poster-001",
  "content": "帮我生成图片：一张活动海报", "requiredTags": ["image-gen"], "keywords": ["生成图片"] }
```

## 两个核心机制

### 1. 消息去重防撞车（`src/dedupe.js`）

两层：

- **消息级去重**：同一 `id` 的消息只处理一次，重复投递返回 `duplicate-message`。
- **任务级 claim / lease**：同一 `taskId` 同一时刻只有一个持有者。
  claim 带租约（默认 30 秒，可配）：

  ```
  (无) --claim--> claimed --result--> done（终态）
                    |--release--> (无)
                    |--租约过期--> expired --被别人 claim--> claimed（接管）
  ```

  持有者靠 `heartbeat` 续租；持有者死了、租约到期，别人自动接管，任务不卡死。

  **持有者的身份是 `(agentId, runId)`，不是 `agentId`。** 同一台机器上同一个
  agent 可能跑着多个进程（最典型：Pachat listener 和定时巡检共用同一个
  `agentId`），如果只认 `agentId`，第二个进程 claim 时会命中「自己重复认领 =
  幂等续租」，两个进程都会执行——防撞车当场失效。`runId` 在进程启动时生成，
  随 `claim` / `renew` / `complete` 一起传：

  ```js
  orc.tryClaim('task-1', { agentId: '01-claude', runId: 'pid-4242' });
  ```

  同一个执行者重复 claim 才是幂等续租；不同 `runId` 一律拒绝（`already-claimed`）。
  只传 `agentId` 时按 **agent 级**租约处理（只比 `agentId`），适用于中心编排器
  替某 agent 认领、拿不到对方 `runId` 的场景——这种租约挡不住同 agent 内的进程撞车。

  `leaseId` 来自单调计数器，`release` 之后重新 claim 也不会回退，可安全用作
  下游的 fencing token。

### 2. 能力注册与路由（`src/registry.js`）

打分制，确定性、无随机、同分按注册先后：

- `requiredTags` 是**硬门槛**：任务声明了它，缺任一标签的 agent 直接出局；命中每个 +10；
- `task.keywords` 与 agent 的 `capabilities + keywords` 交集：每个 +3；
- `task.content` 文本里出现 agent 的标签/关键词：每个 +2。

得分 > 0 才算匹配；无人匹配返回 `{ routed: false, reason: 'no-matching-agent' }`，
明确未路由，绝不乱派。

## 快速开始

不需要 `npm install`（零依赖）。

```bash
node examples/demo.js   # 演示：3 台服务器 6 个 agent、重复投递只认领一次、按能力路由
npm test                # 单元测试 + P0 回归用例（node test/run-tests.js && node test/repro-p0.js）
npm run test:unit       # 只跑单元测试
npm run test:p0         # 只跑 P0 回归用例
```

把编排器嵌进自己的 adapter：

```js
import { Orchestrator } from './src/orchestrator.js';
import { createRegister, createTask } from './src/protocol.js';

const orc = new Orchestrator({ leaseMs: 30_000 });

orc.handleMessage(createRegister({
  agentId: '01-claude', server: '01', runtime: 'claude-code',
  capabilities: ['code', 'image-gen'],
}));

const r = orc.handleMessage(createTask({
  taskId: 'task-1', content: '生成图片', requiredTags: ['image-gen'],
}));
// r = { routed: true, claimed: true, agentId: '01-claude', ... }
// 同一条消息/同一个 taskId 再进来：duplicate / already-claimed，不会二次执行
```

## 目录结构

```
package.json            # ESM，零依赖，scripts: demo / test
src/protocol.js         # 4 种消息的构造（createXxx）与校验（validateMessage）
src/dedupe.js           # DedupeStore：消息去重 + claim/lease 状态机
src/registry.js         # AgentRegistry：能力注册表 + 标签/关键词路由打分
src/orchestrator.js     # Orchestrator：串起三者，handleMessage 分发处理
examples/demo.js        # 3 服务器 × (Claude Code + Codex) 模拟演示
test/run-tests.js       # node:assert 断言测试（去重/过期接管/路由命中/无匹配）
test/repro-p0.js        # P0 回归用例：进程级 claim、去重时机、leaseId 单调、内存有界、complete 鉴权
```

## MVP 范围与路线图

**本 MVP 只做**：协议（4 种消息）、去重 + claim/lease、能力注册与路由、本地演示与测试。

**刻意不做**（后续路线图）：

- [ ] 传输层 adapter：Pachat 群消息、Webhook、stdio 等接入方式各写一个薄 adapter
- [ ] 持久化：把注册表与 claim 存到文件/SQLite，进程重启不丢状态
- [ ] 任务队列与优先级、失败重试与死信
- [ ] 多编排器/多群：跨群路由、联邦
- [ ] 权限与审计：谁能派任务、认领记录可追溯
- [ ] 语义路由：在关键词/标签之上再加一层语义匹配（先跑通简单规则再说）
- [ ] Web 面板：节点状态、执行记录、结果对比

## 设计原则

- 零外部依赖、纯 Node 标准库， clone 下来就能跑、就能改；
- 核心不感知任何一家 CLI 的私有概念，适配差异全部收在 adapter 里；
- 所有拒绝都有明确 `reason`（`duplicate-message` / `already-claimed` /
  `already-done` / `no-matching-agent`），不静默吞消息；
- 时钟可注入，租约/过期行为可用假时钟确定性测试，不靠 sleep。
