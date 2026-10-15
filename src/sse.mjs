// Parse event streams across arbitrary TCP / UTF-8 boundaries, including CRLF.
export async function* parseSse(stream) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      yield frame;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield buffer;
}

export function decodeFrame(frame) {
  const lines = frame.split(/\r?\n/);
  const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
  if (!data || data === '[DONE]') return null;
  return JSON.parse(data);
}

export function encodeEvent(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export async function* translateSse(stream, translator, signal) {
  const blocks = new Map();
  for await (const raw of parseSse(stream)) {
    const event = decodeFrame(raw);
    if (!event) { yield `${raw}\n\n`; continue; }
    if (event.type === 'content_block_start' && event.content_block?.type === 'text') {
      blocks.set(event.index, event.content_block.text || '');
      yield encodeEvent({ ...event, content_block: { ...event.content_block, text: '' } });
    } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      if (!blocks.has(event.index)) throw new Error('Text delta without a text block');
      blocks.set(event.index, blocks.get(event.index) + event.delta.text);
    } else if (event.type === 'content_block_stop' && blocks.has(event.index)) {
      // Translate a complete block so code fences and multi-line sentences remain intact.
      const text = await translator.translate(blocks.get(event.index), 'zh', signal);
      blocks.delete(event.index);
      if (text) yield encodeEvent({ type: 'content_block_delta', index: event.index, delta: { type: 'text_delta', text } });
      yield `${raw}\n\n`;
    } else {
      // Thinking, signatures, tool input JSON, usage, errors and unknown events remain byte-exact.
      yield `${raw}\n\n`;
    }
  }
  if (blocks.size) throw new Error('Upstream stream ended before a text block completed');
}
