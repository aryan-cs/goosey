// Bounded SSE decoder and one connection. No serial/radio claims or fake cloud.
export async function* decodeSSE(body, { maxBytes = 65536 } = {}) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let line = '', data = [], kind = 'message', id, size = 0, skipLF = false;
  function consumeLine() {
    if (line === '') {
      const event = data.length ? { type: kind, id, data: data.join('\n') } : null;
      data = []; kind = 'message'; id = undefined; size = 0;
      return event;
    }
    if (!line.startsWith(':')) {
      const split = line.indexOf(':');
      const field = split < 0 ? line : line.slice(0, split);
      let value = split < 0 ? '' : line.slice(split + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') data.push(value);
      if (field === 'event') kind = value;
      if (field === 'id' && !value.includes('\0')) id = value;
    }
    return null;
  }
  for await (const bytes of body) {
    // Limit by decoded code units (and incoming bytes) to bound memory even
    // with huge lines or many data fields; only complete events are emitted.
    for (const char of decoder.decode(bytes, { stream: true })) {
      if (skipLF) { skipLF = false; if (char === '\n') continue; }
      size += new TextEncoder().encode(char).length;
      if (size > maxBytes) throw new Error('SSE event exceeds size limit');
      if (char === '\r' || char === '\n') {
        const event = consumeLine(); line = ''; skipLF = char === '\r';
        if (event) yield event;
      } else line += char;
    }
  }
  decoder.decode(); // Validate a truncated UTF-8 tail. Drop incomplete events.
}

export async function consumeConnection({ url, token, cursor = '', onEvent,
  onCursor = async () => {}, signal, fetchImpl = fetch }) {
  const endpoint = new URL(url);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new Error('SSE URL must not contain credentials, query or fragment');
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)))
    throw new Error('Use HTTPS (HTTP is allowed only on loopback)');
  if (!token || !/^[\x21-\x7e]+$/.test(token)) throw new Error('Missing or invalid gateway token');
  if (cursor && !/^[\x21-\x7e]{1,128}$/.test(cursor)) throw new Error('Invalid cursor');
  const headers = { Accept: 'text/event-stream', Authorization: `Bearer ${token}` };
  if (cursor) headers['Last-Event-ID'] = cursor;
  const response = await fetchImpl(endpoint, { headers, signal, redirect: 'error' });
  if (!response.ok) throw new Error(`SSE HTTP ${response.status}`);
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') || !response.body)
    throw new Error('Expected SSE response');
  let current = cursor;
  for await (const event of decodeSSE(response.body)) {
    if (!event.id || !/^[\x21-\x7e]{1,128}$/.test(event.id)) throw new Error('Missing or invalid event ID');
    // Snapshot application is the sink's responsibility. At-least-once delivery:
    // failed application/persistence never advances the acknowledged cursor.
    if (event.id === current) continue;
    const payload = JSON.parse(event.data);
    await onEvent({ id: event.id, type: event.type, payload });
    await onCursor(event.id);
    current = event.id;
  }
  return current;
}
