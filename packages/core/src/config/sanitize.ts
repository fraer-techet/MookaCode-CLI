import type { MookaConfig } from '@mookacode/protocol';
import { redactSecrets } from '../util/redact';

export function sanitizeConfigForExport(config: MookaConfig): MookaConfig {
  const copy = structuredClone(config);
  for (const provider of copy.providers) {
    if (provider.headers) {
      for (const key of Object.keys(provider.headers)) provider.headers[key] = '***';
    }
  }
  for (const server of copy.mcpServers) {
    if (server.headers) {
      for (const key of Object.keys(server.headers)) server.headers[key] = '***';
    }
    if (server.env) {
      for (const key of Object.keys(server.env)) server.env[key] = '***';
    }
    if (server.args) server.args = server.args.map((arg) => redactSecrets(arg));
  }
  return copy;
}
