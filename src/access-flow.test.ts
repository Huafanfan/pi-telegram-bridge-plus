import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { accessDecision, isRuntimeAllowed, isRuntimeOwner, type RuntimeAccessPolicy } from './access-flow.js';

function policy(overrides: Partial<RuntimeAccessPolicy> = {}): RuntimeAccessPolicy {
  return {
    allowedChatIds: new Set(),
    allowedUserIds: new Set(),
    allowedGroupIds: new Set(),
    ownerUserIds: new Set(),
    runtimeAllowedUserIds: new Set(),
    ...overrides,
  };
}

describe('access flow helpers', () => {
  it('allows dynamically paired users in private chats', () => {
    const p = policy({ runtimeAllowedUserIds: new Set([42]) });
    assert.equal(isRuntimeAllowed(p, { id: 42, type: 'private' }, 42), true);
  });

  it('does not treat dynamically paired users as owners', () => {
    const p = policy({ runtimeAllowedUserIds: new Set([42]) });
    assert.equal(isRuntimeOwner(p, 42), false);
  });

  it('includes pairing hint only when enabled', () => {
    const p = policy();
    assert.deepEqual(accessDecision(p, { id: 1, type: 'private' }, 1, false), {
      allowed: false,
      reason: 'not_allowed',
      canRequestPairing: false,
      message: 'This chat/user is not allowed to control this bridge.',
    });
    assert.deepEqual(accessDecision(p, { id: 1, type: 'private' }, 1, true), {
      allowed: false,
      reason: 'not_allowed',
      canRequestPairing: true,
      message: 'This chat/user is not allowed to control this bridge. Send /pair to request access.',
    });
  });

  it('allows configured group/user combination', () => {
    const p = policy({ allowedGroupIds: new Set([-100]), allowedUserIds: new Set([7]) });
    assert.deepEqual(accessDecision(p, { id: -100, type: 'supergroup' }, 7, true), { allowed: true });
    assert.equal(accessDecision(p, { id: -100, type: 'supergroup' }, 8, true).allowed, false);
  });
});
