import type { ACPMessage } from './types.ts';
import type { Agent } from '../agent.ts';

// sessionId 命名空间：CLI 固定 'cli'，QQ 固定 'qq'，Web 由客户端传入。
export function resolveSessionId(channel: string, clientSessionId?: string): string {
  if (channel === 'cli') return 'cli';
  return clientSessionId ?? `web-${Date.now()}`;
}

// 静态团队路由：仅匹配单一、明确的专家请求。
// 复合任务（如"写代码+审查+加注释"）不在此处路由，交由 Orchestrator 拆解分派。
// 返回 null 表示未匹配，交给 Orchestrator 处理。
export function routeToAgent(
  content: string,
  agentMap: Map<string, Agent>,
): Agent | null {
  const lower = content.toLowerCase();

  // 只有不包含"写"/"实现"/"创建"等编码意图时，才直接路由给专家
  const hasCodeIntent = /写|实现|创建|编写|开发|build|create|implement|write/.test(lower);
  if (hasCodeIntent) return null; // 复合任务 → Orchestrator

  if (/^(帮我)?(做个?|做一下|做一次|请做|进行|给.*做|做代码)?审查|^review|^code review/.test(lower))
    return agentMap.get('reviewer') ?? null;

  if (/^(帮我)?(写|生成|加上|添加)(一下|一份|一个)?(文档|readme|注释|jsdoc)/.test(lower))
    return agentMap.get('writer') ?? null;

  if (/^(帮我)?(做个?|分析|看看)(性能|优化|复杂度)/.test(lower))
    return agentMap.get('optimizer') ?? null;

  if (/漏洞|安全风险|sql\s*injection|xss|注入/.test(lower))
    return agentMap.get('skeptic') ?? null;

  return null; // 无法匹配，交由 Orchestrator（含 delegate 工具）处理
}
