import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { approvePairingRecord, createPairingCode, normalizePairingStore, prunePairingRecords, revokePairingUser } from './pairing.js';

describe('pairing helpers', () => {
  it('normalizes malformed stores safely', () => {
    assert.deepEqual(normalizePairingStore(null), { allowedUserIds: [], pending: [] });
    assert.deepEqual(normalizePairingStore({ allowedUserIds: [1, Number.NaN, 2], pending: [{ code: 'A', userId: 1, chatId: 1, expiresAt: 10 }, { nope: true }] }), {
      allowedUserIds: [1, 2],
      pending: [{ code: 'A', userId: 1, chatId: 1, expiresAt: 10 }],
    });
  });

  it('prunes expired records', () => {
    assert.deepEqual(prunePairingRecords([
      { code: 'OLD', userId: 1, chatId: 1, createdAt: 0, expiresAt: 10 },
      { code: 'NEW', userId: 2, chatId: 2, createdAt: 0, expiresAt: 30 },
    ], 20).map((item) => item.code), ['NEW']);
  });

  it('generates unique-looking codes outside existing set', () => {
    const code = createPairingCode(new Set());
    assert.match(code, /^[0-9A-F]{8}$/);
  });

  it('approves and revokes paired users', () => {
    const store = approvePairingRecord({ allowedUserIds: [3], pending: [{ code: 'ABC', userId: 5, chatId: 5, createdAt: 0, expiresAt: 99 }] }, { code: 'ABC', userId: 5, chatId: 5, createdAt: 0, expiresAt: 99 });
    assert.deepEqual(store, { allowedUserIds: [3, 5], pending: [] });
    const revoked = revokePairingUser(store, 5);
    assert.equal(revoked.revoked, true);
    assert.deepEqual(revoked.store.allowedUserIds, [3]);
  });
});
