const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(sk-ant-[A-Za-z0-9_-]{8,})/g, 'sk-ant-***'],
  [/\b(sk-proj-[A-Za-z0-9_-]{8,})/g, 'sk-proj-***'],
  [/\b(sk-[A-Za-z0-9_-]{16,})/g, 'sk-***'],
  [/\b(AIza[0-9A-Za-z_-]{20,})/g, 'AIza***'],
  [/\b(ghp_[A-Za-z0-9]{20,})/g, 'ghp_***'],
  [/\b(github_pat_[A-Za-z0-9_]{20,})/g, 'github_pat_***'],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1***'],
  [/([?&](?:api[_-]?key|token|access_token|key)=)[^&\s]{8,}/gi, '$1***'],
  [/((?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*["']?)[^"'\s,}]{8,}/gi, '$1***'],
];

const PEM_PATTERN =
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g;

export function redactSecrets(value: string): string {
  let result = value.replace(PEM_PATTERN, '-----BEGIN PRIVATE KEY-----***REDACTED***-----END PRIVATE KEY-----');
  for (const [pattern, replacement] of SECRET_PATTERNS) result = result.replace(pattern, replacement);
  return result;
}

export function redactObject<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactObject(item)) as T;
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/^(api[-_]?key|authorization|password|secret|token|access[-_]?token)$/i.test(key)) {
        result[key] = '***';
      } else {
        result[key] = redactObject(item);
      }
    }
    return result as T;
  }
  return value;
}
