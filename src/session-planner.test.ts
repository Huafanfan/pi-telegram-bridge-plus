import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planSession } from './session-planner.js';

describe('session planning', () => {
  it('keeps private chats isolated by chat id', () => {
    assert.deepEqual(planSession({ id: 11, type: 'private' }), {
      key: 'telegram:chat:11',
      chatId: 11,
      chatType: 'private',
      threadId: undefined,
    });
    assert.deepEqual(planSession({ id: 22, type: 'private' }).key, 'telegram:chat:22');
  });

  it('keeps group topics isolated by thread id', () => {
    assert.deepEqual(planSession({ id: -100, type: 'supergroup' }, { message_thread_id: 55 }), {
      key: 'telegram:group:-100:topic:55',
      chatId: -100,
      chatType: 'supergroup',
      threadId: 55,
    });
    assert.equal(planSession({ id: -100, type: 'supergroup' }, { message_thread_id: 77 }).key, 'telegram:group:-100:topic:77');
  });

  it('uses group chat key when there is no topic id', () => {
    assert.equal(planSession({ id: -100, type: 'group' }).key, 'telegram:group:-100');
  });
});
