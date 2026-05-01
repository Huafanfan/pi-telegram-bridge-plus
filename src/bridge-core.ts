import { accessDecision, type RuntimeAccessPolicy } from './access-flow.js';
import { planSession } from './session-planner.js';
import { shouldProcessText, stripBotMention, type ChatLike, type MessageLike } from './telegram-routing.js';

export type BridgeCorePolicy = RuntimeAccessPolicy & {
  mentionPatterns: RegExp[];
};

export type BridgeCoreConfig = {
  pairingEnabled: boolean;
  groupRequireMention: boolean;
  workspaceRoot: string;
};

export type TextUpdate = {
  chat: ChatLike;
  from?: { id: number };
  message: MessageLike & { text: string };
};

export type BridgeSession = {
  key: string;
  chatId: number;
  chatType?: string;
  threadId?: number;
  cwd: string;
  prompts: string[];
  starts: number;
  stops: number;
};

export type BridgeCoreRuntime = {
  sessions: Map<string, BridgeSession>;
  botUsernames: Set<string>;
};

export type TextHandleResult =
  | { type: 'prompt'; session: BridgeSession; text: string }
  | { type: 'ignored'; reason: 'unauthorized' | 'command' | 'gated' | 'empty'; message?: string };

export function createBridgeCoreRuntime(botUsernames: Iterable<string> = []): BridgeCoreRuntime {
  return { sessions: new Map(), botUsernames: new Set([...botUsernames].map((name) => name.toLowerCase())) };
}

export function getOrCreateCoreSession(runtime: BridgeCoreRuntime, chat: ChatLike, message: MessageLike | undefined, workspaceRoot: string): BridgeSession {
  const plan = planSession(chat, message);
  const existing = runtime.sessions.get(plan.key);
  if (existing) return existing;
  const session: BridgeSession = {
    key: plan.key,
    chatId: plan.chatId,
    chatType: plan.chatType,
    threadId: plan.threadId,
    cwd: workspaceRoot,
    prompts: [],
    starts: 1,
    stops: 0,
  };
  runtime.sessions.set(session.key, session);
  return session;
}

export function restartCoreSession(session: BridgeSession): void {
  session.prompts = [];
  session.stops += 1;
  session.starts += 1;
}

export function handleCoreTextUpdate(options: {
  runtime: BridgeCoreRuntime;
  policy: BridgeCorePolicy;
  config: BridgeCoreConfig;
  update: TextUpdate;
}): TextHandleResult {
  const { runtime, policy, config, update } = options;
  const decision = accessDecision(policy, update.chat, update.from?.id, config.pairingEnabled);
  if (!decision.allowed) return { type: 'ignored', reason: 'unauthorized', message: decision.message };

  const raw = update.message.text;
  if (raw.startsWith('/')) return { type: 'ignored', reason: 'command' };
  if (
    !shouldProcessText({
      chat: update.chat,
      message: update.message,
      text: raw,
      requireMention: config.groupRequireMention,
      botUsernames: runtime.botUsernames,
      mentionPatterns: policy.mentionPatterns,
    })
  ) {
    return { type: 'ignored', reason: 'gated' };
  }

  const text = stripBotMention(raw, runtime.botUsernames);
  if (!text) return { type: 'ignored', reason: 'empty' };
  const session = getOrCreateCoreSession(runtime, update.chat, update.message, config.workspaceRoot);
  session.prompts.push(text);
  return { type: 'prompt', session, text };
}
