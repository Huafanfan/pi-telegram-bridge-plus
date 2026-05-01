import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { imageMimeForTelegramPhoto, imageMimeFromExtension, imageMimeFromMagic, normalizeMimeType } from './mime.js';

describe('mime helpers', () => {
  it('normalizes content-type headers', () => {
    assert.equal(normalizeMimeType('Image/JPEG; charset=binary'), 'image/jpeg');
    assert.equal(normalizeMimeType(null), '');
  });

  it('detects image mime from extension', () => {
    assert.equal(imageMimeFromExtension('photos/file_123.jpg'), 'image/jpeg');
    assert.equal(imageMimeFromExtension('photos/file_123.PNG'), 'image/png');
    assert.equal(imageMimeFromExtension('photos/file_123.bin'), undefined);
  });

  it('detects image mime from magic bytes', () => {
    assert.equal(imageMimeFromMagic(Buffer.from([0xff, 0xd8, 0xff, 0x00])), 'image/jpeg');
    assert.equal(imageMimeFromMagic(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
    assert.equal(imageMimeFromMagic(Buffer.from('GIF89a', 'ascii')), 'image/gif');
    assert.equal(imageMimeFromMagic(Buffer.from('RIFFxxxxWEBP', 'ascii')), 'image/webp');
  });

  it('prefers real image headers but fixes octet-stream Telegram photos', () => {
    assert.equal(imageMimeForTelegramPhoto({ headerMime: 'image/webp', filePath: 'x.jpg', data: Buffer.alloc(0) }), 'image/webp');
    assert.equal(imageMimeForTelegramPhoto({ headerMime: 'application/octet-stream', filePath: 'photos/file_1.jpg', data: Buffer.alloc(0) }), 'image/jpeg');
    assert.equal(imageMimeForTelegramPhoto({ headerMime: 'application/octet-stream', filePath: undefined, data: Buffer.from([0xff, 0xd8, 0xff]) }), 'image/jpeg');
    assert.equal(imageMimeForTelegramPhoto({ headerMime: 'application/octet-stream', filePath: undefined, data: Buffer.alloc(0) }), 'image/jpeg');
  });
});
