import path from 'node:path';
import { readdir, unlink } from 'node:fs/promises';
import type {
  AgentMessage,
  SessionMeta,
  SessionRecord,
  SessionSearch,
  SessionStatus,
  UsageTotals,
} from '@mookacode/protocol';
import { mookaHome } from '../util/paths';
import { readJson, writeJsonAtomic } from '../util/fs';
import { shortId } from '../util/ids';
import { redactObject, redactSecrets } from '../util/redact';

interface SessionIndex {
  version: 1;
  sessions: SessionMeta[];
}

function emptyUsage(): UsageTotals {
  return { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export class SessionStore {
  private readonly directory: string;
  private readonly indexPath: string;
  private index: SessionIndex | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor() {
    this.directory = path.join(mookaHome(), 'sessions');
    this.indexPath = path.join(this.directory, 'index.json');
  }

  private sessionPath(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid session id');
    return path.join(this.directory, `${id}.json`);
  }

  async create(options: {
    cwd: string;
    projectRoot: string;
    mode: SessionRecord['mode'];
    provider: string;
    model: string;
    title?: string;
    parentId?: string;
  }): Promise<SessionRecord> {
    const now = Date.now();
    const record: SessionRecord = {
      id: shortId('ses'),
      title: options.title?.slice(0, 160) || 'New session',
      cwd: options.cwd,
      projectRoot: options.projectRoot,
      createdAt: now,
      updatedAt: now,
      mode: options.mode,
      provider: options.provider,
      model: options.model,
      status: 'active',
      usage: emptyUsage(),
      messageCount: 0,
      changedFiles: [],
      messages: [],
      checkpoints: [],
      parentId: options.parentId,
    };
    await this.save(record);
    return record;
  }

  async get(id: string): Promise<SessionRecord | null> {
    const data = await readJson<SessionRecord>(this.sessionPath(id));
    if (!data) return null;
    data.usage = { ...emptyUsage(), ...data.usage };
    data.messages = data.messages ?? [];
    data.checkpoints = data.checkpoints ?? [];
    data.changedFiles = data.changedFiles ?? [];
    return data;
  }

  async save(record: SessionRecord): Promise<void> {
    record.updatedAt = Date.now();
    record.messageCount = record.messages.length;
    const redacted: SessionRecord = {
      ...record,
      title: redactSecrets(record.title),
      summary: record.summary ? redactSecrets(record.summary) : undefined,
      contextSummary: record.contextSummary ? redactSecrets(record.contextSummary) : undefined,
      plan: record.plan ? redactSecrets(record.plan) : undefined,
      pendingTask: record.pendingTask ? redactSecrets(record.pendingTask) : undefined,
      messages: record.messages.map((message) => ({
        ...message,
        content: redactSecrets(message.content),
        reasoning: message.reasoning ? redactSecrets(message.reasoning) : undefined,
        toolCalls: message.toolCalls ? redactObject(message.toolCalls) : undefined,
        meta: message.meta ? redactObject(message.meta) : undefined,
      })),
    };
    await this.enqueue(async () => {
      await writeJsonAtomic(this.sessionPath(record.id), redacted, 0o600);
      const index = await this.readIndex();
      const meta = toMeta(redacted);
      const existing = index.sessions.findIndex((item) => item.id === meta.id);
      if (existing === -1) index.sessions.unshift(meta);
      else index.sessions[existing] = meta;
      index.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
      await writeJsonAtomic(this.indexPath, index, 0o600);
    });
  }

  async list(search: SessionSearch = {}): Promise<SessionMeta[]> {
    const index = await this.readIndex();
    const limit = Math.max(1, Math.min(500, search.limit ?? 100));
    const query = search.query?.toLowerCase();
    return index.sessions
      .filter((session) => {
        if (!search.includeArchived && (session.archived || session.status === 'archived')) return false;
        if (search.status && session.status !== search.status) return false;
        if (search.cwd && path.resolve(session.cwd) !== path.resolve(search.cwd)) return false;
        if (query) {
          const haystack = `${session.title} ${session.summary ?? ''} ${session.cwd} ${session.model}`.toLowerCase();
          if (!haystack.includes(query)) return false;
        }
        return true;
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  async latest(cwd?: string): Promise<SessionRecord | null> {
    const sessions = await this.list({ cwd, limit: 1, includeArchived: false });
    return sessions[0] ? this.get(sessions[0].id) : null;
  }

  async rename(id: string, title: string): Promise<SessionMeta | null> {
    const record = await this.get(id);
    if (!record) return null;
    record.title = title.slice(0, 160);
    await this.save(record);
    return toMeta(record);
  }

  async archive(id: string, archived = true): Promise<SessionMeta | null> {
    const record = await this.get(id);
    if (!record) return null;
    record.archived = archived;
    record.status = archived ? 'archived' : record.status === 'archived' ? 'completed' : record.status;
    await this.save(record);
    return toMeta(record);
  }

  async delete(id: string): Promise<boolean> {
    const record = await this.get(id);
    if (!record) return false;
    await unlink(this.sessionPath(id)).catch(() => undefined);
    await this.enqueue(async () => {
      const index = await this.readIndex();
      index.sessions = index.sessions.filter((item) => item.id !== id);
      await writeJsonAtomic(this.indexPath, index, 0o600);
    });
    return true;
  }

  async setStatus(record: SessionRecord, status: SessionStatus): Promise<void> {
    record.status = status;
    if (status !== 'active') record.pendingTask = undefined;
    await this.save(record);
  }

  async appendUserMessage(record: SessionRecord, task: string): Promise<AgentMessage> {
    const message: AgentMessage = {
      id: shortId('msg'),
      role: 'user',
      content: task,
      createdAt: Date.now(),
    };
    record.messages.push(message);
    if (record.title === 'New session') record.title = task.slice(0, 80).replace(/\s+/g, ' ').trim();
    record.pendingTask = task;
    record.status = 'active';
    await this.save(record);
    return message;
  }

  async addUsage(record: SessionRecord, usage: Partial<UsageTotals>): Promise<void> {
    record.usage.requests += usage.requests ?? 1;
    record.usage.inputTokens += usage.inputTokens ?? 0;
    record.usage.outputTokens += usage.outputTokens ?? 0;
    record.usage.cacheReadTokens += usage.cacheReadTokens ?? 0;
    record.usage.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    if (record.usage.costUsd !== undefined || usage.costUsd !== undefined) {
      record.usage.costUsd = (record.usage.costUsd ?? 0) + (usage.costUsd ?? 0);
    }
  }

  private async readIndex(): Promise<SessionIndex> {
    if (this.index) return this.index;
    const existing = await readJson<SessionIndex>(this.indexPath);
    if (existing?.sessions) {
      this.index = existing;
      return existing;
    }
    const rebuilt = await this.rebuildIndex();
    this.index = rebuilt;
    return rebuilt;
  }

  private async rebuildIndex(): Promise<SessionIndex> {
    const index: SessionIndex = { version: 1, sessions: [] };
    let files: string[] = [];
    try {
      files = (await readdir(this.directory)).filter((name) => name.endsWith('.json') && name !== 'index.json');
    } catch {
      return index;
    }
    for (const file of files) {
      const record = await readJson<SessionRecord>(path.join(this.directory, file));
      if (record?.id) index.sessions.push(toMeta(record));
    }
    index.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    await writeJsonAtomic(this.indexPath, index, 0o600);
    return index;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }
}

function toMeta(record: SessionRecord): SessionMeta {
  return {
    id: record.id,
    title: record.title,
    cwd: record.cwd,
    projectRoot: record.projectRoot,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    mode: record.mode,
    provider: record.provider,
    model: record.model,
    status: record.status,
    summary: record.summary,
    usage: record.usage,
    messageCount: record.messages.length,
    changedFiles: record.changedFiles,
    archived: record.archived,
    parentId: record.parentId,
    plan: record.plan,
  };
}
