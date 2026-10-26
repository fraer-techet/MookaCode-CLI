import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'MookaCode Test MCP', version: '1.0.0' }, { capabilities: { tools: {} } });

server.registerTool(
  'echo',
  {
    title: 'Echo',
    description: 'Echo a text value back to the caller',
    inputSchema: { text: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ text }) => ({
    content: [{ type: 'text', text: `echo:${text}` }],
  }),
);

server.registerTool(
  'write_note',
  {
    title: 'Write note',
    description: 'A mutating mock tool',
    inputSchema: { value: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({ value }) => ({
    content: [{ type: 'text', text: `noted:${value}` }],
  }),
);

await server.connect(new StdioServerTransport());
