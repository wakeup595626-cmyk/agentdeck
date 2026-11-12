// src/registry.js
// 能力注册表 + 路由。
//
// agent 用 register 消息自报：agentId / server / runtime / capabilities(标签) / keywords。
// 路由打分（确定性、无随机、同分按注册先后）：
//   - requiredTags 命中：每个 +10，且属于硬门槛——任务声明了 requiredTags 时，
//     缺任何一个标签的 agent 直接出局。
//   - keywords 命中：task.keywords 与 agent 的 capabilities+keywords 交集，每个 +3。
//   - content 扫描：task.content 里出现 agent 的 capability 标签或 keyword，每个 +2。
// 得分 > 0 才算匹配；没人得分 / 没人过硬门槛 => { routed:false }。

function normList(list) {
  return [...new Set((list ?? []).map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
}

export class AgentRegistry {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    /** @type {Map<string, object>} agentId -> agent record（保持插入顺序） */
    this.agents = new Map();
  }

  register(msgOrAgent) {
    const agentId = msgOrAgent.agentId;
    if (!agentId) throw new TypeError('register: agentId is required');
    const existing = this.agents.get(agentId);
    const record = {
      agentId,
      name: msgOrAgent.name ?? agentId,
      server: msgOrAgent.server ?? existing?.server ?? null,
      runtime: msgOrAgent.runtime ?? existing?.runtime ?? null,
      capabilities: normList(msgOrAgent.capabilities ?? existing?.capabilities ?? []),
      keywords: normList(msgOrAgent.keywords ?? existing?.keywords ?? []),
      registeredAt: existing?.registeredAt ?? this.now(),
      lastHeartbeatAt: this.now(),
      status: 'online',
    };
    this.agents.set(agentId, record);
    return record;
  }

  unregister(agentId) {
    return this.agents.delete(agentId);
  }

  heartbeat(agentId) {
    const record = this.agents.get(agentId);
    if (!record) return { ok: false, reason: 'unknown-agent' };
    record.lastHeartbeatAt = this.now();
    record.status = 'online';
    return { ok: true, agentId, lastHeartbeatAt: record.lastHeartbeatAt };
  }

  get(agentId) {
    return this.agents.get(agentId) ?? null;
  }

  list() {
    return [...this.agents.values()];
  }

  /** 给单个 agent 对某个 task 打分。返回 null 表示被硬门槛淘汰。 */
  score(agent, task) {
    const required = normList(task.requiredTags);
    const caps = new Set(agent.capabilities);
    if (required.length > 0 && !required.every((t) => caps.has(t))) return null;

    let score = required.length * 10;
    const reasons = required.map((t) => `requiredTag:${t}`);

    const taskKeywords = normList(task.keywords);
    const agentWords = new Set([...agent.capabilities, ...agent.keywords]);
    for (const kw of taskKeywords) {
      if (agentWords.has(kw)) { score += 3; reasons.push(`keyword:${kw}`); }
    }

    const content = String(task.content ?? '').toLowerCase();
    if (content) {
      for (const word of agentWords) {
        if (word && content.includes(word)) { score += 2; reasons.push(`content:${word}`); }
      }
    }
    return { agentId: agent.agentId, agent, score, reasons };
  }

  /**
   * 把一个 task 路由给最合适的 agent。
   * @returns {{routed:true, agentId, agent, score, reasons, candidates}
   *          | {routed:false, reason:'no-matching-agent', candidates:[]}}
   */
  route(task) {
    const candidates = [];
    for (const agent of this.agents.values()) {
      if (agent.status !== 'online') continue;
      const s = this.score(agent, task);
      if (s && s.score > 0) candidates.push(s);
    }
    // 分数降序；同分保持注册顺序（Array.prototype.sort 是稳定排序）
    candidates.sort((a, b) => b.score - a.score);
    if (candidates.length === 0) {
      return { routed: false, reason: 'no-matching-agent', candidates: [] };
    }
    const best = candidates[0];
    return {
      routed: true,
      agentId: best.agentId,
      agent: best.agent,
      score: best.score,
      reasons: best.reasons,
      candidates: candidates.map((c) => ({ agentId: c.agentId, score: c.score, reasons: c.reasons })),
    };
  }
}
