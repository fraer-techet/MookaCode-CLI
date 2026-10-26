import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DiagnosticsSummary, LspServerConfig } from '@mookacode/protocol';
import { CancelledError, MookaError, errorMessage } from '../util/errors';
import { MOOKACODE_VERSION } from '../version';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface DiagnosticItem {
  range?: { start?: { line?: number; character?: number } };
  severity?: number;
  message?: string;
  source?: string;
}

export class LspClient {
  readonly server: LspServerConfig;
  readonly root: string;
  readonly commandPath: string;
  private child?: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private diagnostics = new Map<string, DiagnosticItem[]>();
  private diagnosticWaiters = new Map<string, Array<() => void>>();
  private capabilities: Record<string, unknown> = {};
  private opened = new Map<string, number>();
  private stderr = '';
  private disposed = false;
  private disposeTimer?: NodeJS.Timeout;

  constructor(options: { server: LspServerConfig; root: string; commandPath: string }) {
    this.server = options.server;
    this.root = options.root;
    this.commandPath = options.commandPath;
  }

  async start(): Promise<void> {
    if (this.child) return;
    this.child = spawn(this.commandPath, this.server.args ?? [], {
      cwd: this.root,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });
    this.child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => {
      if (this.stderr.length < 8000) this.stderr += chunk.toString('utf8');
    });
    this.child.on('error', (error) => this.failAll(error));
    this.child.on('exit', (code) => {
      if (this.disposed) return;
      this.failAll(new Error(`LSP server exited with code ${code}. ${this.stderr.slice(-1000)}`));
    });
    const rootUri = pathToFileURL(this.root).toString();
    const result = (await this.request(
      'initialize',
      {
        processId: process.pid,
        clientInfo: { name: 'MookaCode', version: MOOKACODE_VERSION },
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: path.basename(this.root) }],
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: false },
            diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
            publishDiagnostics: { relatedInformation: true, versionSupport: true },
          },
          workspace: { configuration: true, workspaceFolders: true },
        },
      },
      20_000,
    )) as { capabilities?: Record<string, unknown> };
    this.capabilities = result.capabilities ?? {};
    this.notify('initialized', {});
  }

  async diagnosticsFor(file: string): Promise<DiagnosticsSummary> {
    await this.start();
    const absolute = path.resolve(file);
    const uri = pathToFileURL(absolute).toString();
    const content = await readFile(absolute, 'utf8');
    const languageId = detectLanguageId(absolute);
    const version = (this.opened.get(uri) ?? 0) + 1;
    if (this.opened.has(uri)) {
      this.notify('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text: content }],
      });
    } else {
      this.notify('textDocument/didOpen', {
        textDocument: { uri, languageId, version, text: content },
      });
    }
    this.opened.set(uri, version);

    const canPull = Boolean((this.capabilities as { diagnosticProvider?: unknown }).diagnosticProvider);
    if (canPull) {
      try {
        const response = (await this.request('textDocument/diagnostic', { textDocument: { uri } }, 5000)) as {
          items?: DiagnosticItem[];
        };
        return toSummary(file, response.items ?? this.diagnostics.get(uri) ?? []);
      } catch {
        // Fall back to push diagnostics.
      }
    }

    await this.waitForDiagnostics(uri, 2500);
    return toSummary(file, this.diagnostics.get(uri) ?? []);
  }

  private waitForDiagnostics(uri: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        const current = this.diagnosticWaiters.get(uri);
        if (current) {
          const index = current.indexOf(done);
          if (index >= 0) current.splice(index, 1);
        }
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      const waiters = this.diagnosticWaiters.get(uri) ?? [];
      waiters.push(done);
      this.diagnosticWaiters.set(uri, waiters);
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
      if (!lengthMatch) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(lengthMatch[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) return;
      const body = this.buffer.subarray(start, start + length).toString('utf8');
      this.buffer = this.buffer.subarray(start + length);
      try {
        this.onMessage(JSON.parse(body) as Record<string, unknown>);
      } catch {
        // Ignore malformed messages rather than crashing the agent.
      }
    }
  }

  private onMessage(message: Record<string, unknown>): void {
    if (typeof message.id === 'number' && ('result' in message || 'error' in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error((message.error as { message?: string }).message ?? 'LSP request failed'));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === 'string' && message.id !== undefined) {
      this.handleServerRequest(message.id as number | string, message.method, message.params);
      return;
    }
    if (message.method === 'textDocument/publishDiagnostics') {
      const params = message.params as { uri?: string; diagnostics?: DiagnosticItem[] };
      if (params.uri) {
        this.diagnostics.set(params.uri, params.diagnostics ?? []);
        const waiters = this.diagnosticWaiters.get(params.uri) ?? [];
        for (const waiter of [...waiters]) waiter();
      }
    }
  }

  private handleServerRequest(id: number | string, method: string, params: unknown): void {
    let result: unknown = null;
    if (method === 'workspace/configuration') {
      const items = (params as { items?: unknown[] } | undefined)?.items ?? [];
      result = items.map(() => null);
    } else if (method === 'workspace/workspaceFolders') {
      result = [{ uri: pathToFileURL(this.root).toString(), name: path.basename(this.root) }];
    } else if (method === 'client/registerCapability' || method === 'client/unregisterCapability') {
      result = null;
    }
    this.write({ jsonrpc: '2.0', id, result });
  }

  private request(method: string, params: unknown, timeoutMs = 15_000): Promise<unknown> {
    if (!this.child) return Promise.reject(new MookaError('LSP_NOT_STARTED', 'LSP client is not started'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new MookaError('LSP_TIMEOUT', `LSP request ${method} timed out`, { retryable: false }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private write(message: unknown): void {
    if (!this.child?.stdin.writable) return;
    const body = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`;
    this.child.stdin.write(header + body);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async stop(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.child) return;
    try {
      await Promise.race([this.request('shutdown', null, 2000), new Promise((resolve) => setTimeout(resolve, 1500))]);
      this.notify('exit', null);
    } catch {
      // Server may already be gone.
    }
    const child = this.child;
    this.child = undefined;
    setTimeout(() => {
      if (!child.killed) child.kill();
    }, 500).unref();
  }

  scheduleIdleDispose(ms = 60_000): void {
    if (this.disposeTimer) clearTimeout(this.disposeTimer);
    this.disposeTimer = setTimeout(() => {
      void this.stop();
    }, ms);
    this.disposeTimer.unref();
  }

  cancelIdleDispose(): void {
    if (this.disposeTimer) clearTimeout(this.disposeTimer);
  }
}

function detectLanguageId(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescriptreact',
    '.js': 'javascript',
    '.jsx': 'javascriptreact',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.mts': 'typescript',
    '.cts': 'typescript',
    '.py': 'python',
    '.rs': 'rust',
    '.go': 'go',
    '.java': 'java',
    '.kt': 'kotlin',
    '.cs': 'csharp',
    '.cpp': 'cpp',
    '.c': 'c',
    '.rb': 'ruby',
    '.php': 'php',
  };
  return map[ext] ?? 'plaintext';
}

function toSummary(file: string, items: DiagnosticItem[]): DiagnosticsSummary {
  const severityMap: Record<number, 'error' | 'warning' | 'info' | 'hint'> = {
    1: 'error',
    2: 'warning',
    3: 'info',
    4: 'hint',
  };
  const messages = items.map((item) => ({
    severity: severityMap[item.severity ?? 1] ?? 'error',
    line: (item.range?.start?.line ?? 0) + 1,
    column: (item.range?.start?.character ?? 0) + 1,
    message: item.message ?? 'Unknown diagnostic',
    source: item.source,
  }));
  return {
    file,
    errors: messages.filter((item) => item.severity === 'error').length,
    warnings: messages.filter((item) => item.severity === 'warning').length,
    messages,
  };
}

export function lspErrorMessage(error: unknown): string {
  if (error instanceof CancelledError) return errorMessage(error);
  return errorMessage(error);
}
