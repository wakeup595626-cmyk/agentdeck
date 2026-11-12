// src/dedupe.js
// 去重 + claim/lease 状态机。
//
// 两层防撞车：
//  1) 消息级去重：同一个 message id 只处理一次，重复投递直接跳过。
//  2) 任务级认领：同一个 taskId 同一时刻只允许一个 agent 持有 claim。
//     claim 带 lease（租约），过期未续租 / 未交 result，别人可以接管，
//     避免某个 agent 死了以后任务永远卡住。
//
// 状态机（per taskId）：
//   (none) --claim--> claimed --complete--> done（终态，不可再认领）
//                       |  \
//                       |   --release--> (none)
//                       --lease 过期--> expired --claim(别人)--> claimed

export class DedupeStore {
  /**
   * @param {object} [opts]
   * @param {number} [opts.leaseMs=30000] 默认租约时长（毫秒）
   * @param {() => number} [opts.now] 时钟函数，可注入假时钟便于测试
   */
  constructor({ leaseMs = 30_000, now = () => Date.now() } = {}) {
    this.leaseMs = leaseMs;
    this.now = now;
    /** @type {Map<string, number>} messageId -> firstSeenAt */
    this.seenMessages = new Map();
    /** @type {Map<string, object>} taskId -> claim record */
    this.claims = new Map();
  }

  // ---------- 消息级去重 ----------

  hasSeen(messageId) {
    return this.seenMessages.has(messageId);
  }

  /**
   * 标记一条消息已处理。
   * @returns {boolean} true = 第一次见；false = 重复投递，应跳过
   */
  markSeen(messageId) {
    if (this.seenMessages.has(messageId)) return false;
    this.seenMessages.set(messageId, this.now());
    return true;
  }

  // ---------- 任务级 claim / lease ----------

  #isExpired(claim) {
    return claim.status === 'claimed' && this.now() >= claim.expiresAt;
  }

  /** 读取当前 claim（过期会被惰性标记为 expired）。 */
  getClaim(taskId) {
    const claim = this.claims.get(taskId);
    if (!claim) return null;
    if (this.#isExpired(claim)) claim.status = 'expired';
    return claim;
  }

  isClaimed(taskId) {
    const claim = this.getClaim(taskId);
    return !!claim && claim.status === 'claimed';
  }

  isDone(taskId) {
    const claim = this.claims.get(taskId);
    return !!claim && claim.status === 'done';
  }

  /**
   * 尝试认领一个任务。
   * @returns {{claimed:true, taskId, agentId, leaseId:number, expiresAt:number}
   *          | {claimed:false, reason:string, holder?:string, status?:string}}
   */
  claim(taskId, agentId, { leaseMs } = {}) {
    if (!taskId) throw new TypeError('claim: taskId is required');
    if (!agentId) throw new TypeError('claim: agentId is required');

    const existing = this.getClaim(taskId);
    if (existing) {
      if (existing.status === 'done') {
        return { claimed: false, reason: 'already-done', holder: existing.agentId, status: 'done' };
      }
      if (existing.status === 'claimed') {
        if (existing.agentId === agentId) {
          // 自己重复认领 = 续租，幂等
          existing.expiresAt = this.now() + (leaseMs ?? this.leaseMs);
          return {
            claimed: true, renewed: true, taskId, agentId,
            leaseId: existing.leaseId, expiresAt: existing.expiresAt,
          };
        }
        return { claimed: false, reason: 'already-claimed', holder: existing.agentId, status: 'claimed' };
      }
      // status === 'expired'： fall through，允许接管
    }

    const claim = {
      taskId,
      agentId,
      status: 'claimed',
      leaseId: existing ? existing.leaseId + 1 : 1,
      claimedAt: this.now(),
      expiresAt: this.now() + (leaseMs ?? this.leaseMs),
      previousHolder: existing ? existing.agentId : null,
    };
    this.claims.set(taskId, claim);
    return {
      claimed: true, taskId, agentId,
      leaseId: claim.leaseId, expiresAt: claim.expiresAt,
      tookOver: !!existing,
      previousHolder: claim.previousHolder,
    };
  }

  /** 持有人续租。不是持有人 / 没有 claim / 已完成都会失败。 */
  renew(taskId, agentId, { leaseMs } = {}) {
    const claim = this.getClaim(taskId);
    if (!claim || claim.status !== 'claimed') {
      return { renewed: false, reason: claim ? `status-${claim.status}` : 'no-claim' };
    }
    if (claim.agentId !== agentId) {
      return { renewed: false, reason: 'not-holder', holder: claim.agentId };
    }
    claim.expiresAt = this.now() + (leaseMs ?? this.leaseMs);
    return { renewed: true, taskId, agentId, expiresAt: claim.expiresAt };
  }

  /** 持有人主动释放，任务回到可认领状态。 */
  release(taskId, agentId) {
    const claim = this.getClaim(taskId);
    if (!claim) return { released: false, reason: 'no-claim' };
    if (claim.agentId !== agentId) return { released: false, reason: 'not-holder', holder: claim.agentId };
    this.claims.delete(taskId);
    return { released: true, taskId, agentId };
  }

  /** 持有人交 result 后标记完成，终态，任何人不能再认领。 */
  complete(taskId, agentId) {
    const claim = this.getClaim(taskId);
    if (!claim) {
      // 没 claim 过就直接交结果：也记为 done，防止迟到的重复投递再被执行
      this.claims.set(taskId, {
        taskId, agentId, status: 'done', leaseId: 0,
        claimedAt: null, expiresAt: null, completedAt: this.now(), previousHolder: null,
      });
      return { completed: true, taskId, agentId, withoutClaim: true };
    }
    if (claim.agentId !== agentId) {
      return { completed: false, reason: 'not-holder', holder: claim.agentId };
    }
    if (claim.status === 'done') return { completed: true, taskId, agentId, alreadyDone: true };
    claim.status = 'done';
    claim.completedAt = this.now();
    return { completed: true, taskId, agentId };
  }

  /** 清理过期记录（可选，状态本身已惰性处理）。 */
  sweep() {
    let expired = 0;
    for (const claim of this.claims.values()) {
      if (this.#isExpired(claim)) { claim.status = 'expired'; expired++; }
    }
    return { expired };
  }
}

// 兼容别名
export const ClaimStore = DedupeStore;
