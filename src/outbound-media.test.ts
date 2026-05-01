import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { extractMediaMarkers, mediaKindForPath, resolveOutboundMediaFiles, stripMediaMarkers } from './outbound-media.js';

describe('outbound media helpers', () => {
  it('extracts and deduplicates MEDIA markers', () => {
    const text = 'hello\nMEDIA:/tmp/a.png\nagain\nMEDIA:/tmp/a.png\nMEDIA: /tmp/b.txt';
    assert.deepEqual(extractMediaMarkers(text), ['/tmp/a.png', '/tmp/b.txt']);
  });

  it('strips MEDIA markers from visible text', () => {
    assert.equal(stripMediaMarkers('hello\nMEDIA:/tmp/a.png\n\nworld'), 'hello\n\nworld');
  });

  it('classifies common media extensions', () => {
    assert.equal(mediaKindForPath('/tmp/a.png'), 'photo');
    assert.equal(mediaKindForPath('/tmp/a.ogg'), 'voice');
    assert.equal(mediaKindForPath('/tmp/a.mp3'), 'audio');
    assert.equal(mediaKindForPath('/tmp/a.mp4'), 'video');
    assert.equal(mediaKindForPath('/tmp/a.zip'), 'document');
  });

  it('resolves allowed files under workspace root', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pi-bridge-media-'));
    try {
      const file = path.join(root, 'report.txt');
      writeFileSync(file, 'report');
      const result = resolveOutboundMediaFiles({ text: `MEDIA:${file}`, workspaceRoot: root, maxBytes: 100 });
      assert.deepEqual(result.errors, []);
      assert.equal(result.files.length, 1);
      assert.equal(result.files[0]?.path, file);
      assert.equal(result.files[0]?.kind, 'document');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects relative, missing, directory, outside-root, and oversized files', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pi-bridge-media-'));
    const outside = mkdtempSync(path.join(tmpdir(), 'pi-bridge-outside-'));
    try {
      const outsideFile = path.join(outside, 'secret.txt');
      const largeFile = path.join(root, 'large.txt');
      const dir = path.join(root, 'dir');
      writeFileSync(outsideFile, 'secret');
      writeFileSync(largeFile, 'too large');
      mkdirSync(dir);
      const result = resolveOutboundMediaFiles({
        text: [`MEDIA:relative.txt`, `MEDIA:${path.join(root, 'missing.txt')}`, `MEDIA:${dir}`, `MEDIA:${outsideFile}`, `MEDIA:${largeFile}`].join('\n'),
        workspaceRoot: root,
        maxBytes: 2,
      });
      assert.equal(result.files.length, 0);
      assert.equal(result.errors.length, 5);
      assert.ok(result.errors.some((line) => line.includes('must be absolute')));
      assert.ok(result.errors.some((line) => line.includes('does not exist')));
      assert.ok(result.errors.some((line) => line.includes('not a file')));
      assert.ok(result.errors.some((line) => line.includes('outside allowed roots')));
      assert.ok(result.errors.some((line) => line.includes('too large')));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
