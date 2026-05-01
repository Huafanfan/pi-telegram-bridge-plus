import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { effectiveTopicConfig, isTopicUserAllowed, normalizeTopicConfig } from './topic-config.js';

describe('topic config helpers', () => {
  it('normalizes and merges group/topic config', () => {
    const cfg = normalizeTopicConfig({
      '-100': { requireMention: true, allowedUserIds: [1, '2'], topics: { '10': { requireMention: false, project: 'frontend', mentionPatterns: ['^bot'] } } },
    });
    const effective = effectiveTopicConfig(cfg, { id: -100, type: 'supergroup' }, 10);
    assert.equal(effective.requireMention, false);
    assert.equal(effective.project, 'frontend');
    assert.deepEqual(effective.allowedUserIds, [1, 2]);
    assert.equal(effective.mentionRegexes[0].test('bot do it'), true);
  });

  it('checks topic user allowlist only when configured', () => {
    assert.equal(isTopicUserAllowed({ allowedUserIds: [], mentionRegexes: [] }, 9), true);
    assert.equal(isTopicUserAllowed({ allowedUserIds: [1], mentionRegexes: [] }, 1), true);
    assert.equal(isTopicUserAllowed({ allowedUserIds: [1], mentionRegexes: [] }, 2), false);
  });
});
