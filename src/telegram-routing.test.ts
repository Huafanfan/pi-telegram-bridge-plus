import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isAllowed,
  isOwnerUser,
  messageThreadId,
  sessionKeyFor,
  shouldProcessText,
  stripBotMention,
  threadParams,
  type AccessPolicy,
} from './telegram-routing.js';

function policy(overrides: Partial<AccessPolicy> = {}): AccessPolicy {
  return {
    allowedChatIds: new Set(),
    allowedUserIds: new Set(),
    allowedGroupIds: new Set(),
    ownerUserIds: new Set(),
    ...overrides,
  };
}

describe('telegram routing helpers', () => {
  it('derives stable session keys', () => {
    assert.equal(sessionKeyFor(1, false), 'telegram:chat:1');
    assert.equal(sessionKeyFor(1, false, 7), 'telegram:chat:1:topic:7');
    assert.equal(sessionKeyFor(-100, true), 'telegram:group:-100');
    assert.equal(sessionKeyFor(-100, true, 9), 'telegram:group:-100:topic:9');
  });

  it('extracts and formats topic thread params', () => {
    assert.equal(messageThreadId({ message_thread_id: 3 }), 3);
    assert.equal(messageThreadId({ message_thread_id: '3' }), undefined);
    assert.deepEqual(threadParams(undefined), {});
    assert.deepEqual(threadParams(1), {});
    assert.deepEqual(threadParams(2), { message_thread_id: 2 });
  });

  it('allows legacy private chat ids and treats them as owners', () => {
    const p = policy({ allowedChatIds: new Set([123]) });
    assert.equal(isAllowed(p, { id: 123, type: 'private' }, 123), true);
    assert.equal(isOwnerUser(p, 123), true);
  });

  it('requires allowed users inside allowed groups when user allowlists exist', () => {
    const p = policy({ allowedGroupIds: new Set([-100]), allowedUserIds: new Set([7]) });
    assert.equal(isAllowed(p, { id: -100, type: 'supergroup' }, 7), true);
    assert.equal(isAllowed(p, { id: -100, type: 'supergroup' }, 8), false);
    assert.equal(isAllowed(p, { id: -200, type: 'supergroup' }, 7), false);
  });

  it('permits all users in an allowed group when no user/owner allowlist exists', () => {
    const p = policy({ allowedGroupIds: new Set([-100]) });
    assert.equal(isAllowed(p, { id: -100, type: 'group' }, 999), true);
  });

  it('strips bot mentions case-insensitively', () => {
    assert.equal(stripBotMention('hi @MyBot please', new Set(['mybot'])), 'hi  please');
  });

  it('gates group messages by slash, mention, reply, or wake regex', () => {
    const chat = { id: -100, type: 'supergroup' };
    const botUsernames = new Set(['mybot']);
    assert.equal(shouldProcessText({ chat, text: 'normal chatter', requireMention: true, botUsernames, mentionPatterns: [] }), false);
    assert.equal(shouldProcessText({ chat, text: '/status', requireMention: true, botUsernames, mentionPatterns: [] }), true);
    assert.equal(shouldProcessText({ chat, text: 'hi @mybot', requireMention: true, botUsernames, mentionPatterns: [] }), true);
    assert.equal(
      shouldProcessText({ chat, message: { reply_to_message: { from: { username: 'MyBot' } } }, text: 'reply', requireMention: true, botUsernames, mentionPatterns: [] }),
      true,
    );
    assert.equal(shouldProcessText({ chat, text: 'pi do it', requireMention: true, botUsernames, mentionPatterns: [/^pi\b/i] }), true);
  });

  it('always processes private chats and non-required group mentions', () => {
    assert.equal(shouldProcessText({ chat: { id: 1, type: 'private' }, text: 'hello', requireMention: true, botUsernames: new Set(), mentionPatterns: [] }), true);
    assert.equal(shouldProcessText({ chat: { id: -1, type: 'group' }, text: 'hello', requireMention: false, botUsernames: new Set(), mentionPatterns: [] }), true);
  });
});
