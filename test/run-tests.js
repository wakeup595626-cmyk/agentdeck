// test/run-tests.js
// 用 node:assert 的真实断言。运行：npm test / node test/run-tests.js
// 覆盖：重复消息去重、同任务重复认领被拒、claim 过期接管、能力路由命中、无匹配未路由。

import assert from 'node:assert/strict';
import { Orchestrator } from '../src/orchestrator.js';
import { DedupeStore } from '../src/dedupe.js';
import { AgentRegistry } from '../src/registry.js';
import {
  createRegister, createTask, createHeartbeat, createResult, validateMessage,
} from '../src/protocol.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok ${passed} - ${name}`);
}

function freshOrchestrator(opts) {
  const orc = new Orchestrator(opts);
  orc.handleMessage(createRegister({ agentId: 'a-code', capabilities: ['code'], keywords: ['代码'] }));
  orc.handleMessage(createRegister({ agentId: 'a-image', capabilities: ['image-gen', 'image-read'], keywords: ['画图'] }));
  return orc;
}

// 1) 协议校验：合法消息通过，坏消息被拒
test('protocol: 合法消息通过、缺字段的坏消息被拒', () => {
  assert.equal(validateMessage(createRegister({ agentId: 'x', capabilities: ['code'] })).ok, true);
  assert.equal(validateMessage({ id: '1', type: 'task' }).ok, false); // 缺 taskId
  assert.equal(validateMessage({ id: '1', type: 'nope' }).ok, false);
  assert.equal(validateMessage(null).ok, false);
});

// 2) 重复消息去重：同一个 message id 第二次进来必须 duplicate
test('dedupe: 同一 message id 重复投递只处理一次', () => {
  const orc = freshOrchestrator();
  const task = createTask({ taskId: 't-dup-1', content: '写代码', requiredTags: ['code'] });
  const first = orc.handleMessage(task);
  assert.equal(first.claimed, true);
  assert.equal(first.duplicate, false);
  const second = orc.handleMessage(task);
  assert.equal(second.duplicate, true);
  assert.equal(second.claimed, false);
  assert.equal(second.reason, 'duplicate-message');
});

// 3) 同一 taskId、不同 message id：第二个 agent 抢认领必须被拒（防撞车）
test('dedupe: 同一 taskId 被第二个 agent 认领时被拒', () => {
  const dedupe = new DedupeStore();
  const c1 = dedupe.claim('t-claim-1', 'agent-1');
  assert.equal(c1.claimed, true);
  const c2 = dedupe.claim('t-claim-1', 'agent-2');
  assert.equal(c2.claimed, false);
  assert.equal(c2.reason, 'already-claimed');
  assert.equal(c2.holder, 'agent-1');
  // 持有者自己重复 claim 是幂等续租
  const c3 = dedupe.claim('t-claim-1', 'agent-1');
  assert.equal(c3.claimed, true);
  assert.equal(c3.renewed, true);
});

// 4) claim 过期后可被别人接管（假时钟，不靠 sleep）
test('lease: claim 过期后另一个 agent 可以接管', () => {
  let now = 1_000_000;
  const dedupe = new DedupeStore({ leaseMs: 1000, now: () => now });
  const c1 = dedupe.claim('t-lease-1', 'agent-1');
  assert.equal(c1.claimed, true);

  now += 500; // 租约内
  const tooEarly = dedupe.claim('t-lease-1', 'agent-2');
  assert.equal(tooEarly.claimed, false);
  assert.equal(tooEarly.reason, 'already-claimed');

  now += 600; // 总共过了 1100ms > leaseMs=1000，已过期
  const takeover = dedupe.claim('t-lease-1', 'agent-2');
  assert.equal(takeover.claimed, true);
  assert.equal(takeover.tookOver, true);
  assert.equal(takeover.previousHolder, 'agent-1');
  assert.equal(dedupe.getClaim('t-lease-1').agentId, 'agent-2');
});

// 5) 续租能延长租约；交 result 后是终态，谁也不能再认领
test('lease/result: heartbeat 续租有效，complete 后不可再认领', () => {
  let now = 0;
  const orc = new Orchestrator({ leaseMs: 1000, now: () => now });
  orc.handleMessage(createRegister({ agentId: 'a-code', capabilities: ['code'] }));
  const r = orc.handleMessage(createTask({ taskId: 't-done-1', content: 'code', requiredTags: ['code'] }));
  assert.equal(r.claimed, true);

  now = 900;
  const hb = orc.handleMessage(createHeartbeat({ agentId: 'a-code' }));
  assert.equal(hb.ok, true);
  assert.deepEqual(hb.renewed, ['t-done-1']);

  now = 1500; // 原租约(1000)已过，但续租到 1900，别人仍抢不到
  assert.equal(orc.tryClaim('t-done-1', 'someone-else').claimed, false);

  const done = orc.handleMessage(createResult({ taskId: 't-done-1', agentId: 'a-code', status: 'ok' }));
  assert.equal(done.ok, true);
  now = 999_999; // 就算租约概念早过期，done 是终态
  const afterDone = orc.tryClaim('t-done-1', 'someone-else');
  assert.equal(afterDone.claimed, false);
  assert.equal(afterDone.reason, 'already-done');
});

// 6) 能力路由命中：image-gen 任务只给有该标签的 agent
test('routing: requiredTags=[image-gen] 命中 a-image 而不是 a-code', () => {
  const registry = new AgentRegistry();
  registry.register(createRegister({ agentId: 'a-code', capabilities: ['code'] }));
  registry.register(createRegister({ agentId: 'a-image', capabilities: ['image-gen'] }));
  const route = registry.route(createTask({ taskId: 't-r1', content: '生成图片', requiredTags: ['image-gen'] }));
  assert.equal(route.routed, true);
  assert.equal(route.agentId, 'a-image');
});

// 7) 能力路由：关键词/内容也能命中（无 requiredTags 时）
test('routing: 靠 keywords 与 content 命中正确 agent', () => {
  const orc = freshOrchestrator();
  const r = orc.handleMessage(createTask({ taskId: 't-r2', content: '帮我画图，画图要高清', keywords: ['画图'] }));
  assert.equal(r.routed, true);
  assert.equal(r.agentId, 'a-image');
  assert.equal(r.claimed, true);
});

// 8) 无匹配时明确返回未路由，不乱派
test('routing: 无人具备所需能力时返回 no-matching-agent', () => {
  const orc = freshOrchestrator();
  const r = orc.handleMessage(createTask({ taskId: 't-r3', content: '量子模拟', requiredTags: ['quantum'] }));
  assert.equal(r.routed, false);
  assert.equal(r.claimed, false);
  assert.equal(r.reason, 'no-matching-agent');

  const registry = new AgentRegistry();
  registry.register(createRegister({ agentId: 'only-code', capabilities: ['code'] }));
  const route = registry.route(createTask({ taskId: 't-r4', content: '???', requiredTags: ['teleport'] }));
  assert.equal(route.routed, false);
  assert.equal(route.reason, 'no-matching-agent');
  assert.deepEqual(route.candidates, []);
});

// 9) 编排器端到端：路由+认领绑定，第二个同任务投递（新 message id）不会二次执行
test('orchestrator: 同一 taskId 新 message id 再投，不会产生第二个持有者', () => {
  const orc = freshOrchestrator();
  const first = orc.handleMessage(createTask({ taskId: 't-e2e-1', content: '写代码', requiredTags: ['code'] }));
  assert.equal(first.agentId, 'a-code');
  assert.equal(first.claimed, true);
  const second = orc.handleMessage(createTask({ taskId: 't-e2e-1', content: '写代码', requiredTags: ['code'] }));
  assert.equal(second.claimed, false);
  assert.equal(second.reason, 'already-claimed');
  assert.equal(second.holder, 'a-code');
});

test('routing: requiredTags 是硬门槛，关键词和内容高分也不能越过硬门槛', () => {
  const registry = new AgentRegistry();
  registry.register(createRegister({
    agentId: 'a-keyword-only',
    capabilities: ['code'],
    keywords: ['生成图片', '活动海报', '图片'],
  }));
  registry.register(createRegister({
    agentId: 'a-image',
    capabilities: ['image-gen'],
  }));

  const route = registry.route(createTask({
    taskId: 't-routing-hard-gate',
    content: '生成图片：一张活动海报',
    requiredTags: ['image-gen'],
    keywords: ['生成图片', '活动海报', '图片'],
  }));

  assert.equal(route.routed, true);
  assert.equal(route.agentId, 'a-image');
});

test('routing: 多个 requiredTags 必须全部具备', () => {
  const registry = new AgentRegistry();
  registry.register(createRegister({ agentId: 'a-code', capabilities: ['code'] }));
  registry.register(createRegister({ agentId: 'a-image', capabilities: ['image-gen'] }));
  registry.register(createRegister({ agentId: 'a-both', capabilities: ['image-gen', 'code'] }));

  const route = registry.route(createTask({
    taskId: 't-routing-multi-tags',
    content: '生成图片并写代码',
    requiredTags: ['code', 'image-gen'],
  }));

  assert.equal(route.routed, true);
  assert.equal(route.agentId, 'a-both');
  assert.deepEqual(
    route.candidates.map((candidate) => candidate.agentId),
    ['a-both'],
  );
});

test('routing: 标签和关键词统一大小写并忽略空白', () => {
  const registry = new AgentRegistry();
  registry.register(createRegister({
    agentId: 'a-normalized',
    capabilities: [' IMAGE-GEN '],
    keywords: [' Generate Image '],
  }));

  const route = registry.route(createTask({
    taskId: 't-routing-normalized',
    content: 'GENERATE IMAGE',
    requiredTags: ['Image-Gen'],
    keywords: ['generate image'],
  }));

  assert.equal(route.routed, true);
  assert.equal(route.agentId, 'a-normalized');
  assert.ok(route.reasons.includes('requiredTag:image-gen'));
  assert.ok(route.reasons.includes('keyword:generate image'));
});

test('routing: 明确关键词命中优先于仅内容命中', () => {
  const registry = new AgentRegistry();
  registry.register(createRegister({
    agentId: 'a-explicit-keyword',
    capabilities: ['docs'],
    keywords: ['写文档'],
  }));
  registry.register(createRegister({
    agentId: 'a-content-only',
    capabilities: ['write-docs'],
  }));

  const route = registry.route(createTask({
    taskId: 't-routing-explicit-keyword',
    content: '写文档',
    keywords: ['写文档'],
  }));

  assert.equal(route.routed, true);
  assert.equal(route.agentId, 'a-explicit-keyword');
  assert.ok(route.score >= 5);
});

test('routing: 同分时按注册顺序稳定选择', () => {
  const registry = new AgentRegistry();
  registry.register(createRegister({ agentId: 'a-first', capabilities: ['code'] }));
  registry.register(createRegister({ agentId: 'a-second', capabilities: ['code'] }));

  const firstRoute = registry.route(createTask({
    taskId: 't-routing-stable-1',
    content: 'code',
    requiredTags: ['code'],
  }));
  const secondRoute = registry.route(createTask({
    taskId: 't-routing-stable-2',
    content: 'code',
    requiredTags: ['code'],
  }));

  assert.equal(firstRoute.agentId, 'a-first');
  assert.equal(secondRoute.agentId, firstRoute.agentId);
});

console.log(`\nAll ${passed} tests passed.`);
