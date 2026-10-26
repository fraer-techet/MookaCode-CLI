import { minimatch } from 'minimatch';
import type {
  AgentMode,
  PermissionConfig,
  PermissionDecision,
  PermissionRequest,
  PermissionResponse,
  ToolRisk,
} from '@mookacode/protocol';
import { PermissionDeniedError } from '../util/errors';

export type PermissionCategory = keyof Omit<PermissionConfig, 'commandRules' | 'toolOverrides'>;

export interface PermissionCheck {
  tool: string;
  category: PermissionCategory;
  mode: AgentMode;
  risk: ToolRisk;
  title: string;
  detail: string;
  paths?: string[];
  command?: string;
  preview?: string;
}

const READ_ONLY_MODES: AgentMode[] = ['plan', 'ask', 'review'];
const SHELL_META = /[;&|`$<>\n\r]/;

export function isReadOnlyMode(mode: AgentMode): boolean {
  return READ_ONLY_MODES.includes(mode);
}

export function isSimpleCommand(command: string): boolean {
  return !SHELL_META.test(command);
}

export class PermissionEngine {
  private config: PermissionConfig;
  private readonly sessionOverrides = new Set<string>();

  constructor(config: PermissionConfig) {
    this.config = structuredClone(config);
  }

  setConfig(config: PermissionConfig): void {
    this.config = structuredClone(config);
  }

  addSessionAllow(tool: string): void {
    this.sessionOverrides.add(tool);
  }

  decisionFor(check: PermissionCheck): PermissionDecision {
    if (this.sessionOverrides.has(check.tool)) return 'allow';
    const override = this.config.toolOverrides[check.tool];
    if (override) return override;

    if (check.category === 'command' && check.command) {
      for (const rule of this.config.commandRules) {
        if (!minimatch(check.command, rule.pattern, { dot: true, nocase: process.platform === 'win32' })) continue;
        if (rule.decision === 'deny') return 'deny';
        if (isSimpleCommand(check.command)) return rule.decision;
      }
    }
    const base = this.config[check.category];
    if (check.risk.level === 'high' && base === 'allow') return 'ask';
    if (isReadOnlyMode(check.mode) && (check.category === 'edit' || check.category === 'gitWrite')) return 'deny';
    if (isReadOnlyMode(check.mode) && check.category === 'command') return 'deny';
    if (isReadOnlyMode(check.mode) && check.category === 'mcp' && check.risk.level !== 'safe') return 'deny';
    return base;
  }

  buildRequest(check: PermissionCheck): PermissionRequest {
    return {
      id: `perm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      tool: check.tool,
      category: check.category,
      decision: this.decisionFor(check),
      risk: check.risk,
      title: check.title,
      detail: check.detail,
      paths: check.paths,
      command: check.command,
      preview: check.preview,
    };
  }

  async authorize(
    check: PermissionCheck,
    confirm?: (request: PermissionRequest) => Promise<PermissionResponse>,
  ): Promise<void> {
    const request = this.buildRequest(check);
    if (request.decision === 'deny') {
      throw new PermissionDeniedError(
        `Permission denied for ${check.tool}: ${check.detail || 'blocked by policy'}. Update permissions in "mookacode config" if this is intended.`,
        { request },
      );
    }
    if (request.decision === 'allow') return;
    if (!confirm) {
      throw new PermissionDeniedError(
        `Approval required for ${check.tool}, but no interactive confirmation channel is available. Run interactively or configure permissions.`,
        { request },
      );
    }
    const response = await confirm(request);
    if (!response.approved) {
      throw new PermissionDeniedError(response.reason || `User denied ${check.tool}.`, { request });
    }
    if (response.alwaysAllow || response.rememberTool) this.sessionOverrides.add(check.tool);
  }
}
