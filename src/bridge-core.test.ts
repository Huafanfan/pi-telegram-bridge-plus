import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBridgeCoreRuntime, getOrCreateCoreSession, handleCoreTextUpdate, restartCoreSession, type BridgeCoreConfig, type BridgeCorePolicy } from './bridge-core.js';

function policy(overrides: Partial<BridgeCorePolicy> = {}): BridgeCorePolicy {
  return {
    allowedChatIds: new Set(),
    allowedUserIds: new Set([1]),
    allowedGroupIds: new Set([-100]),
    ownerUserIds: new Set(),
    runtimeAllowedUserIds: new Set(),
    mentionPatterns: [],
    ...overrides,
  };
}

const config: BridgeCoreConfig = {
  pairingEnabled: true,
  groupRequireMention: true,
  workspaceRoot: '/workspace',
};

describe('bridge core process-level flow', () => {
  it('routes private chat text prompt to the correct session', () => {
    const runtime = createBridgeCoreRuntime(['mybot']);
    const result = handleCoreTextUpdate({
      runtime,
      policy: policy({ allowedUserIds: new Set([7]) }),
      config,
      update: { chat: { id: 7, type: 'private' }, from: { id: 7 }, message: { text: 'build it' } },
    });

    assert.equal(result.type, 'prompt');
    assert.equal(result.type === 'prompt' && result.session.key, 'telegram:chat:7');
    assert.equal(result.type === 'prompt' && result.text, 'build it');
    assert.deepEqual(result.type === 'prompt' && result.session.prompts, ['build it']);
  });

  it('keeps two private chats isolated', () => {
    const runtime = createBridgeCoreRuntime();
    const p = policy({ allowedUserIds: new Set([1, 2]) });
    handleCoreTextUpdate({ runtime, policy: p, config, update: { chat: { id: 1, type: 'private' }, from: { id: 1 }, message: { text: 'one' } } });
    handleCoreTextUpdate({ runtime, policy: p, config, update: { chat: { id: 2, type: 'private' }, from: { id: 2 }, message: { text: 'two' } } });

    assert.equal(runtime.sessions.size, 2);
    assert.deepEqual(runtime.sessions.get('telegram:chat:1')?.prompts, ['one']);
    assert.deepEqual(runtime.sessions.get('telegram:chat:2')?.prompts, ['two']);
  });

  it('ignores normal group chatter and accepts bot mentions', () => {
    const runtime = createBridgeCoreRuntime(['mybot']);
    const p = policy({ allowedGroupIds: new Set([-100]), allowedUserIds: new Set([1]) });

    const ignored = handleCoreTextUpdate({ runtime, policy: p, config, update: { chat: { id: -100, type: 'supergroup' }, from: { id: 1 }, message: { text: 'just chatting' } } });
    assert.deepEqual(ignored, { type: 'ignored', reason: 'gated' });
    assert.equal(runtime.sessions.size, 0);

    const accepted = handleCoreTextUpdate({ runtime, policy: p, config, update: { chat: { id: -100, type: 'supergroup' }, from: { id: 1 }, message: { text: '@mybot fix tests' } } });
    assert.equal(accepted.type, 'prompt');
    assert.equal(accepted.type === 'prompt' && accepted.session.key, 'telegram:group:-100');
    assert.equal(accepted.type === 'prompt' && accepted.text, 'fix tests');
  });

  it('isolates forum topics inside the same group', () => {
    const runtime = createBridgeCoreRuntime(['mybot']);
    const p = policy({ allowedGroupIds: new Set([-100]), allowedUserIds: new Set([1]) });
    handleCoreTextUpdate({ runtime, policy: p, config, update: { chat: { id: -100, type: 'supergroup' }, from: { id: 1 }, message: { message_thread_id: 10, text: '@mybot topic ten' } } });
    handleCoreTextUpdate({ runtime, policy: p, config, update: { chat: { id: -100, type: 'supergroup' }, from: { id: 1 }, message: { message_thread_id: 20, text: '@mybot topic twenty' } } });

    assert.deepEqual([...runtime.sessions.keys()].sort(), ['telegram:group:-100:topic:10', 'telegram:group:-100:topic:20']);
  });

  it('returns unauthorized with pairing hint and creates no session', () => {
    const runtime = createBridgeCoreRuntime();
    const result = handleCoreTextUpdate({
      runtime,
      policy: policy({ allowedUserIds: new Set([1]) }),
      config,
      update: { chat: { id: 9, type: 'private' }, from: { id: 9 }, message: { text: 'hi' } },
    });

    assert.equal(result.type, 'ignored');
    assert.equal(result.type === 'ignored' && result.reason, 'unauthorized');
    assert.match(result.type === 'ignored' ? result.message ?? '' : '', /\/pair/);
    assert.equal(runtime.sessions.size, 0);
  });

  it('reuses and restarts sessions like /new', () => {
    const runtime = createBridgeCoreRuntime();
    const session = getOrCreateCoreSession(runtime, { id: 1, type: 'private' }, {}, '/workspace');
    session.prompts.push('old');
    const same = getOrCreateCoreSession(runtime, { id: 1, type: 'private' }, {}, '/workspace');
    assert.equal(same, session);

    restartCoreSession(session);
    assert.equal(session.starts, 2);
    assert.equal(session.stops, 1);
    assert.deepEqual(session.prompts, []);
  });

  it('allows dynamically paired users without owner privileges', () => {
    const runtime = createBridgeCoreRuntime();
    const result = handleCoreTextUpdate({
      runtime,
      policy: policy({ allowedUserIds: new Set(), runtimeAllowedUserIds: new Set([42]) }),
      config,
      update: { chat: { id: 42, type: 'private' }, from: { id: 42 }, message: { text: 'paired prompt' } },
    });

    assert.equal(result.type, 'prompt');
    assert.equal(result.type === 'prompt' && result.session.key, 'telegram:chat:42');
  });
});
