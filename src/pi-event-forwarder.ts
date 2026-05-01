export type PiForwardSession = {
  pendingText: string;
  previewMessageId?: number;
  previewLastText: string;
  lastAssistantFinal: string;
  lastToolUpdateAt: number;
  isStreaming: boolean;
  lastError?: string;
};

export type PiForwardConfig = {
  verboseEvents: boolean;
  toolUpdateThrottleMs: number;
  shuttingDown: () => boolean;
};

export type PiForwardDeps = {
  send: (html: string) => Promise<void> | void;
  flushText: () => Promise<void> | void;
  handleAssistantFinal: (event: Record<string, unknown>) => Promise<void> | void;
  startTyping: () => void;
  stopTyping: () => void;
  formatToolArgs: (value: unknown) => string;
  escapeHtml: (value: string) => string;
  truncateMiddle: (value: string, max: number) => string;
  controls?: () => unknown;
  projectLabel?: () => string;
  now?: () => number;
};

export type PiEventForwardAction = 'ignored' | 'agent_start' | 'agent_end' | 'tool_start' | 'tool_error' | 'delta' | 'stderr' | 'exit' | 'error';

export function eventType(event: Record<string, unknown>): string {
  return (typeof event.type === 'string' ? event.type : typeof event.event === 'string' ? event.event : '') || 'unknown';
}

function assistantTextDelta(event: Record<string, unknown>): string {
  const delta = event.delta;
  if (typeof delta === 'string') return delta;
  const text = event.text;
  return typeof text === 'string' && (eventType(event) === 'message_delta' || eventType(event) === 'text_delta') ? text : '';
}

export async function forwardPiEvent(session: PiForwardSession, event: Record<string, unknown>, config: PiForwardConfig, deps: PiForwardDeps): Promise<PiEventForwardAction> {
  const type = eventType(event);
  if (type === 'message_end' || type === 'turn_end') return 'ignored';

  if (type === 'agent_start') {
    session.isStreaming = true;
    deps.startTyping();
    if (config.verboseEvents) {
      const project = deps.projectLabel?.() ?? '';
      await deps.send(`🚀 <b>pi started</b>${project ? `\nProject: <code>${deps.escapeHtml(project)}</code>` : ''}`);
    }
    return 'agent_start';
  }

  if (type === 'agent_end') {
    await deps.handleAssistantFinal(event);
    deps.stopTyping();
    session.isStreaming = false;
    if (session.pendingText.trim()) {
      await deps.flushText();
    }
    session.previewMessageId = undefined;
    session.previewLastText = '';
    if (config.verboseEvents) await deps.send('✅ <b>pi finished</b>');
    return 'agent_end';
  }

  if (type === 'tool_execution_start') {
    if (config.verboseEvents) {
      const now = deps.now?.() ?? Date.now();
      if (now - session.lastToolUpdateAt < config.toolUpdateThrottleMs) return 'ignored';
      session.lastToolUpdateAt = now;
      const toolName = typeof event.toolName === 'string' ? event.toolName : 'tool';
      const details = deps.truncateMiddle(deps.formatToolArgs(event.args), 700);
      await deps.send(`🔧 <b>${deps.escapeHtml(toolName)}</b>${details ? `\n<code>${deps.escapeHtml(details)}</code>` : ''}`);
    }
    return 'tool_start';
  }

  if (type === 'tool_execution_end' && event.isError === true) {
    const toolName = typeof event.toolName === 'string' ? event.toolName : 'tool';
    const result = deps.truncateMiddle(deps.formatToolArgs(event.result), 1000);
    await deps.send(`❌ <b>${deps.escapeHtml(toolName)} failed</b>${result ? `\n<code>${deps.escapeHtml(result)}</code>` : ''}`);
    return 'tool_error';
  }

  const delta = assistantTextDelta(event);
  if (delta) {
    session.pendingText += delta;
    return 'delta';
  }

  return 'ignored';
}

export async function forwardPiStderr(session: PiForwardSession, text: string, config: PiForwardConfig, deps: PiForwardDeps): Promise<PiEventForwardAction> {
  const trimmed = text.trim();
  if (!trimmed) return 'ignored';
  session.lastError = trimmed;
  if (config.verboseEvents) await deps.send(`⚠️ <b>pi stderr</b>\n<code>${deps.escapeHtml(deps.truncateMiddle(trimmed, 1200))}</code>`);
  return 'stderr';
}

export async function forwardPiExit(session: PiForwardSession, info: unknown, config: PiForwardConfig, deps: PiForwardDeps): Promise<PiEventForwardAction> {
  deps.stopTyping();
  session.isStreaming = false;
  session.lastError = `pi RPC exited: ${JSON.stringify(info)}`;
  if (!config.shuttingDown()) await deps.send(`🛑 <b>pi RPC exited</b>\n<code>${deps.escapeHtml(JSON.stringify(info))}</code>`);
  return 'exit';
}

export function forwardPiError(session: PiForwardSession, error: unknown): PiEventForwardAction {
  session.lastError = error instanceof Error ? error.message : String(error);
  return 'error';
}
