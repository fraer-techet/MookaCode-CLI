import { access } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { DiagnosticsSummary, LspServerConfig } from '@mookacode/protocol';
import { LspClient } from './client';
import { MookaError } from '../util/errors';

export class LspManager {
  private readonly servers: LspServerConfig[];
  private readonly root: string;
  private readonly clients = new Map<string, LspClient>();

  constructor(servers: LspServerConfig[], root: string) {
    this.servers = servers.filter((server) => server.enabled !== false);
    this.root = root;
  }

  async findServer(file: string): Promise<{ config: LspServerConfig; commandPath: string } | null> {
    const ext = path.extname(file).toLowerCase();
    for (const server of this.servers) {
      if (!server.fileExtensions.includes(ext)) continue;
      const commandPath = await resolveCommand(server.command, this.root);
      if (commandPath) return { config: server, commandPath };
    }
    return null;
  }

  async diagnostics(file: string): Promise<DiagnosticsSummary> {
    const resolved = await this.findServer(file);
    if (!resolved) {
      const installHint = this.installHint(file);
      throw new MookaError(
        'LSP_NOT_CONFIGURED',
        `No available language server is configured for ${path.extname(file) || 'this file type'}. ${installHint}`,
      );
    }
    let client = this.clients.get(resolved.config.id);
    if (!client) {
      client = new LspClient({ server: resolved.config, root: this.root, commandPath: resolved.commandPath });
      this.clients.set(resolved.config.id, client);
    }
    client.cancelIdleDispose();
    try {
      return await client.diagnosticsFor(file);
    } finally {
      client.scheduleIdleDispose();
    }
  }

  async availableServers(): Promise<Array<{ id: string; command: string; available: boolean; path?: string }>> {
    const result: Array<{ id: string; command: string; available: boolean; path?: string }> = [];
    for (const server of this.servers) {
      const commandPath = await resolveCommand(server.command, this.root);
      result.push({
        id: server.id,
        command: server.command,
        available: Boolean(commandPath),
        path: commandPath ?? undefined,
      });
    }
    return result;
  }

  private installHint(file: string): string {
    const ext = path.extname(file).toLowerCase();
    if (['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'].includes(ext)) {
      return 'Install it with "npm install -g typescript-language-server typescript" or add it to the project dev dependencies.';
    }
    if (ext === '.py') return 'Install pyright or python-lsp-server and configure it under lspServers.';
    if (ext === '.rs') return 'Install rust-analyzer and ensure it is on PATH.';
    return 'Configure a language server under lspServers in the MookaCode configuration.';
  }

  async stopAll(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled(clients.map((client) => client.stop()));
  }
}

export async function resolveCommand(command: string, root: string): Promise<string | null> {
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    try {
      await access(command);
      return command;
    } catch {
      return null;
    }
  }
  const localExtensions = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const ext of localExtensions) {
    const candidate = path.join(root, 'node_modules', '.bin', `${command}${ext}`);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue with PATH lookup.
    }
  }
  const lookup =
    process.platform === 'win32'
      ? spawnSync('where.exe', [command], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
      : spawnSync('which', [command], { encoding: 'utf8', timeout: 5000 });
  if (lookup.status === 0) {
    const first = lookup.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return first ?? null;
  }
  return null;
}
