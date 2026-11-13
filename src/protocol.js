// src/protocol.js
// 最小协议：只有 4 种消息类型 register / task / heartbeat / result。
// 全部是普通 JSON 对象，核心只关心「消息进出 + 状态机」，
// 不依赖任何一家 CLI 的私有开关。

import { randomUUID } from 'node:crypto';

export const MESSAGE_TYPES = Object.freeze(['register', 'task', 'heartbeat', 'result']);

function base(type, fields = {}) {
  return {
    id: fields.id ?? randomUUID(),
    type,
    ts: fields.ts ?? Date.now(),
    ...fields,
  };
}

/**
 * agent 上线自报能力。
 * capabilities: 能力标签数组，如 ['code', 'image-gen', 'image-read']
 * keywords:     额外关键词数组，用于关键词路由，如 ['画图', '截图']
 */
export function createRegister({ agentId, name, server, runtime, capabilities = [], keywords = [], ...rest } = {}) {
  if (!agentId) throw new TypeError('createRegister: agentId is required');
  return base('register', {
    agentId,
    name: name ?? agentId,
    server: server ?? null,
    runtime: runtime ?? null,
    capabilities: [...capabilities],
    keywords: [...keywords],
    ...rest,
  });
}

/**
 * 一个待执行的任务。
 * taskId:       任务的稳定标识，同一任务重复投递时 taskId 不变（防撞车靠它）
 * content:      任务文本，路由器会从中匹配关键词
 * requiredTags: 硬性需要的能力标签，如 ['image-gen']
 * keywords:     任务关键词，如 ['生成', '海报']
 */
export function createTask({ taskId, content = '', requiredTags = [], keywords = [], from = null, ...rest } = {}) {
  return base('task', {
    taskId: taskId ?? randomUUID(),
    content,
    requiredTags: [...requiredTags],
    keywords: [...keywords],
    from,
    ...rest,
  });
}

/** agent 还活着，可顺带续租它持有的 claim。 */
export function createHeartbeat({ agentId, ...rest } = {}) {
  if (!agentId) throw new TypeError('createHeartbeat: agentId is required');
  return base('heartbeat', { agentId, ...rest });
}

/** agent 交回结果。status: 'ok' | 'error' | 'done' 等自由字符串，'ok'/'done' 视为完成。 */
export function createResult({ taskId, agentId, status = 'ok', output = null, ...rest } = {}) {
  if (!taskId) throw new TypeError('createResult: taskId is required');
  if (!agentId) throw new TypeError('createResult: agentId is required');
  return base('result', { taskId, agentId, status, output, ...rest });
}

/**
 * 校验一条消息。返回 { ok, errors }，不抛异常，方便路由器直接拒绝坏消息。
 */
export function validateMessage(msg) {
  const errors = [];
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return { ok: false, errors: ['message must be a plain object'] };
  }
  if (!msg.id || typeof msg.id !== 'string') errors.push('id must be a non-empty string');
  if (!MESSAGE_TYPES.includes(msg.type)) {
    errors.push(`type must be one of: ${MESSAGE_TYPES.join(', ')}`);
    return { ok: false, errors };
  }

  // runId 在边界上就挡掉（P0'-2）：可选，可以缺省，但一旦出现就必须是
  // 非空字符串。空串会让两个进程在 DedupeStore 里互相认同（'' === ''），
  // 等于防撞车失效；非字符串则会有 123 与 '123' 之类的隐式相等风险。
  // 与 normalizeIdentity 的规则一致：缺省/null 走 agent 级租约，'' 和非字符串
  // 一律拒绝。不能让 '' 通过校验——heartbeat/result 里的 `msg.runId ?? null`
  // 会把它带进 renew/complete 的路径，静默降级正是要堵的那个洞。
  if (msg.runId !== undefined && msg.runId !== null) {
    if (typeof msg.runId !== 'string' || msg.runId === '') {
      errors.push('runId must be a non-empty string when provided');
    }
  }

  switch (msg.type) {
    case 'register':
      if (!msg.agentId) errors.push('register.agentId is required');
      if (msg.capabilities !== undefined && !Array.isArray(msg.capabilities)) {
        errors.push('register.capabilities must be an array');
      }
      if (msg.keywords !== undefined && !Array.isArray(msg.keywords)) {
        errors.push('register.keywords must be an array');
      }
      break;
    case 'task':
      if (!msg.taskId) errors.push('task.taskId is required');
      if (msg.requiredTags !== undefined && !Array.isArray(msg.requiredTags)) {
        errors.push('task.requiredTags must be an array');
      }
      if (msg.keywords !== undefined && !Array.isArray(msg.keywords)) {
        errors.push('task.keywords must be an array');
      }
      break;
    case 'heartbeat':
      if (!msg.agentId) errors.push('heartbeat.agentId is required');
      break;
    case 'result':
      if (!msg.taskId) errors.push('result.taskId is required');
      if (!msg.agentId) errors.push('result.agentId is required');
      break;
  }
  return { ok: errors.length === 0, errors };
}

export function assertValidMessage(msg) {
  const { ok, errors } = validateMessage(msg);
  if (!ok) throw new TypeError(`invalid message: ${errors.join('; ')}`);
  return msg;
}
