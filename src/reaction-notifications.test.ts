import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatReactionNote, prependSystemEvents, shouldRecordReaction } from './reaction-notifications.js';

describe('reaction notifications', () => {
  it('filters by mode', () => {
    assert.equal(shouldRecordReaction('off', { isOwnMessage: true }), false);
    assert.equal(shouldRecordReaction('own', { isOwnMessage: true }), true);
    assert.equal(shouldRecordReaction('own', { isOwnMessage: false }), false);
    assert.equal(shouldRecordReaction('all', { isOwnMessage: false }), true);
  });

  it('formats and prepends reaction notes', () => {
    const note = formatReactionNote({ emoji: '👍', username: 'alice', messageId: 7 });
    assert.equal(note, 'Telegram reaction added: 👍 by @alice on message 7.');
    assert.equal(prependSystemEvents('continue', [note]), `[Telegram context]\n- ${note}\n\nUser prompt:\ncontinue`);
  });
});
