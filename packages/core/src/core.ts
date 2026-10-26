import path from 'node:path';
import type {
  AgentEvent,
  AgentMode,
  AgentRunOptions,
  AgentRunResult,
  ConfigSnapshot,
  DiagnosticsSummary,
  MookaConfig,
  PermissionRequest,
  PermissionResponse,
  ProjectProfile,
  ProviderModelView,
  ProviderConfig,
  SessionMeta,
  SessionRecord,
  SessionSearch,
} from '@mookacode/protocol';
import { CredentialStore } from './auth/store';
import { AgentEngine } from './agent/engine';
import { ConfigManager, deepMerge } from './config/loader';
import { defaultConfig } from './config/defaults';
import { validateConfig } from './config/schema';
import { TrustStore } from './config/trust';
import { MemoryStore } from './context/memory';
import { GitService } from './git/service';
import { LspManager } from './lsp/manager';
import { McpManager } from './mcp/manager';
import { detectProject } from './project/info';
import { findProjectRoot } from './project/root';
import { ProviderManager } from './providers/manager';
import { SessionStore } from './sessions/store';
import { SubagentManager } from './subagents/manager';
import { builtinTools } from './tools/builtins';
import type { AnyToolDefinition } from './tools/types';
import { MookaError } from './util/errors';
import { readJson, writeJsonAtomic } from './util/fs';
import { mookaHome, safeRealpath } from './util/paths';
import { MOOKACODE_VERSION } from './version';
import { WorkspaceGuard } from './workspace/guard';

export interface CoreOptions {
  cwd?: string;
  trustProject?: boolean;
}

export class MookaCore {
  readonly cwd: string;
  root: string;
  snapshot: ConfigSnapshot;
  config: MookaConfig;
  trustedProject: boolean;
  readonly configManager: ConfigManager;
  readonly credentials: CredentialStore;
  readonly providers: ProviderManager;
  readonly sessionStore: SessionStore;
  readonly trustStore: TrustStore;
  readonly memory: MemoryStore;
  project: ProjectProfile;
  guard: WorkspaceGuard;
  git: GitService;
  lsp: LspManager;
  mcp: McpManager;
  subagents: SubagentManager;
  private baseBuiltins: AnyToolDefinition[];
  private initialized = false;

  private constructor(options: CoreOptions, root: string, snapshot: ConfigSnapshot, project: ProjectProfile) {
    this.cwd = path.resolve(options.cwd ?? process.cwd());
    this.root = root;
    this.snapshot = snapshot;
    this.config = snapshot.config;
    this.trustedProject = snapshot.projectTrusted;
    this.configManager = new ConfigManager(root);
    this.credentials = new CredentialStore();
    this.providers = new ProviderManager(this.config, this.credentials);
    this.sessionStore = new SessionStore();
    this.trustStore = new TrustStore();
    this.memory = new MemoryStore(root, this.config.context.memoryMaxEntries);
    this.project = project;
    this.guard = new WorkspaceGuard(root);
    this.git = new GitService(root);
    this.lsp = new LspManager(this.config.lspServers, root);
    this.mcp = new McpManager(this.config.mcpServers);
    this.baseBuiltins = builtinTools();
    this.subagents = new SubagentManager({
      config: this.config,
      project: this.project,
      providers: this.providers,
      guard: this.guard,
      git: this.git,
      lsp: this.lsp,
      mcp: this.mcp,
      builtinTools: this.baseBuiltins,
      trustedProject: this.trustedProject,
    });
  }

  static async create(options: CoreOptions = {}): Promise<MookaCore> {
    const requestedCwd = path.resolve(options.cwd ?? process.cwd());
    const cwd = (await safeRealpath(requestedCwd)) ?? requestedCwd;
    const detectedRoot = await findProjectRoot(cwd);
    const root = (await safeRealpath(detectedRoot)) ?? detectedRoot;
    const trustStore = new TrustStore();
    const storedTrust = await trustStore.isTrusted(root);
    const trustedProject = options.trustProject ?? storedTrust;
    const configManager = new ConfigManager(root);
    const snapshot = await configManager.load({ trustProject: trustedProject });
    if (!(await readJson(snapshot.globalPath))) {
      await writeJsonAtomic(snapshot.globalPath, defaultConfig(), 0o600);
    }
    const project = await detectProject(root, snapshot.config);
    const core = new MookaCore({ ...options, cwd }, root, snapshot, project);
    core.initialized = true;
    return core;
  }

  get configPath(): string {
    return this.snapshot.globalPath;
  }

  get projectConfigPath(): string | undefined {
    return this.snapshot.projectPath;
  }

  async reload(): Promise<ConfigSnapshot> {
    const snapshot = await this.configManager.load({ trustProject: this.trustedProject });
    await this.mcp.close().catch(() => undefined);
    await this.lsp.stopAll().catch(() => undefined);
    this.snapshot = snapshot;
    this.config = snapshot.config;
    this.trustedProject = snapshot.projectTrusted;
    this.providers.setConfig(this.config);
    this.providers.clearKeyCache();
    this.memory.setMaxEntries(this.config.context.memoryMaxEntries);
    this.project = await detectProject(this.root, this.config);
    this.lsp = new LspManager(this.config.lspServers, this.root);
    this.mcp = new McpManager(this.config.mcpServers);
    this.subagents = new SubagentManager({
      config: this.config,
      project: this.project,
      providers: this.providers,
      guard: this.guard,
      git: this.git,
      lsp: this.lsp,
      mcp: this.mcp,
      builtinTools: this.baseBuiltins,
      trustedProject: this.trustedProject,
    });
    return snapshot;
  }

  async runAgent(
    options: AgentRunOptions & { requestPermission?: (request: PermissionRequest) => Promise<PermissionResponse> },
    emit: (event: AgentEvent) => void,
  ): Promise<AgentRunResult> {
    const tools = [...this.baseBuiltins];
    const subagentTool = await this.subagents.toolDefinition();
    if (subagentTool) tools.push(subagentTool);
    const engine = new AgentEngine({
      config: this.config,
      sessionStore: this.sessionStore,
      providers: this.providers,
      credentials: this.credentials,
      project: this.project,
      guard: this.guard,
      git: this.git,
      lsp: this.lsp,
      mcp: this.mcp,
      memory: this.memory,
      builtinTools: tools,
      subagentRunner: (name, task, parent) => this.subagents.run(name, task, parent),
    });
    return engine.run({ ...options, emit });
  }

  async listSessions(search: SessionSearch = {}): Promise<SessionMeta[]> {
    return this.sessionStore.list(search);
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    return this.sessionStore.get(id);
  }

  async renameSession(id: string, title: string): Promise<SessionMeta | null> {
    return this.sessionStore.rename(id, title);
  }

  async archiveSession(id: string, archived = true): Promise<SessionMeta | null> {
    return this.sessionStore.archive(id, archived);
  }

  async deleteSession(id: string): Promise<boolean> {
    return this.sessionStore.delete(id);
  }

  async models(): Promise<ProviderModelView[]> {
    const status = await this.providers.keyStatus();
    return this.providers.listModels(status);
  }

  async authList(): Promise<Array<{ providerId: string; backend: string; updatedAt: number }>> {
    return this.credentials.list();
  }

  async authBackend(): Promise<string> {
    return this.credentials.getBackend();
  }

  async setApiKey(providerId: string, apiKey: string): Promise<string> {
    this.providers.getProvider(providerId);
    const backend = await this.credentials.set(providerId, apiKey);
    this.providers.clearKeyCache();
    return backend;
  }

  async removeApiKey(providerId: string): Promise<boolean> {
    const removed = await this.credentials.remove(providerId);
    this.providers.clearKeyCache();
    return removed;
  }

  async probeProvider(providerId: string, modelId?: string) {
    return this.providers.probe(providerId, modelId);
  }

  async updateConfig(patch: Record<string, unknown>, scope: 'global' | 'project' = 'global'): Promise<ConfigSnapshot> {
    if (scope === 'project') {
      const projectPath = path.join(this.root, '.mookacode', 'config.json');
      const current = (await readJson<Record<string, unknown>>(projectPath)) ?? {};
      let merged = deepMerge(defaultConfig() as unknown as Record<string, unknown>, current);
      merged = deepMerge(merged, patch);
      const { issues } = validateConfig(merged);
      if (issues.length)
        throw new MookaError('CONFIG_INVALID', issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
      await writeJsonAtomic(projectPath, merged, 0o600);
      await this.trustStore.trust(this.root);
      this.trustedProject = true;
      return this.reload();
    }
    const raw = (await readJson<Record<string, unknown>>(this.snapshot.globalPath)) ?? {};
    let merged = deepMerge(defaultConfig() as unknown as Record<string, unknown>, raw);
    merged = deepMerge(merged, patch);
    const { config, issues } = validateConfig(merged);
    if (issues.length)
      throw new MookaError('CONFIG_INVALID', issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
    await writeJsonAtomic(this.snapshot.globalPath, config, 0o600);
    return this.reload();
  }

  async setDefault(providerId: string, modelId?: string): Promise<ConfigSnapshot> {
    const provider = this.providers.getProvider(providerId);
    const model = modelId ?? provider.models[0]?.id;
    if (!model || !provider.models.some((item) => item.id === model)) {
      throw new MookaError('MODEL_NOT_FOUND', `Model "${model ?? ''}" is not configured for ${providerId}.`);
    }
    return this.updateConfig({ defaultProvider: providerId, defaultModel: model, mode: this.config.mode });
  }

  async setMode(mode: AgentMode): Promise<ConfigSnapshot> {
    return this.updateConfig({ mode });
  }

  async addProvider(provider: ProviderConfig, setDefault = false): Promise<ConfigSnapshot> {
    const providers = this.config.providers.filter((item) => item.id !== provider.id);
    providers.push(provider);
    const patch: Record<string, unknown> = { providers };
    if (setDefault) {
      patch.defaultProvider = provider.id;
      patch.defaultModel = provider.models[0]?.id ?? this.config.defaultModel;
    }
    return this.updateConfig(patch);
  }

  async removeProvider(providerId: string): Promise<ConfigSnapshot> {
    if (this.config.providers.length <= 1)
      throw new MookaError('PROVIDER_REQUIRED', 'At least one provider must remain configured.');
    const providers = this.config.providers.filter((item) => item.id !== providerId);
    if (providers.length === this.config.providers.length)
      throw new MookaError('PROVIDER_NOT_FOUND', `Provider "${providerId}" not found.`);
    const patch: Record<string, unknown> = { providers };
    if (this.config.defaultProvider === providerId) {
      patch.defaultProvider = providers[0]?.id;
      patch.defaultModel = providers[0]?.models[0]?.id;
    }
    return this.updateConfig(patch);
  }

  async trustCurrentProject(): Promise<ConfigSnapshot> {
    await this.trustStore.trust(this.root);
    this.trustedProject = true;
    return this.reload();
  }

  async revokeProjectTrust(): Promise<ConfigSnapshot> {
    await this.trustStore.revoke(this.root);
    this.trustedProject = false;
    return this.reload();
  }

  async projectSnapshot(): Promise<ProjectProfile> {
    this.project = await detectProject(this.root, this.config);
    return this.project;
  }

  async mcpStatuses() {
    await this.mcp.initialize().catch(() => undefined);
    return this.mcp.statuses();
  }

  async refreshMcp() {
    await this.mcp.initialize().catch(() => undefined);
    await this.mcp.refresh();
    return this.mcp.statuses();
  }

  async lspStatuses() {
    return this.lsp.availableServers();
  }

  async diagnostics(files: string[]): Promise<DiagnosticsSummary[]> {
    const results: DiagnosticsSummary[] = [];
    for (const file of files) {
      const target = await this.guard.resolve(file, { mustExist: true });
      results.push(await this.lsp.diagnostics(target));
    }
    return results;
  }

  async gitStatus() {
    return this.git.status();
  }

  async gitDiff(paths?: string[], context?: number): Promise<string> {
    return this.git.diff(paths, { context });
  }

  async applyCheckpoint(ref: string): Promise<void> {
    await this.git.applyCheckpoint(ref);
  }

  async gitLog(limit = 20) {
    return this.git.log(limit);
  }

  info() {
    return {
      version: MOOKACODE_VERSION,
      pid: process.pid,
      cwd: this.cwd,
      root: this.root,
      home: mookaHome(),
      configPath: this.snapshot.globalPath,
      projectConfigPath: this.snapshot.projectPath,
      hasProjectConfig: this.snapshot.hasProjectConfig,
      projectTrusted: this.snapshot.projectTrusted,
      provider: this.config.defaultProvider,
      model: this.config.defaultModel,
      mode: this.config.mode,
      authBackend: this.credentials.getBackend(),
    };
  }

  async close(): Promise<void> {
    if (!this.initialized) return;
    this.initialized = false;
    await Promise.allSettled([this.mcp.close(), this.lsp.stopAll()]);
  }
}
