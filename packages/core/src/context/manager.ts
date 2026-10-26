import type { AgentMessage } from '@mookacode/protocol';
import { estimateMessagesTokens, estimateTokens, truncateEnd } from '../util/tokens';
import { sha256 } from '../util/fs';

export interface CompactionOptions {
  targetTokens: number;
  maxToolResultChars: number;
  previousSummary?: string;
  changedFiles?: string[];
}

export interface CompactionResult {
  messages: AgentMessage[];
  summary?: string;
  beforeTokens: number;
  afterTokens: number;
  compacted: boolean;
}

function cloneMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => ({ ...message, toolCalls: message.toolCalls?.map((call) => ({ ...call })) }));
}

function summarizeMessages(messages: AgentMessage[], previous?: string, changedFiles?: string[]): string {
  const lines: string[] = [];
  if (previous?.trim()) lines.push(previous.trim());
  for (const message of messages) {
    if (message.role === 'user') {
      lines.push(`User task: ${truncateEnd(message.content.replace(/\s+/g, ' '), 500)}`);
    } else if (message.role === 'assistant') {
      const text = message.content.replace(/\s+/g, ' ').trim();
      if (text) lines.push(`Assistant: ${truncateEnd(text, 260)}`);
      for (const call of message.toolCalls ?? []) {
        lines.push(`Tool call: ${call.name}(${truncateEnd(JSON.stringify(call.arguments), 160)})`);
      }
    } else if (message.role === 'tool') {
      const text = message.content.replace(/\s+/g, ' ').trim();
      if (text) lines.push(`Result[${message.toolName ?? 'tool'}]: ${truncateEnd(text, 240)}`);
    }
  }
  if (changedFiles?.length) lines.push(`Files changed earlier: ${changedFiles.join(', ')}`);
  let summary = lines.join('\n');
  if (estimateTokens(summary) > 2400) summary = truncateEnd(summary, 9000);
  return summary;
}

function dedupeToolResults(messages: AgentMessage[]): void {
  const seen = new Map<string, number>();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role !== 'tool') continue;
    const key = sha256(`${message.toolName ?? ''}:${message.content}`);
    const seenAt = seen.get(key);
    if (seenAt !== undefined) {
      message.content = `[Duplicate ${message.toolName ?? 'tool'} result omitted; identical content appeared earlier in the conversation.]`;
      message.meta = { ...(message.meta ?? {}), deduplicated: true };
    } else {
      seen.set(key, index);
    }
  }
}

export function compactContext(messages: AgentMessage[], options: CompactionOptions): CompactionResult {
  const beforeTokens = estimateMessagesTokens(messages);
  if (beforeTokens <= options.targetTokens) {
    return { messages, beforeTokens, afterTokens: beforeTokens, compacted: false };
  }

  let working = cloneMessages(messages);
  dedupeToolResults(working);
  let summary = options.previousSummary;

  const currentTurnStart = findLastUserIndex(working);
  if (currentTurnStart > 0) {
    const older = working.slice(0, currentTurnStart);
    summary = summarizeMessages(older, summary, options.changedFiles);
    working = working.slice(currentTurnStart);
    if (summary) {
      working.unshift({
        id: `compact_${Date.now()}`,
        role: 'user',
        content: `[Compacted context from earlier work]\n${summary}`,
        createdAt: Date.now(),
        meta: { synthetic: true },
      });
    }
  }

  let tokens = estimateMessagesTokens(working);
  if (tokens > options.targetTokens) {
    const toolIndexes = working
      .map((message, index) => (message.role === 'tool' ? index : -1))
      .filter((index) => index >= 0);
    const protect = new Set(toolIndexes.slice(-4));
    for (const index of toolIndexes) {
      if (protect.has(index)) continue;
      const message = working[index];
      if (!message) continue;
      if (message.content.length > 1200) {
        message.content = truncateEnd(message.content, 1200);
      }
    }
    const assistantIndexes = working
      .map((message, index) => (message.role === 'assistant' ? index : -1))
      .filter((index) => index >= 0);
    for (const index of assistantIndexes.slice(0, -3)) {
      const message = working[index];
      if (message && message.content.length > 1600) message.content = truncateEnd(message.content, 1600);
    }
  }

  tokens = estimateMessagesTokens(working);
  if (tokens > options.targetTokens) {
    // Drop oldest complete assistant/tool groups inside the current turn while preserving the user message.
    const groups: Array<{ start: number; end: number }> = [];
    let groupStart = -1;
    for (let index = 0; index < working.length; index++) {
      const message = working[index];
      if (!message) continue;
      if (message.role === 'assistant' && message.toolCalls?.length) {
        if (groupStart === -1) groupStart = index;
      } else if (message.role !== 'tool' && groupStart !== -1) {
        groups.push({ start: groupStart, end: index });
        groupStart = -1;
      }
    }
    if (groupStart !== -1) groups.push({ start: groupStart, end: working.length });
    const keepGroups = new Set(groups.slice(-2).map((group) => `${group.start}:${group.end}`));
    const removeIndexes = new Set<number>();
    for (const group of groups) {
      if (keepGroups.has(`${group.start}:${group.end}`)) continue;
      for (let index = group.start; index < group.end; index++) removeIndexes.add(index);
    }
    if (removeIndexes.size > 0) {
      const kept = working.filter((_, index) => !removeIndexes.has(index));
      const synthetic: AgentMessage = {
        id: `compact_${Date.now()}`,
        role: 'user',
        content: `[Earlier steps compacted to save context]\n${summary ?? summarizeMessages(working)}`,
        createdAt: Date.now(),
      };
      working = kept[0]?.role === 'user' ? [kept[0], synthetic, ...kept.slice(1)] : [synthetic, ...kept];
    }
  }

  tokens = estimateMessagesTokens(working);
  if (tokens > options.targetTokens) {
    for (const message of working) {
      if (message.role === 'tool') message.content = truncateEnd(message.content, 500);
      else if (message.role === 'assistant' && message.content.length > 900)
        message.content = truncateEnd(message.content, 900);
    }
  }

  tokens = estimateMessagesTokens(working);
  if (tokens > options.targetTokens && working.length > 1) {
    const lastUser = findLastUserIndex(working);
    const user = working[lastUser];
    if (user) {
      working = [user];
      tokens = estimateMessagesTokens(working);
    }
  }

  return {
    messages: working,
    summary,
    beforeTokens,
    afterTokens: tokens,
    compacted: true,
  };
}

function findLastUserIndex(messages: AgentMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === 'user') return index;
  }
  return 0;
}
