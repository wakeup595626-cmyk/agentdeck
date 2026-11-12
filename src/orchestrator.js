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
    // 顺带续租该 agent 持有的全部未过期 claim——活着就别让租约掉
    const renewed = [];
    for (const claim of this.dedupe.claims.values()) {
      if (claim.agentId === msg.agentId && claim.status === 'claimed') {
        const r = this.dedupe.renew(claim.taskId, msg.agentId);
        if (r.renewed) renewed.push(claim.taskId);
      }
    }
    return { ok: hb.ok, type: 'heartbeat', agentId: msg.agentId, renewed, ...(hb.ok ? {} : { reason: hb.reason }) };
  }

  /**
   * 任务处理管线：消息去重 -> 能力路由 -> claim 认领。
   * 任何一步不过都明确返回原因，绝不让第二个 agent 重复执行同一任务。
   */
  handleTask(msg) {
    // 1) 消息级去重：同一个 message id 第二次进来直接跳过
    if (!this.dedupe.markSeen(msg.id)) {
      return {
        ok: true, type: 'task', taskId: msg.taskId,
        duplicate: true, routed: false, claimed: false,
        reason: 'duplicate-message',
      };
    }

    // 2) 已经完成的任务，迟到投递不再执行
    if (this.dedupe.isDone(msg.taskId)) {
      return {
        ok: true, type: 'task', taskId: msg.taskId,
        duplicate: true, routed: false, claimed: false,
        reason: 'already-done',
      };
    }

    // 2.5) 同一 taskId 已被认领（哪怕持有者就是将被路由到的那个）：
    // 这是一次重复的任务投递，不是续租——续租走 heartbeat / tryClaim。
    // 直接跳过，保证「同一任务只执行一次」在编排入口就成立。
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
    const claim = this.dedupe.claim(msg.taskId, route.agentId);
    if (!claim.claimed) {
      return {
        ok: true, type: 'task', taskId: msg.taskId,
        duplicate: false, routed: true, claimed: false,
        agentId: route.agentId, holder: claim.holder,
        reason: claim.reason,
      };
    }
    return {
      ok: true, type: 'task', taskId: msg.taskId,
      duplicate: false, routed: true, claimed: true,
      agentId: route.agentId, score: route.score, reasons: route.reasons,
      leaseId: claim.leaseId, expiresAt: claim.expiresAt,
    };
  }

  handleResult(msg) {
    const done = this.dedupe.complete(msg.taskId, msg.agentId);
    return {
      ok: done.completed, type: 'result', taskId: msg.taskId, agentId: msg.agentId,
      status: msg.status, ...(done.completed ? {} : { reason: done.reason, holder: done.holder }),
    };
  }

  /**
   * 广播场景的直认领入口：群里每个 agent 都会收到同一条任务，
   * 各自来 tryClaim，只有一个能成功——这就是防撞车的落点。
   */
  tryClaim(taskId, agentId, opts) {
    return this.dedupe.claim(taskId, agentId, opts);
  }

  getClaim(taskId) {
    return this.dedupe.getClaim(taskId);
  }
}
