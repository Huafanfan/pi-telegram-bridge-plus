export function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function truncateMiddle(input: string, maxLength: number): string {
  if (input.length <= maxLength) return input;
  const marker = '\n…[truncated]…\n';
  const keep = Math.max(0, maxLength - marker.length);
  const head = Math.ceil(keep * 0.65);
  const tail = Math.floor(keep * 0.35);
  return `${input.slice(0, head)}${marker}${input.slice(input.length - tail)}`;
}

function escapeHtmlAttr(input: string): string {
  return escapeHtml(input).replaceAll('"', '&quot;');
}

function renderInlineMarkdown(input: string): string {
  const placeholders: string[] = [];
  let text = input.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const token = `\u0000CODE${placeholders.length}\u0000`;
    placeholders.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });

  text = escapeHtml(text);
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label: string, url: string) => `<a href="${escapeHtmlAttr(url)}">${label}</a>`);
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  text = text.replace(/__([^_\n]+)__/g, '<b>$1</b>');
  text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<i>$1</i>');
  text = text.replace(/(?<!_)_([^_\n]+)_(?!_)/g, '<i>$1</i>');
  text = text.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');

  for (let i = 0; i < placeholders.length; i += 1) {
    text = text.replaceAll(`\u0000CODE${i}\u0000`, placeholders[i] ?? '');
  }
  return text;
}

export function markdownToTelegramHtml(input: string): string {
  const normalized = input.replace(/\r\n/g, '\n');
  const blocks = normalized.split(/(```[\s\S]*?```)/g);
  const out: string[] = [];

  for (const block of blocks) {
    if (!block) continue;
    if (block.startsWith('```') && block.endsWith('```')) {
      const body = block.slice(3, -3).replace(/^\w+\n/, '');
      out.push(`<pre><code>${escapeHtml(body.trim())}</code></pre>`);
      continue;
    }

    const lines = block.split('\n').map((line) => {
      if (/^#{1,6}\s+/.test(line)) {
        return `\u0000BOLDOPEN\u0000${renderInlineMarkdown(line.replace(/^#{1,6}\s+/, '').trim())}\u0000BOLDCLOSE\u0000`;
      }
      if (/^\s*[-*+]\s+/.test(line)) {
        return line.replace(/^(\s*)[-*+]\s+/, '$1• ');
      }
      if (/^\s*>\s?/.test(line)) {
        return line.replace(/^\s*>\s?/, '▌ ');
      }
      return line;
    });
    out.push(
      renderInlineMarkdown(lines.join('\n'))
        .replaceAll('\u0000BOLDOPEN\u0000', '<b>')
        .replaceAll('\u0000BOLDCLOSE\u0000', '</b>'),
    );
  }

  return out.join('').trim();
}

export function splitForTelegram(input: string, maxLength: number): string[] {
  if (input.length <= maxLength) return [input];
  const chunks: string[] = [];
  let rest = input;
  while (rest.length > maxLength) {
    let cut = rest.lastIndexOf('\n', maxLength);
    if (cut < maxLength * 0.5) cut = maxLength;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

export function formatToolArgs(args: unknown): string {
  if (args == null) return '';
  if (typeof args === 'string') return args;
  if (typeof args === 'object' && args !== null) {
    const maybe = args as Record<string, unknown>;
    if (typeof maybe.command === 'string') return maybe.command;
    if (typeof maybe.path === 'string') return maybe.path;
  }
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}
