import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import type { McpServerConfig, ToolResult } from '@mookacode/protocol';
import type { PermissionCategory } from '../permissions/engine';
import { MookaError, errorMessage } from '../util/errors';
import { redactSecrets } from '../util/redact';
import { defineTool, moderateRisk, safeRisk, type AnyToolDefinition } from '../tools/types';
import { MOOKACODE_VERSION } from '../version';

const MAX_TOOLS_TOTAL = 80;
const MAX_TOOLS_PER_SERVER = 30;

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
    idempotentHint?: boolean;
  };
}

interface McpConnection {
  config: McpServerConfig;
  client?: Client;
  transport?: Transport;
  tools: McpTool[];
  error?: string;
  stderr: string;
  connectedAt?: number;
}

export interface McpServerStatus {
  id: string;
  name: string;
  transport: string;
  enabled: boolean;
  connected: boolean;
  tools: number;
  error?: string;
}

function safeToolName(serverId: string, toolName: string): string {
  const server = serverId.replace(/[^A-Za-z0-9_]/g, '_');
  const tool = toolName.replace(/[^A-Za-z0-9_]/g, '_');
  return `mcp__${server}__${tool}`.slice(0, 64);
}

export class McpManager {
  private readonly configs: McpServerConfig[];
  private readonly connections = new Map<string, McpConnection>();
  private initialized = false;

  constructor(configs: McpServerConfig[]) {
    this.configs = configs.filter((config) => config.enabled !== false);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await Promise.allSettled(this.configs.map((config) => this.connect(config)));
  }

  private async connect(config: McpServerConfig): Promise<void> {
    const connection: McpConnection = { config, tools: [], stderr: '' };
    this.connections.set(config.id, connection);
    const timeoutMs = config.timeoutMs ?? 20_000;
    try {
      let transport: Transport;
      if (config.transport === 'stdio') {
        if (!config.command) throw new MookaError('MCP_CONFIG', `MCP server "${config.id}" is missing a command.`);
        transport = new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
          stderr: 'pipe',
          cwd: process.cwd(),
        });
        const stderr = (transport as StdioClientTransport).stderr;
        stderr?.on('data', (chunk: Buffer) => {
          if (connection.stderr.length < 4000) connection.stderr += chunk.toString('utf8');
        });
      } else if (config.transport === 'http') {
        if (!config.url) throw new MookaError('MCP_CONFIG', `MCP server "${config.id}" is missing a URL.`);
        transport = new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: { headers: config.headers ?? {} },
        });
      } else {
        if (!config.url) throw new MookaError('MCP_CONFIG', `MCP server "${config.id}" is missing a URL.`);
        transport = new SSEClientTransport(new URL(config.url), {
          requestInit: { headers: config.headers ?? {} },
        });
      }
      const client = new Client({ name: 'MookaCode', version: MOOKACODE_VERSION }, { capabilities: {} });
      await Promise.race([
        client.connect(transport),
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(new MookaError('MCP_TIMEOUT', `MCP server "${config.id}" did not initialize in ${timeoutMs}ms`)),
            timeoutMs,
          ).unref(),
        ),
      ]);
      connection.client = client;
      connection.transport = transport;
      connection.connectedAt = Date.now();
      await this.refreshTools(connection);
    } catch (error) {
      connection.error = redactSecrets(errorMessage(error));
      try {
        await connection.client?.close();
      } catch {
        // ignore
      }
    }
  }

  private async refreshTools(connection: McpConnection): Promise<void> {
    if (!connection.client) return;
    const result = await connection.client.listTools({}, { timeout: connection.config.timeoutMs ?? 15_000 });
    let tools = (result.tools ?? []) as McpTool[];
    if (connection.config.toolAllowlist?.length) {
      const allowed = new Set(connection.config.toolAllowlist);
      tools = tools.filter((tool) => allowed.has(tool.name));
    }
    connection.tools = tools.slice(0, MAX_TOOLS_PER_SERVER);
  }

  async refresh(): Promise<void> {
    for (const connection of this.connections.values()) {
      if (!connection.client) continue;
      try {
        await this.refreshTools(connection);
        connection.error = undefined;
      } catch (error) {
        connection.error = errorMessage(error);
      }
    }
  }

  toolDefinitions(): AnyToolDefinition[] {
    const definitions: AnyToolDefinition[] = [];
    for (const connection of this.connections.values()) {
      if (!connection.client) continue;
      if (definitions.length >= MAX_TOOLS_TOTAL) break;
      for (const tool of connection.tools) {
        if (definitions.length >= MAX_TOOLS_TOTAL) break;
        const name = safeToolName(connection.config.id, tool.name);
        const readOnly = tool.annotations?.readOnlyHint === true;
        const destructive = tool.annotations?.destructiveHint === true;
        const serverId = connection.config.id;
        const originalName = tool.name;
        definitions.push(
          defineTool({
            name,
            description: `[MCP:${connection.config.name || serverId}] ${tool.description || originalName}`.slice(
              0,
              1000,
            ),
            category: 'mcp' as PermissionCategory,
            modes: readOnly ? ['plan', 'build', 'debug', 'ask', 'review'] : ['build', 'debug'],
            schema: z.record(z.string(), z.unknown()),
            parameters: tool.inputSchema ?? { type: 'object', properties: {} },
            risk: () =>
              destructive
                ? { level: 'high' as const, reason: 'The MCP server marks this tool as destructive.' }
                : readOnly
                  ? safeRisk('The MCP server marks this tool as read-only.')
                  : moderateRisk('External MCP tool execution.'),
            title: () => `MCP ${serverId}: ${originalName}`,
            detail: () => `Call "${originalName}" on MCP server "${connection.config.name || serverId}".`,
            async execute(input, ctx): Promise<ToolResult> {
              if (ctx.signal?.aborted) throw new Error('Cancelled');
              const client = connection.client;
              if (!client) throw new MookaError('MCP_DISCONNECTED', `MCP server "${serverId}" is not connected.`);
              const result = await client.callTool(
                { name: originalName, arguments: input as Record<string, unknown> },
                undefined,
                { timeout: connection.config.timeoutMs ?? 60_000, signal: ctx.signal },
              );
              const content = renderMcpResult(result);
              return {
                ok: result.isError !== true,
                summary: result.isError
                  ? `MCP tool ${originalName} returned an error`
                  : `MCP tool ${originalName} completed`,
                content: redactSecrets(content),
                metadata: { server: serverId, tool: originalName },
              };
            },
          }),
        );
      }
    }
    return definitions;
  }

  statuses(): McpServerStatus[] {
    return this.configs.map((config) => {
      const connection = this.connections.get(config.id);
      return {
        id: config.id,
        name: config.name || config.id,
        transport: config.transport,
        enabled: config.enabled !== false,
        connected: Boolean(connection?.client),
        tools: connection?.tools.length ?? 0,
        error: connection?.error,
      };
    });
  }

  async call(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const connection = this.connections.get(serverId);
    if (!connection?.client) throw new MookaError('MCP_DISCONNECTED', `MCP server "${serverId}" is not connected.`);
    return connection.client.callTool({ name: toolName, arguments: args }, undefined, {
      timeout: connection.config.timeoutMs ?? 60_000,
      signal,
    });
  }

  async close(): Promise<void> {
    this.initialized = false;
    const connections = [...this.connections.values()];
    this.connections.clear();
    await Promise.allSettled(connections.map((connection) => connection.client?.close()));
  }
}

function renderMcpResult(result: Record<string, unknown>): string {
  const content = result.content;
  if (!Array.isArray(content)) {
    if (result.structuredContent) return JSON.stringify(result.structuredContent, null, 2);
    return JSON.stringify(result, null, 2);
  }
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const block = item as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image')
      parts.push(`[image ${String(block.mimeType ?? '')} returned by MCP; binary content omitted]`);
    else if (block.type === 'audio')
      parts.push(`[audio ${String(block.mimeType ?? '')} returned by MCP; binary content omitted]`);
    else if (block.type === 'resource_link')
      parts.push(`[resource] ${String(block.uri ?? '')} ${String(block.name ?? '')}`);
    else if (block.type === 'resource' && block.resource && typeof block.resource === 'object') {
      const resource = block.resource as Record<string, unknown>;
      if (typeof resource.text === 'string') parts.push(resource.text);
      else parts.push(`[resource ${String(resource.uri ?? '')} returned; binary content omitted]`);
    } else {
      parts.push(JSON.stringify(item));
    }
  }
  if (result.structuredContent)
    parts.push(`\nStructured content:\n${JSON.stringify(result.structuredContent, null, 2)}`);
  return parts.join('\n\n') || '(empty MCP result)';
}
