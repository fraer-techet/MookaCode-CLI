import { z } from 'zod';
import type { AgentMode } from '@mookacode/protocol';
import type { ProviderTool } from '../providers/types';
import type { AnyToolDefinition, ToolContext } from './types';

export class ToolRegistry {
  private readonly tools = new Map<string, AnyToolDefinition>();
  private readonly jsonSchemaCache = new Map<string, Record<string, unknown>>();

  register(tool: AnyToolDefinition): void {
    if (this.tools.has(tool.name)) throw new Error(`Duplicate tool registration: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  registerMany(tools: AnyToolDefinition[]): void {
    for (const tool of tools) this.register(tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
    this.jsonSchemaCache.delete(name);
  }

  get(name: string): AnyToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(mode?: AgentMode): AnyToolDefinition[] {
    const tools = [...this.tools.values()];
    return mode ? tools.filter((tool) => tool.modes.includes(mode)) : tools;
  }

  providerTools(mode: AgentMode): ProviderTool[] {
    return this.list(mode).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: this.jsonSchema(tool),
    }));
  }

  private jsonSchema(tool: AnyToolDefinition): Record<string, unknown> {
    const cached = this.jsonSchemaCache.get(tool.name);
    if (cached) return cached;
    if (tool.parameters) {
      this.jsonSchemaCache.set(tool.name, tool.parameters);
      return tool.parameters;
    }
    const generated = z.toJSONSchema(tool.schema, {
      target: 'draft-7',
      io: 'input',
      unrepresentable: 'any',
    }) as Record<string, unknown>;
    delete generated.$schema;
    if (!generated.type) generated.type = 'object';
    this.jsonSchemaCache.set(tool.name, generated);
    return generated;
  }
}

export async function previewText(input: { content?: string; newString?: string }): Promise<string | undefined> {
  const value = input.content ?? input.newString;
  if (!value) return undefined;
  const lines = value.split('\n').slice(0, 30);
  return `${lines.join('\n')}${value.split('\n').length > 30 ? '\n…' : ''}`;
}

export function toolContextToolCount(ctx: ToolContext): number {
  void ctx;
  return 0;
}
