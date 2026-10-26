import { z } from 'zod';
import type { DiagnosticsSummary, ToolResult } from '@mookacode/protocol';
import { defineTool, safeRisk } from './types';

const diagnosticsSchema = z.object({
  paths: z.array(z.string()).min(1).max(50).describe('Files to check with the configured language server'),
  timeoutMs: z.number().int().min(1000).max(60_000).optional(),
});

export const diagnosticsTool = defineTool({
  name: 'diagnostics',
  description:
    'Run the configured language server (LSP) and return errors, warnings and hints for specific files. Requires a language server installed on this machine.',
  category: 'read',
  modes: ['plan', 'build', 'debug', 'ask', 'review'],
  schema: diagnosticsSchema,
  risk: () => safeRisk('Starts a language server and reads diagnostics.'),
  title: (input) => `Diagnostics for ${input.paths.length} file(s)`,
  detail: (input) => `Check ${input.paths.join(', ')} via LSP.`,
  paths: (input) => input.paths,
  async execute(input, ctx): Promise<ToolResult> {
    if (ctx.signal?.aborted) throw new Error('Cancelled');
    const summaries: DiagnosticsSummary[] = [];
    for (const file of input.paths) {
      const target = await ctx.guard.resolve(file, { mustExist: true });
      summaries.push(await ctx.lsp.diagnostics(target));
    }
    const totalErrors = summaries.reduce((sum, item) => sum + item.errors, 0);
    const totalWarnings = summaries.reduce((sum, item) => sum + item.warnings, 0);
    const lines: string[] = [];
    for (const summary of summaries) {
      lines.push(`${summary.file}: ${summary.errors} error(s), ${summary.warnings} warning(s)`);
      for (const message of summary.messages.slice(0, 100)) {
        lines.push(
          `  ${message.severity.toUpperCase()} ${message.line}:${message.column} ${message.message}${message.source ? ` [${message.source}]` : ''}`,
        );
      }
      if (summary.messages.length > 100) lines.push(`  … ${summary.messages.length - 100} more`);
    }
    return {
      ok: totalErrors === 0,
      summary:
        totalErrors > 0
          ? `${totalErrors} error(s), ${totalWarnings} warning(s)`
          : `${totalWarnings} warning(s), no errors`,
      content: lines.join('\n'),
      metadata: { summaries },
    };
  },
});
