import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { escapeHtml, formatToolArgs, markdownToTelegramHtml, splitForTelegram, truncateMiddle } from './telegram-format.js';

describe('telegram formatting helpers', () => {
  it('escapes Telegram HTML-sensitive characters', () => {
    assert.equal(escapeHtml('<tag a="1">A & B</tag>'), '&lt;tag a="1"&gt;A &amp; B&lt;/tag&gt;');
  });

  it('truncates long text while preserving head and tail', () => {
    const input = `${'a'.repeat(80)}-${'z'.repeat(80)}`;
    const output = truncateMiddle(input, 50);
    assert.ok(output.length <= 50);
    assert.ok(output.includes('[truncated]'));
    assert.ok(output.startsWith('a'));
    assert.ok(output.endsWith('z'));
  });

  it('does not truncate short text', () => {
    assert.equal(truncateMiddle('short', 10), 'short');
  });

  it('splits Telegram messages by newlines when practical', () => {
    const chunks = splitForTelegram('one\ntwo\nthree\nfour', 9);
    assert.deepEqual(chunks, ['one\ntwo', 'three', 'four']);
    assert.ok(chunks.every((chunk) => chunk.length <= 9));
  });

  it('hard-splits very long lines', () => {
    const chunks = splitForTelegram('abcdefghij', 4);
    assert.deepEqual(chunks, ['abcd', 'efgh', 'ij']);
  });

  it('converts common markdown to Telegram HTML', () => {
    const input = ['# Title', '', '- **bold** and _italic_', '- `code`', '', '[link](https://example.com?a=1&b=2)', '', '```ts', 'const x = 1 < 2;', '```'].join('\n');
    const output = markdownToTelegramHtml(input);
    assert.ok(output.includes('<b>Title</b>'));
    assert.ok(output.includes('• <b>bold</b> and <i>italic</i>'));
    assert.ok(output.includes('• <code>code</code>'));
    assert.ok(output.includes('href="https://example.com?a=1&amp;amp;b=2"'));
    assert.ok(output.includes('<pre><code>const x = 1 &lt; 2;</code></pre>'));
    assert.doesNotMatch(output, /&lt;b&gt;Title/);
  });

  it('formats common tool arguments compactly', () => {
    assert.equal(formatToolArgs({ command: 'npm test', other: true }), 'npm test');
    assert.equal(formatToolArgs({ path: 'src/index.ts' }), 'src/index.ts');
    assert.equal(formatToolArgs({ value: 1 }), '{"value":1}');
    assert.equal(formatToolArgs(null), '');
  });
});
