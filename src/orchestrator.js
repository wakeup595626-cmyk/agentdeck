// src/orchestrator.js
// 核心编排类：把 protocol / dedupe / registry 串起来。
// 输入是协议消息，输出是处理结果对象；不做网络、不调任何 CLI，
// 传输层（群消息、Webhook、stdin……）由外层 adapter 负责。

import { validateMessage } from './protocol.js';
import { DedupeStore } from './dedupe.js';
import { AgentRegistry } from './registry.js';

export class Orchestrator {
  /**
   * @param {object} [opts]
   * @param {number} [opts.leaseMs] claim 默认租约
   * @param {() => number} [opts.now] 可注入时钟（测试用）
   * @param {DedupeStore} [opts.dedupe]
   * @param {AgentRegistry} [opts.registry]
   */
  constructor({ leaseMs = 30_000, now = () => Date.now(), dedupe, registry } = {}) {
    this.dedupe = dedupe ?? new DedupeStore({ leaseMs, now });
    this.registry = registry ?? new AgentRegistry({ now });
  }

  /**
   * 处理任意协议消息。
   * @returns {object} 结果对象，至少带 ok 字段；坏消息返回 { ok:false, errors }
   */
  handleMessage(msg) {
    const { ok, errors } = validateMessage(msg);
    if (!ok) return { ok: false, errors };

    switch (msg.type) {
      case 'register': return this.handleRegister(msg);
      case 'task': return this.handleTask(msg);
      case 'heartbeat': return this.handleHeartbeat(msg);
      case 'result': return this.handleResult(msg);
      default: return { ok: false, errors: [`unsupported type: ${msg.type}`] }; // validate 已挡住，兜底
    }
  }

  handleRegister(msg) {
    const agent = this.registry.register(msg);
    return { ok: true, type: 'register', agentId: agent.agentId, agent };
  }

  handleHeartbeat(msg) {
    const hb = this.registry.heartbeat(msg.agentId);
    // 顺带续租该 agent 持有的全部未过期 claim——活着就别让租约掉。
    // 续租要带 runId：同一 agent 的另一个进程不能替当前持有者续命（P0-1）。
    const renewed = [];
    for (const claim of this.dedupe.claims.values()) {
      if (claim.agentId === msg.agentId && claim.status === 'claimed') {
        const r = this.dedupe.renew(claim.taskId, { agentId: msg.agentId, runId: msg.runId ?? null });
        if (r.renewed) renewed.push(claim.taskId);
      }
    }
    return { ok: hb.ok, type: 'heartbeat', agentId: msg.agentId, renewed, ...(hb.ok ? {} : { reason: hb.reason }) };
  }

  /**
   * 任务处理管线：能力路由 -> claim 认领 -> 记消息已见。
   *
   * 去重标记的位置很关键（P0-2）：必须放在「真的有人认领了」之后。
   * 旧实现在第一步就 markSeen，于是没路由成功（no-matching-agent）或认领失败
   * 的消息也被记为已见，传输层重投时被判 duplicate-message 永久丢弃——而
   * 「agent 后上线」正是本项目要处理的情况。
   * 现在只有认领成功才记；没成功的，重投时还能再走一遍。
   */
  handleTask(msg) {
    // 0) 消息级去重：之前已成功处理过的同一 message id，直接跳过
    if (this.dedupe.hasSeen(msg.id)) {
      return {
        ok: true, type: 'task', taskId: msg.taskId,
        duplicate: true, routed: false, claimed: false,
        reason: 'duplicate-message',
      };
    }

    // 1) 已经完成的任务，迟到投递不再执行
    if (this.dedupe.isDone(msg.taskId)) {
      return {
        ok: true, type: 'task', taskId: msg.taskId,
        duplicate: true, routed: false, claimed: false,
        reason: 'already-done',
      };
    }

    // 2) 同一 taskId 已被认领：这是一次重复的任务投递，直接跳过，
    //    保证「同一任务只执行一次」在编排入口就成立。
    const existing = this.dedupe.getClaim(msg.taskId);
    if (existing && existing.status === 'claimed') {
      return {
        ok: true, type: 'task', taskId: msg.taskId,
        duplicate: true, routed: false, claimed: false,
        holder: existing.agentId,
        reason: 'already-claimed',
      };
    }

    // 3) 能力路由
    const route = this.registry.route(msg);
    if (!route.routed) {
      return {
        ok: true, type: 'task', taskId: msg.taskId,
        duplicate: false, routed: false, claimed: false,
        reason: 'no-matching-agent',
      };
    }

    // 4) 给路由到的 agent 认领（任务级防撞车）
    const claim = this.dedupe.claim(msg.taskId, {
      agentId: route.agentId,
      runId: msg.runId ?? null,
    });
    if (!claim.claimed) {
      return {
        ok: true, type: 'task', taskId: msg.taskId,
        duplicate: false, routed: true, claimed: false,
        agentId: route.agentId, holder: claim.holder,
        reason: claim.reason,
      };
    }

    // 5) 只在真正认领成功之后，才把这条消息记为已处理。
    this.dedupe.markSeen(msg.id);

    return {
      ok: true, type: 'task', taskId: msg.taskId,
      duplicate: false, routed: true, claimed: true,
      agentId: route.agentId, score: route.score, reasons: route.reasons,
      leaseId: claim.leaseId, expiresAt: claim.expiresAt,
    };
  }

  handleResult(msg) {
    const done = this.dedupe.complete(msg.taskId, { agentId: msg.agentId, runId: msg.runId ?? null });
    return {
      ok: done.completed, type: 'result', taskId: msg.taskId, agentId: msg.agentId,
      status: msg.status, ...(done.completed ? {} : { reason: done.reason, holder: done.holder }),
    };
  }

  /**
   * 广播场景的直认领入口：群里每个 agent 都会收到同一条任务，
   * 各自来 tryClaim，只有一个能成功——这就是防撞车的落点。
   * 传 {agentId, runId} 以区分同一 agent 的不同进程（P0-1）。
   */
  tryClaim(taskId, agentIdOrIdentity, opts) {
    return this.dedupe.claim(taskId, agentIdOrIdentity, opts);
  }

  getClaim(taskId) {
    return this.dedupe.getClaim(taskId);
  }
}
