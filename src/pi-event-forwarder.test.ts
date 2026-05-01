import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { escapeHtml, truncateMiddle } from './telegram-format.js';
import { forwardPiError, forwardPiEvent, forwardPiExit, forwardPiStderr, type PiForwardConfig, type PiForwardDeps, type PiForwardSession } from './pi-event-forwarder.js';

function session(): PiForwardSession {
  return {
    pendingText: '',
    previewLastText: '',
    lastAssistantFinal: '',
    lastToolUpdateAt: 0,
    isStreaming: false,
  };
}

function harness(overrides: Partial<PiForwardConfig> = {}) {
  const sent: string[] = [];
  let typing = false;
  let flushed = 0;
  let final = 0;
  const config: PiForwardConfig = { verboseEvents: false, toolUpdateThrottleMs: 1000, shuttingDown: () => false, ...overrides };
  const deps: PiForwardDeps = {
    send: (html) => {
      sent.push(html);
    },
    flushText: () => {
      flushed += 1;
    },
    handleAssistantFinal: () => {
      final += 1;
    },
    startTyping: () => {
      typing = true;
    },
    stopTyping: () => {
      typing = false;
    },
    formatToolArgs: (value) => JSON.stringify(value),
    escapeHtml,
    truncateMiddle,
    projectLabel: () => 'demo',
    now: () => 5000,
  };
  return { sent, config, deps, get typing() { return typing; }, get flushed() { return flushed; }, get final() { return final; } };
}

describe('pi event forwarder', () => {
  it('starts and ends streaming state', async () => {
    const s = session();
    const h = harness({ verboseEvents: true });
    assert.equal(await forwardPiEvent(s, { type: 'agent_start' }, h.config, h.deps), 'agent_start');
    assert.equal(s.isStreaming, true);
    assert.equal(h.typing, true);
    assert.match(h.sent[0], /pi started/);

    s.pendingText = 'partial';
    assert.equal(await forwardPiEvent(s, { type: 'agent_end' }, h.config, h.deps), 'agent_end');
    assert.equal(s.isStreaming, false);
    assert.equal(h.typing, false);
    assert.equal(h.flushed, 1);
    assert.equal(h.final, 1);
    assert.equal(s.previewMessageId, undefined);
    assert.equal(s.previewLastText, '');
    assert.match(h.sent.at(-1) ?? '', /pi finished/);
  });

  it('accumulates text deltas and ignores final duplicate event types', async () => {
    const s = session();
    const h = harness();
    assert.equal(await forwardPiEvent(s, { type: 'message_delta', text: 'hello' }, h.config, h.deps), 'delta');
    assert.equal(await forwardPiEvent(s, { type: 'text_delta', delta: ' world' }, h.config, h.deps), 'delta');
    assert.equal(s.pendingText, 'hello world');
    assert.equal(await forwardPiEvent(s, { type: 'message_end' }, h.config, h.deps), 'ignored');
    assert.equal(await forwardPiEvent(s, { type: 'turn_end' }, h.config, h.deps), 'ignored');
  });

  it('throttles verbose tool start and sends tool errors', async () => {
    const s = session();
    const h = harness({ verboseEvents: true, toolUpdateThrottleMs: 1000 });
    s.lastToolUpdateAt = 4500;
    assert.equal(await forwardPiEvent(s, { type: 'tool_execution_start', toolName: 'bash', args: { command: 'ls' } }, h.config, h.deps), 'ignored');
    s.lastToolUpdateAt = 0;
    assert.equal(await forwardPiEvent(s, { type: 'tool_execution_start', toolName: 'bash', args: { command: 'ls' } }, h.config, h.deps), 'tool_start');
    assert.match(h.sent.at(-1) ?? '', /bash/);

    assert.equal(await forwardPiEvent(s, { type: 'tool_execution_end', isError: true, toolName: 'edit', result: 'failed' }, h.config, h.deps), 'tool_error');
    assert.match(h.sent.at(-1) ?? '', /edit failed/);
  });

  it('records stderr and only sends it in verbose mode', async () => {
    const s = session();
    const quiet = harness({ verboseEvents: false });
    assert.equal(await forwardPiStderr(s, ' warning ', quiet.config, quiet.deps), 'stderr');
    assert.equal(s.lastError, 'warning');
    assert.deepEqual(quiet.sent, []);

    const verbose = harness({ verboseEvents: true });
    assert.equal(await forwardPiStderr(s, ' boom ', verbose.config, verbose.deps), 'stderr');
    assert.match(verbose.sent[0], /pi stderr/);
  });

  it('notifies on pi exit during run unless shutting down', async () => {
    const s = session();
    s.isStreaming = true;
    const h = harness();
    assert.equal(await forwardPiExit(s, { code: 1, signal: null }, h.config, h.deps), 'exit');
    assert.equal(s.isStreaming, false);
    assert.equal(h.typing, false);
    assert.equal(s.lastError, 'pi RPC exited: {"code":1,"signal":null}');
    assert.match(h.sent[0], /pi RPC exited/);

    const quiet = harness({ shuttingDown: () => true });
    assert.equal(await forwardPiExit(session(), { code: 0 }, quiet.config, quiet.deps), 'exit');
    assert.deepEqual(quiet.sent, []);
  });

  it('records pi client errors', () => {
    const s = session();
    assert.equal(forwardPiError(s, new Error('kaput')), 'error');
    assert.equal(s.lastError, 'kaput');
  });
});
