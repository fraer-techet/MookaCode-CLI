export interface SseMessage {
  event?: string;
  data: string;
  id?: string;
}

export async function* parseSse(response: Response): AsyncGenerator<SseMessage> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const message = parseBlock(raw);
        if (message) yield message;
        boundary = buffer.indexOf('\n\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const message = parseBlock(buffer);
      if (message) yield message;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseBlock(raw: string): SseMessage | null {
  let event: string | undefined;
  let id: string | undefined;
  const data: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
  }
  if (data.length === 0) return null;
  return { event, data: data.join('\n'), id };
}

export async function readErrorBody(response: Response): Promise<string> {
  let text = '';
  try {
    text = await response.text();
  } catch {
    return response.statusText;
  }
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    if (typeof parsed.error === 'string') return parsed.error;
    if (parsed.error?.message) return parsed.error.message;
    if (parsed.message) return parsed.message;
  } catch {
    // plain text response
  }
  return text.slice(0, 2000) || response.statusText;
}
