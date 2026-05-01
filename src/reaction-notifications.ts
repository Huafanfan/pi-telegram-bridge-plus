export type ReactionMode = 'off' | 'own' | 'all';

export type ReactionEventInput = {
  emoji: string;
  userId?: number;
  username?: string;
  messageId?: number;
  isOwnMessage?: boolean;
};

export function shouldRecordReaction(mode: ReactionMode, event: Pick<ReactionEventInput, 'isOwnMessage'>): boolean {
  if (mode === 'off') return false;
  if (mode === 'all') return true;
  return event.isOwnMessage === true;
}

export function formatReactionNote(event: ReactionEventInput): string {
  const who = event.username ? `@${event.username}` : event.userId ? `user ${event.userId}` : 'a user';
  const target = event.messageId ? ` on message ${event.messageId}` : '';
  return `Telegram reaction added: ${event.emoji} by ${who}${target}.`;
}

export function prependSystemEvents(prompt: string, events: string[]): string {
  if (!events.length) return prompt;
  return [`[Telegram context]`, ...events.map((event) => `- ${event}`), '', 'User prompt:', prompt].join('\n');
}
