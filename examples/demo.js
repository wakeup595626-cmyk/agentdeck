// examples/demo.js
// 模拟 3 台服务器（01/02/03）、每台 1 个 Claude Code + 1 个 Codex，共 6 个 agent。
// 演示两件事：
//  A. 按能力路由：image-gen 的活只会给到有该标签的 agent。
//  B. 防撞车：同一条任务广播给全部 6 个 agent（重复投递 3 次），最终只被认领一次。

import { Orchestrator } from '../src/orchestrator.js';
import { createRegister, createTask, createHeartbeat, createResult } from '../src/protocol.js';

const orc = new Orchestrator();

const AGENTS = [
  { agentId: '01-claude', name: '01 Claude Code', server: '01', runtime: 'claude-code', capabilities: ['code', 'image-gen', 'image-read'], keywords: ['画图', '生成图片', '代码'] },
  { agentId: '01-codex', name: '01 Codex', server: '01', runtime: 'codex', capabilities: ['code', 'review'], keywords: ['审查', '代码'] },
  { agentId: '02-claude', name: '02 Claude Code', server: '02', runtime: 'claude-code', capabilities: ['code', 'docs'], keywords: ['文档', '代码'] },
  { agentId: '02-codex', name: '02 Codex', server: '02', runtime: 'codex', capabilities: ['code', 'data'], keywords: ['数据', '表格', '代码'] },
  { agentId: '03-claude', name: '03 Claude Code', server: '03', runtime: 'claude-code', capabilities: ['image-read', 'docs'], keywords: ['看图', '文档', '截图'] },
  { agentId: '03-codex', name: '03 Codex', server: '03', runtime: 'codex', capabilities: ['code', 'image-read'], keywords: ['看图', '代码'] },
];

console.log('=== 1) 6 个 agent 上线 register（同有 code，标签各不同）===');
for (const a of AGENTS) {
  const r = orc.handleMessage(createRegister(a));
  console.log(`register ${a.agentId} (${a.server}/${a.runtime}) capabilities=[${a.capabilities.join(', ')}] -> ok=${r.ok}`);
}

console.log('\n=== 2) 任务 A：生成一张海报图（requiredTags=[image-gen]）===');
const taskA = createTask({
  taskId: 'task-poster-001',
  content: '帮我生成图片：一张活动海报',
  requiredTags: ['image-gen'],
  keywords: ['生成图片'],
});
const routeA = orc.handleMessage(taskA);
console.log(`route -> routed=${routeA.routed} claimed=${routeA.claimed} agent=${routeA.agentId} score=${routeA.score} reasons=[${(routeA.reasons ?? []).join(', ')}]`);

console.log('\n=== 3) 防撞车：同一条任务 A 被重复投递给编排器 3 次 ===');
for (let i = 1; i <= 3; i++) {
  const again = orc.handleMessage(taskA); // 同一个 message id
  console.log(`投递#${i} -> duplicate=${again.duplicate} claimed=${again.claimed} reason=${again.reason ?? 'claimed-ok'}`);
}

console.log('\n=== 4) 防撞车（广播式）：任务 B 广播给 6 个 agent，各自 tryClaim ===');
const taskB = createTask({
  taskId: 'task-review-002',
  content: '审查这段代码的 review 问题',
  requiredTags: ['review'],
});
const routeB = orc.handleMessage(taskB);
console.log(`先路由 -> agent=${routeB.agentId} claimed=${routeB.claimed}`);
let claimRejected = 0;
for (const a of AGENTS) {
  const c = orc.tryClaim(taskB.taskId, a.agentId);
  if (!c.claimed) claimRejected++;
  console.log(`tryClaim ${a.agentId} -> claimed=${c.claimed}${c.renewed ? ' (持有者自己续租，幂等)' : ''}${c.reason ? ` reason=${c.reason} holder=${c.holder}` : ''}`);
}
console.log(`任务 B：6 个 agent 抢认领，${claimRejected} 个被拒，最终只有 1 个持有者=${orc.getClaim(taskB.taskId).agentId}`);

console.log('\n=== 5) heartbeat + result：持有者交结果后，迟到投递不再执行 ===');
console.log('heartbeat 01-claude ->', JSON.stringify(orc.handleMessage(createHeartbeat({ agentId: '01-claude' }))));
console.log('result task-poster-001 ->', JSON.stringify(orc.handleMessage(createResult({ taskId: 'task-poster-001', agentId: '01-claude', status: 'ok', output: 'poster.png' }))));
const late = orc.handleMessage(createTask({ taskId: 'task-poster-001', content: '再发一次', requiredTags: ['image-gen'] }));
console.log(`任务 A 换个 message id 再投 -> duplicate=${late.duplicate} claimed=${late.claimed} reason=${late.reason}`);

console.log('\n=== 6) 无匹配能力：没人有 quantum 标签 ===');
const noRoute = orc.handleMessage(createTask({ taskId: 'task-quantum-003', content: '做量子模拟', requiredTags: ['quantum'] }));
console.log(`route -> routed=${noRoute.routed} claimed=${noRoute.claimed} reason=${noRoute.reason}`);

console.log('\nDemo 完成：重复投递只认领一次、image-gen 路由到 01-claude、无匹配明确未路由。');
