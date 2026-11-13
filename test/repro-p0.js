// test/repro-p0.js
// 回归用例：P0 评审里的 5 个问题。
//
// 这些用例断言的是「修复后应有的行为」。在修复之前它们对着 main 骨架是红的
// （实测 8 failed / 4 passed，退出码 1），修复后全绿（12 passed，退出码 0）。
// 先红后绿，证明修的是真问题、且没修漏。
//
// 运行：node test/repro-p0.js（已纳入 npm test）
//
// 注：本文件由 01 DeepSeek V4.1 Flash 编写。初版写作时未能实际执行
// （沙盒不允许运行新克隆外部仓库的代码），只当规格说明用；现已在本机实际
// 跑过红→绿两态。断言与骨架字段名如有出入，以骨架实际为准并回来改。

import assert from 'node:assert/strict';
import { Orchestrator } from '../src/orchestrator.js';
import { DedupeStore } from '../src/dedupe.js';
import { createRegister, createTask, validateMessage } from '../src/protocol.js';

let passed = 0;
const failed = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   - ${name}`);
  } catch (e) {
    failed.push({ name, error: e });
    console.log(`FAIL - ${name}`);
    console.log(`       ${e.message.split('\n')[0]}`);
  }
}

// ---------------------------------------------------------------------------
// ① 身份粒度：同一 agentId 的两个进程必须互斥
//
// 场景：agent 'a' 的 listener 与定时巡检是两个进程，共用 agentId='a'。
// 它们收到同一条任务，各自 claim。当前实现里第二个进程走「自己重复认领 =
// 幂等续租」分支，拿到 claimed:true —— 两个进程都会执行。
//
// 修复方向：claim 的身份是 (agentId, runId)，runId 每次进程启动时生成。
// 同一 runId 重复 claim 才是续租；不同 runId 一律视为竞争。
// ---------------------------------------------------------------------------
test('P0-1 同一 agentId、不同进程（runId）竞争同一 task，只有一个能认领', () => {
  const d = new DedupeStore({ leaseMs: 60_000, now: () => 1_000_000 });

  const listener = d.claim('t-p0-1', { agentId: 'a', runId: 'run-listener' });
  const sweeper = d.claim('t-p0-1', { agentId: 'a', runId: 'run-sweeper' });

  assert.equal(listener.claimed, true, '第一个进程应认领成功');
  assert.equal(
    sweeper.claimed,
    false,
    '同一 agent 的第二个进程不得同时认领（当前实现会返回 claimed:true，这是本项目的头号场景）',
  );
  assert.equal(sweeper.reason, 'already-claimed');
});

test('P0-1b 同一 runId 重复 claim 仍是幂等续租（新增 runId 不能把正常续租弄坏）', () => {
  const d = new DedupeStore({ leaseMs: 60_000, now: () => 1_000_000 });
  const first = d.claim('t-p0-1b', { agentId: 'a', runId: 'run-1' });
  const again = d.claim('t-p0-1b', { agentId: 'a', runId: 'run-1' });
  assert.equal(first.claimed, true);
  assert.equal(again.claimed, true);
  assert.equal(again.renewed, true);
});

test('P0-1c 续租与 complete 都校验 runId：被接管后旧进程不能续租、不能交结果', () => {
  let now = 1_000_000;
  const d = new DedupeStore({ leaseMs: 1000, now: () => now });

  d.claim('t-p0-1c', { agentId: 'a', runId: 'run-old' });
  now += 2000; // 旧租约过期
  const takeover = d.claim('t-p0-1c', { agentId: 'a', runId: 'run-new' });
  assert.equal(takeover.claimed, true, '过期后应可被同 agent 的新进程接管');

  assert.equal(
    d.renew('t-p0-1c', { agentId: 'a', runId: 'run-old' }).renewed,
    false,
    '旧 runId 不得续租新持有者的租约',
  );
  assert.equal(
    d.complete('t-p0-1c', { agentId: 'a', runId: 'run-old' }).completed,
    false,
    '旧 runId 不得把新持有者的任务标记完成',
  );
});

// ---------------------------------------------------------------------------
// ② 去重标记早于路由决策：没路由成功就不能把消息 id 记为已处理
//
// 场景：任务先到，但当时还没有具备该能力的 agent（很常见——agent 后上线）。
// 当前实现第一步就 markSeen，重投时被判 duplicate-message 永久丢弃。
// ---------------------------------------------------------------------------
test('P0-2 无匹配 agent 导致未路由后，同一条消息重投仍能路由（不能被判 duplicate）', () => {
  const orc = new Orchestrator({ leaseMs: 60_000, now: () => 1_000_000 });

  // 此刻还没有会 image-gen 的 agent
  const task = createTask({
    id: 'msg-p0-2',
    taskId: 't-p0-2',
    content: '生成图片',
    requiredTags: ['image-gen'],
  });

  const first = orc.handleMessage(task);
  assert.equal(first.routed, false, '前置条件：第一次应当未路由');
  assert.equal(first.reason, 'no-matching-agent');

  // 具备能力的 agent 上线了
  orc.handleMessage(createRegister({ agentId: 'a-image', capabilities: ['image-gen'] }));

  // 传输层重投同一条消息（同 id、同 taskId）
  const retry = orc.handleMessage(task);
  assert.notEqual(retry.reason, 'duplicate-message', '未路由的消息不得因为 markSeen 被永久判重');
  assert.equal(retry.routed, true, '能力上线后，重投应当能路由成功');
  assert.equal(retry.claimed, true);
  assert.equal(retry.agentId, 'a-image');
});

test('P0-2b 真正重复投递（已成功认领过的）仍必须被判 duplicate', () => {
  const orc = new Orchestrator({ leaseMs: 60_000, now: () => 1_000_000 });
  orc.handleMessage(createRegister({ agentId: 'a-code', capabilities: ['code'] }));

  const task = createTask({ id: 'msg-p0-2b', taskId: 't-p0-2b', content: '写代码', requiredTags: ['code'] });
  assert.equal(orc.handleMessage(task).claimed, true);
  const dup = orc.handleMessage(task);
  assert.equal(dup.duplicate, true, '已成功认领过的同 id 消息重投仍要去重');
  assert.equal(dup.reason, 'duplicate-message');
});

// ---------------------------------------------------------------------------
// ③ leaseId 必须是单调 fencing token：release 不能让编号回退
//
// 下游若拿 leaseId 做 fencing（拒绝旧持有者的迟到写入），编号复用会导致
// 已作废的旧租约写入被当作有效。单调来源必须独立于记录生命周期。
// ---------------------------------------------------------------------------
test('P0-3 release 之后重新 claim，leaseId 不得回退', () => {
  const d = new DedupeStore({ leaseMs: 60_000, now: () => 1_000_000 });

  const c1 = d.claim('t-p0-3', { agentId: 'a', runId: 'r1' });
  assert.equal(c1.leaseId, 1);

  d.release('t-p0-3', { agentId: 'a', runId: 'r1' });

  const c2 = d.claim('t-p0-3', { agentId: 'b', runId: 'r2' });
  assert.ok(
    c2.leaseId > c1.leaseId,
    `release 后重新 claim 的 leaseId 必须严格递增，实际 ${c1.leaseId} -> ${c2.leaseId}`,
  );
});

test('P0-3b 过期接管与 release 交替发生时，leaseId 全局单调', () => {
  let now = 1_000_000;
  const d = new DedupeStore({ leaseMs: 1000, now: () => now });
  const seen = [];

  seen.push(d.claim('t-p0-3b', { agentId: 'a', runId: 'r1' }).leaseId);
  now += 2000;
  seen.push(d.claim('t-p0-3b', { agentId: 'b', runId: 'r2' }).leaseId); // 过期接管
  d.release('t-p0-3b', { agentId: 'b', runId: 'r2' });
  seen.push(d.claim('t-p0-3b', { agentId: 'c', runId: 'r3' }).leaseId);

  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i] > seen[i - 1], `leaseId 必须单调递增，实际序列 ${seen.join(' -> ')}`);
  }
});

// ---------------------------------------------------------------------------
// ④ 去重表与已结束 claim 必须有界：长跑守护进程不能单调涨内存
//
// sweep() 当前只扫 claims 标 expired，从不清理 seenMessages，
// 也不清理已结束的 claim。保留窗口必须大于最大重放窗口（写进文档）。
// ---------------------------------------------------------------------------
test('P0-4 sweep 会按保留窗口清理过期的 seenMessages', () => {
  let now = 1_000_000;
  const d = new DedupeStore({ leaseMs: 1000, now: () => now, retentionMs: 10_000 });

  for (let i = 0; i < 100; i++) d.markSeen(`m-${i}`);
  assert.equal(d.seenMessages.size, 100);

  now += 60_000; // 远超 retentionMs
  d.sweep();

  assert.ok(
    d.seenMessages.size < 100,
    `超过保留窗口的已见消息应被清理，实际仍有 ${d.seenMessages.size} 条（长跑会无界增长）`,
  );
});

test('P0-4b sweep 会清理早已结束的 claim 记录', () => {
  let now = 1_000_000;
  const d = new DedupeStore({ leaseMs: 1000, now: () => now, retentionMs: 10_000 });

  d.claim('t-old', { agentId: 'a', runId: 'r1' });
  d.complete('t-old', { agentId: 'a', runId: 'r1' });

  now += 60_000;
  d.sweep();

  assert.equal(d.claims.size, 0, `已结束且超过保留窗口的 claim 应被清理，实际剩 ${d.claims.size} 条`);
});

test('P0-4c 保留窗口内的重复投递仍然被去重（清理不能清早了）', () => {
  let now = 1_000_000;
  const d = new DedupeStore({ leaseMs: 1000, now: () => now, retentionMs: 60_000 });

  assert.equal(d.markSeen('m-keep'), true);
  now += 30_000; // 仍在 retentionMs 内
  d.sweep();
  assert.equal(d.markSeen('m-keep'), false, '保留窗口内的消息不得被当成首次见到');
});

// ---------------------------------------------------------------------------
// ⑤ complete 必须有有效 claim：不能让任何人凭 taskId 把任务永久标记完成
//
// 当前实现里 complete() 在无 claim 时会直接造一条 done 记录（leaseId:0），
// 这是一个无授权的抢占入口：任何 agent 传个 taskId 就能让该任务永远不再被派发。
// ---------------------------------------------------------------------------
test('P0-5 无 claim 时 complete 必须被拒绝', () => {
  const d = new DedupeStore({ leaseMs: 60_000, now: () => 1_000_000 });
  const r = d.complete('t-p0-5', { agentId: 'anyone', runId: 'r1' });

  assert.equal(r.completed, false, '没有有效 claim 不得标记完成');
  assert.equal(d.isDone('t-p0-5'), false, '被拒绝的 complete 不得留下 done 记录');
});

test('P0-5b 持有有效 claim 的 agent 正常交结果', () => {
  const d = new DedupeStore({ leaseMs: 60_000, now: () => 1_000_000 });
  d.claim('t-p0-5b', { agentId: 'a', runId: 'r1' });
  const r = d.complete('t-p0-5b', { agentId: 'a', runId: 'r1' });
  assert.equal(r.completed, true);
  assert.equal(d.isDone('t-p0-5b'), true);
});

// ---------------------------------------------------------------------------
// ⑥ runId 语义：空串 / 非字符串不能被当成有效进程身份（P0'-2）
//
// 背景：P0-1 把身份改成 (agentId, runId)，但 normalizeIdentity 只做 `?? null`，
// 于是空串被原样保留。两个进程若都传 runId:''，在 #isSameRunner 里 '' === ''
// 成立，第二个进程被当成「自己重复认领 = 幂等续租」，拿到 claimed:true ——
// P0-1 要挡的撞车原样复现。
//
// 修复方向：'' 与非字符串一律在边界抛错（大声失败），而不是悄悄降级成
// agent 级租约——降级会让两个进程都认领成功且无人报错，比失败更糟。

test("P0'-2 传空串 runId 必须抛错，不能静默降级成 agent 级租约", () => {
  const d = new DedupeStore({ leaseMs: 60_000, now: () => 1_000_000 });
  assert.throws(
    () => d.claim('t-p0p-2a', { agentId: 'ag', runId: '' }),
    /runId/,
    '空串 runId 应抛错：两个进程都传 "" 会互相认同，防撞车失效',
  );
  // 而且不得留下任何 claim 记录
  assert.equal(d.getClaim('t-p0p-2a'), null, '抛错时不得留下半成品 claim');
});

test("P0'-2b 缺省 runId 仍是合法的 agent 级租约（兼容旧签名）", () => {
  const d = new DedupeStore({ leaseMs: 60_000, now: () => 1_000_000 });
  const c = d.claim('t-p0p-2b', { agentId: 'ag' });
  assert.equal(c.claimed, true, '不传 runId 应走 agent 级租约');
  assert.equal(c.runId, null);
  // agent 级租约下，同 agent 的再次 claim 是幂等续租
  const renewed = d.claim('t-p0p-2b', { agentId: 'ag' });
  assert.equal(renewed.renewed, true);
});

test("P0'-2c 非字符串 runId 必须被拒绝，而不是静默接受", () => {
  const d = new DedupeStore({ leaseMs: 60_000, now: () => 1_000_000 });
  assert.throws(
    () => d.claim('t-p0p-2c', { agentId: 'ag', runId: 123 }),
    /runId/,
    '数字 runId 应抛错，避免 123 与 "123" 混淆',
  );
});

test("P0'-2d 协议层同样拒掉非法 runId", () => {
  const badType = validateMessage({ id: 'm1', type: 'task', taskId: 't1', runId: 123 });
  assert.equal(badType.ok, false, '非字符串 runId 应在协议校验被拒');
  assert.ok(badType.errors.some((e) => e.includes('runId')));

  const missing = validateMessage({ id: 'm2', type: 'task', taskId: 't2' });
  assert.equal(missing.ok, true, '不传 runId 必须仍然合法');

  const good = validateMessage({ id: 'm3', type: 'task', taskId: 't3', runId: 'pid-1' });
  assert.equal(good.ok, true, '合法 runId 应通过');

  const empty = validateMessage({ id: 'm4', type: 'task', taskId: 't4', runId: '' });
  assert.equal(empty.ok, false, '空串 runId 应在协议校验被拒（不得静默降级）');
  assert.ok(empty.errors.some((e) => e.includes('runId')));

  // heartbeat / result 里的 msg.runId ?? null 会直接流进 renew/complete，
  // 协议层必须在这里就把空串挡住，否则编排器路径仍会绕过。
  const hb = validateMessage({ id: 'm5', type: 'heartbeat', agentId: 'a', runId: '' });
  assert.equal(hb.ok, false, 'heartbeat 的空串 runId 也应被拒');
  const res = validateMessage({ id: 'm6', type: 'result', taskId: 't5', agentId: 'a', runId: '' });
  assert.equal(res.ok, false, 'result 的空串 runId 也应被拒');
});

// ---------------------------------------------------------------------------
// ⑦ leaseId 单调性：跨进程重启不得回退（P0'-1）
//
// 背景：leaseSeq 是内存计数器，进程重启即归零。README 与 dedupe.js 都声明
// 「leaseId 可安全用作下游 fencing token」，但 fencing token 的全部意义是
// 单调递增，回退等于让下游接受已作废的旧租约写入。
//
// 修复方向：把序号来源做成可注入 / 可持久化（这里是构造参数 initialLeaseSeq
// 或注入 nextLeaseId），重启时从上次的值续上，而不是从 0 重来。

test("P0'-1 进程重启后 leaseId 必须从上次的值继续，不得回退", () => {
  const clock = { t: 1_000_000 };
  const first = new DedupeStore({ leaseMs: 60_000, now: () => clock.t });
  first.claim('t-p0p-1a', { agentId: 'ag', runId: 'r1' });
  first.claim('t-p0p-1b', { agentId: 'ag', runId: 'r1' });
  const lastBefore = first.claim('t-p0p-1c', { agentId: 'ag', runId: 'r1' }).leaseId;
  assert.equal(lastBefore, 3, '前置：三次认领应得到 1,2,3');

  // 模拟崩溃重启：新实例，但序号从上一个实例的最后值续上
  const restarted = new DedupeStore({ leaseMs: 60_000, now: () => clock.t, initialLeaseSeq: lastBefore });
  const after = restarted.claim('t-p0p-1d', { agentId: 'ag', runId: 'r2' });
  assert.ok(
    after.leaseId > lastBefore,
    `重启后第一个 leaseId(${after.leaseId}) 必须大于重启前最后一个(${lastBefore})`,
  );
});

test("P0'-1b leaseId 序号可以被读出，供外部持久化", () => {
  const d = new DedupeStore({ leaseMs: 60_000, now: () => 1_000_000 });
  d.claim('t-p0p-1e', { agentId: 'ag', runId: 'r1' });
  d.claim('t-p0p-1f', { agentId: 'ag', runId: 'r1' });
  assert.equal(d.leaseSeq, 2, 'leaseSeq 应可直接读出，供调用方持久化后回填');
});

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length > 0) {
  console.log('\n失败用例（对当前 main 骨架来说是预期的）：');
  for (const f of failed) console.log(`  - ${f.name}`);
  process.exitCode = 1;
}
