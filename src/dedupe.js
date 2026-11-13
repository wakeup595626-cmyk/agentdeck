// src/dedupe.js
// 去重 + claim/lease 状态机。
//
// 两层防撞车：
//  1) 消息级去重：同一个 message id 只处理一次，重复投递直接跳过。
//  2) 任务级认领：同一个 taskId 同一时刻只允许一个「执行者」持有 claim。
//     claim 带 lease（租约），过期未续租 / 未交 result，别人可以接管，
//     避免某个 agent 死了以后任务永远卡住。
//
// 关于「执行者」的定义（P0-1）：
//  身份不是 agentId，而是 (agentId, runId)。同一个 agent 在同一台机器上可能有
//  多个进程——典型例子就是本项目的头号场景：Pachat listener 和定时巡检是两个
//  进程，共用同一个 agentId。若身份只到 agentId，第二个进程 claim 时会命中
//  「自己重复认领 = 幂等续租」分支，两个进程都会执行，防撞车当场失效。
//  runId 每次进程启动时生成，lease 绑定 runId；续租与 complete 都校验 runId。
//
// 状态机（per taskId）：
//   (none) --claim--> claimed --complete--> done（终态，不可再认领）
//                       |  \
//                       |   --release--> (none)
//                       --lease 过期--> expired --claim(别人)--> claimed

/** 默认保留窗口。必须大于传输层可能重投一条消息的最大时间跨度。 */
export const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * 把旧调用形式 claim(taskId, agentId) 归一成 claim(taskId, {agentId, runId})。
 *
 * runId 的归一规则（P0'-2）：
 *  - 只有非空字符串才算「进程身份」。缺省 / null 归一成 null，表示 agent 级
 *    租约（这是旧签名和「编排器替 agent 认领」的兼容路径）。
 *  - 空串 **抛错**，不归一成 null。理由：显式传 runId 的调用方是在声明「我要
 *    进程级租约」，传 '' 是写错了；若把它悄悄降级成 agent 级，两个进程都会
 *    认领成功且无人报错——比直接失败更糟。宁可在边界大声失败。
 *  - 其它类型（数字、对象等）同样抛错，不做隐式转换：身份比较最怕 123 与
 *    '123' 这类隐式相等带来的假重合。
 */
function normalizeIdentity(agentIdOrIdentity) {
  if (agentIdOrIdentity && typeof agentIdOrIdentity === 'object') {
    const rawRunId = agentIdOrIdentity.runId;
    if (rawRunId === undefined || rawRunId === null) {
      return { agentId: agentIdOrIdentity.agentId, runId: null };
    }
    if (typeof rawRunId !== 'string' || rawRunId === '') {
      throw new TypeError('runId must be a non-empty string when provided');
    }
    return { agentId: agentIdOrIdentity.agentId, runId: rawRunId };
  }
  // 兼容旧签名：只给了 agentId 时，视为「该 agent 的一个匿名执行者」。
  return { agentId: agentIdOrIdentity, runId: null };
}

export class DedupeStore {
  /**
   * @param {object} [opts]
   * @param {number} [opts.leaseMs=30000] 默认租约时长（毫秒）
   * @param {number} [opts.retentionMs] 已见消息 / 已结束 claim 的保留窗口，超过才可清理
   * @param {() => number} [opts.now] 时钟函数，可注入假时钟便于测试
   * @param {number} [opts.initialLeaseSeq=0] leaseId 起始值；进程重启时传入上次持久化的
   *   序号，避免编号回退（P0'-1）。必须是安全正整数，否则回落 0
   */
  constructor({
    leaseMs = 30_000,
    retentionMs = DEFAULT_RETENTION_MS,
    now = () => Date.now(),
    initialLeaseSeq = 0,
  } = {}) {
    this.leaseMs = leaseMs;
    this.retentionMs = retentionMs;
    this.now = now;
    /** @type {Map<string, number>} messageId -> firstSeenAt */
    this.seenMessages = new Map();
    /** @type {Map<string, object>} taskId -> claim record */
    this.claims = new Map();
    /**
     * leaseId 的单调来源（P0-3 / P0'-1）。
     * 刻意独立于 claim 记录的生命周期：release() 会删记录，若编号跟着记录走，
     * 重新 claim 时会从 1 重来，拿它做 fencing token 的下游就会接受已作废的
     * 旧租约写入。这里只增不减。
     *
     * 注意：它只在**进程内**单调。进程重启后内存归零，所以本类不假装自己能跨
     * 重启保证单调——调用方应当把 leaseSeq 持久化，重启时用 initialLeaseSeq 回填。
     * 不做持久化就等于放弃 fencing 语义，此时 leaseId 只能当进程内的递增计数看。
     *
     * 用 isSafeInteger 而不是 isInteger：超过 MAX_SAFE_INTEGER 之后 ++ 不再改变
     * 数值（1e20 + 1 === 1e20），计数器会静默停住，单调性当场失效。宁可回落 0
     * 也不要接受一个注定不再递增的起点。
     */
    this.leaseSeq = Number.isSafeInteger(initialLeaseSeq) && initialLeaseSeq > 0 ? initialLeaseSeq : 0;
  }

  // ---------- 消息级去重 ----------

  hasSeen(messageId) {
    return this.seenMessages.has(messageId);
  }

  /**
   * 标记一条消息已「处理成功」。
   * 注意：调用方必须只在真正取得结果后调用（编排器里是 claim 成功之后），
   * 否则未路由/未认领的消息会被永久判重，重投也救不回来（P0-2）。
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

  #nextLeaseId() {
    return ++this.leaseSeq;
  }

  /**
   * 判断 holder 与调用方是不是同一个执行者。
   *
   * 规则分两档，这是刻意的：
   *  - claim 带 runId（进程级租约）：必须 runId 完全相等。这正是 P0-1 要挡的——
   *    同一 agent 的两个进程不能互相续租/替对方交结果。
   *  - claim 不带 runId（agent 级租约）：只比 agentId。适用于「中心编排器替
   *    某个 agent 认领」的模式——编排器并不知道对方进程的 runId，此时租约的
   *    粒度本来就只到 agent。真实进程拿到它之后可以正常续租和交结果。
   * 想防同 agent 内的撞车，就必须用进程级（带 runId）的 claim。
   */
  #isSameRunner(claim, agentId, runId) {
    if (claim.agentId !== agentId) return false;
    if (claim.runId == null) return true; // agent 级租约
    return claim.runId === runId;
  }

  /**
   * 尝试认领一个任务。
   * @param {string} taskId
   * @param {string | {agentId: string, runId?: string}} agentIdOrIdentity
   * @param {object} [opts]
   * @returns {{claimed:true, taskId, agentId, runId, leaseId:number, expiresAt:number, renewed?:true}
   *          | {claimed:false, reason:string, holder?:string, status?:string}}
   */
  claim(taskId, agentIdOrIdentity, { leaseMs } = {}) {
    if (!taskId) throw new TypeError('claim: taskId is required');
    const { agentId, runId } = normalizeIdentity(agentIdOrIdentity);
    if (!agentId) throw new TypeError('claim: agentId is required');

    const existing = this.getClaim(taskId);
    if (existing) {
      if (existing.status === 'done') {
        return { claimed: false, reason: 'already-done', holder: existing.agentId, status: 'done' };
      }
      if (existing.status === 'claimed') {
        if (this.#isSameRunner(existing, agentId, runId)) {
          // 同一个执行者重复认领 = 续租，幂等。租约编号不变。
          existing.expiresAt = this.now() + (leaseMs ?? this.leaseMs);
          return {
            claimed: true, renewed: true, taskId, agentId,
            runId: existing.runId, leaseId: existing.leaseId, expiresAt: existing.expiresAt,
          };
        }
        // 不同执行者（可能是同一 agent 的另一个进程）——拒绝。
        return { claimed: false, reason: 'already-claimed', holder: existing.agentId, status: 'claimed' };
      }
      // status === 'expired'： fall through，允许接管
    }

    const claim = {
      taskId,
      agentId,
      runId,
      status: 'claimed',
      leaseId: this.#nextLeaseId(),
      claimedAt: this.now(),
      expiresAt: this.now() + (leaseMs ?? this.leaseMs),
      previousHolder: existing ? existing.agentId : null,
      previousRunId: existing ? existing.runId : null,
    };
    this.claims.set(taskId, claim);
    return {
      claimed: true, taskId, agentId, runId,
      leaseId: claim.leaseId, expiresAt: claim.expiresAt,
      tookOver: !!existing,
      previousHolder: claim.previousHolder,
    };
  }

  /** 持有人续租。不是持有人 / 没有 claim / 已完成都会失败。必须传对 runId。 */
  renew(taskId, agentIdOrIdentity, { leaseMs } = {}) {
    const { agentId, runId } = normalizeIdentity(agentIdOrIdentity);
    const claim = this.getClaim(taskId);
    if (!claim || claim.status !== 'claimed') {
      return { renewed: false, reason: claim ? `status-${claim.status}` : 'no-claim' };
    }
    if (!this.#isSameRunner(claim, agentId, runId)) {
      return { renewed: false, reason: 'not-holder', holder: claim.agentId };
    }
    claim.expiresAt = this.now() + (leaseMs ?? this.leaseMs);
    return { renewed: true, taskId, agentId, runId, leaseId: claim.leaseId, expiresAt: claim.expiresAt };
  }

  /** 持有人主动释放，任务回到可认领状态。leaseId 不会因此回退。 */
  release(taskId, agentIdOrIdentity) {
    const { agentId, runId } = normalizeIdentity(agentIdOrIdentity);
    const claim = this.getClaim(taskId);
    if (!claim) return { released: false, reason: 'no-claim' };
    if (!this.#isSameRunner(claim, agentId, runId)) {
      return { released: false, reason: 'not-holder', holder: claim.agentId };
    }
    this.claims.delete(taskId);
    return { released: true, taskId, agentId, runId };
  }

  /**
   * 持有人交 result 后标记完成，终态，任何人不能再认领。
   *
   * 必须有有效 claim（P0-5）。旧实现在没有 claim 时会直接造一条 done 记录，
   * 等于任何人传个 taskId 就能把该任务永久标记完成——一个无授权的抢占入口。
   */
  complete(taskId, agentIdOrIdentity) {
    const { agentId, runId } = normalizeIdentity(agentIdOrIdentity);
    const claim = this.getClaim(taskId);
    if (!claim) {
      return { completed: false, reason: 'no-claim' };
    }
    if (!this.#isSameRunner(claim, agentId, runId)) {
      return { completed: false, reason: 'not-holder', holder: claim.agentId };
    }
    if (claim.status === 'done') return { completed: true, taskId, agentId, runId, alreadyDone: true };
    if (claim.status === 'expired') {
      // 租约已过期：此刻可能已有别人接管，或至少不再是有效持有者。
      return { completed: false, reason: 'lease-expired' };
    }
    claim.status = 'done';
    claim.completedAt = this.now();
    return { completed: true, taskId, agentId, runId, leaseId: claim.leaseId };
  }

  /**
   * 清理过期记录（P0-4）。
   *
   * 之前只把 claims 标成 expired，既不删已结束的记录，也从不清理 seenMessages，
   * 长跑的守护进程内存只增不减。这里按 retentionMs 清理：
   *  - seenMessages：超过保留窗口的已见消息可以忘掉（窗口必须 > 最大重放窗口）
   *  - claims：done 超过窗口的、expired 超过窗口的，可以删掉
   */
  sweep() {
    const cutoff = this.now() - this.retentionMs;
    let expired = 0;
    let droppedClaims = 0;
    let droppedSeen = 0;

    for (const claim of this.claims.values()) {
      if (this.#isExpired(claim)) { claim.status = 'expired'; expired++; }
    }

    for (const [taskId, claim] of this.claims) {
      if (claim.status === 'done' && claim.completedAt != null && claim.completedAt < cutoff) {
        this.claims.delete(taskId);
        droppedClaims++;
      } else if (claim.status === 'expired' && claim.expiresAt != null && claim.expiresAt < cutoff) {
        this.claims.delete(taskId);
        droppedClaims++;
      }
    }

    for (const [messageId, seenAt] of this.seenMessages) {
      if (seenAt < cutoff) {
        this.seenMessages.delete(messageId);
        droppedSeen++;
      }
    }

    return { expired, droppedClaims, droppedSeen };
  }
}

// 兼容别名
export const ClaimStore = DedupeStore;
