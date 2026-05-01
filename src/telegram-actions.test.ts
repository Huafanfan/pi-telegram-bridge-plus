import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parseTelegramActions, resolveTelegramActionFile } from './telegram-actions.js';

describe('telegram actions', () => {
  it('parses fenced telegram-action blocks and strips them from visible text', () => {
    const parsed = parseTelegramActions('hello\n```telegram-action\n{"type":"send_message","text":"side"}\n```\nworld');
    assert.equal(parsed.visibleText, 'hello\n\nworld');
    assert.deepEqual(parsed.actions, [{ type: 'send_message', text: 'side' }]);
    assert.deepEqual(parsed.errors, []);
  });

  it('reports malformed action JSON', () => {
    const parsed = parseTelegramActions('```telegram-action\n{bad}\n```');
    assert.equal(parsed.actions.length, 0);
    assert.equal(parsed.errors.length, 1);
  });

  it('resolves action files inside workspace only', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-action-'));
    const file = path.join(root, 'a.txt');
    fs.writeFileSync(file, 'x');
    assert.equal(resolveTelegramActionFile({ type: 'send_document', path: file }, root, 100).file?.path, file);
    assert.match(resolveTelegramActionFile({ type: 'send_document', path: '/etc/passwd' }, root, 100).error ?? '', /outside allowed roots|does not exist/);
  });
});
