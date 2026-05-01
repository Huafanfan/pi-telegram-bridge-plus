import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { isTextDocumentExtension, mediaSavedPrompt, saveTelegramMediaFile } from './media-input.js';

describe('media input helpers', () => {
  it('recognizes expanded text document types', () => {
    assert.equal(isTextDocumentExtension('.sql'), true);
    assert.equal(isTextDocumentExtension('.tsx'), true);
    assert.equal(isTextDocumentExtension('.pdf'), false);
  });

  it('saves Telegram media under workspace root with safe names', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-input-'));
    const file = await saveTelegramMediaFile({ data: Buffer.from('hello'), workspaceRoot: root, fileName: '../bad name?.mp4' });
    assert.equal(path.relative(root, file).startsWith('..'), false);
    assert.equal(fs.readFileSync(file, 'utf8'), 'hello');
  });

  it('formats saved media prompts', () => {
    assert.match(mediaSavedPrompt('video file', '/tmp/a.mp4', 'watch this'), /watch this/);
  });
});
