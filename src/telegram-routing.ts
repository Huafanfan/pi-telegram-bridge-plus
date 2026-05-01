export const GENERAL_TOPIC_THREAD_ID = 1;

export type ChatLike = {
  id: number;
  type?: string;
};

export type MessageLike = {
  message_thread_id?: unknown;
  reply_to_message?: {
    from?: {
      username?: string;
    };
  };
};

export type AccessPolicy = {
  allowedChatIds: Set<number>;
  allowedUserIds: Set<number>;
  allowedGroupIds: Set<number>;
  ownerUserIds: Set<number>;
};

export function isGroupChatType(type?: string): boolean {
  return type === 'group' || type === 'supergroup';
}

export function messageThreadId(message: MessageLike | undefined): number | undefined {
  const id = message?.message_thread_id;
  return typeof id === 'number' ? id : undefined;
}

export function threadParams(threadId: number | undefined): { message_thread_id?: number } {
  return threadId && threadId !== GENERAL_TOPIC_THREAD_ID ? { message_thread_id: threadId } : {};
}

export function sessionKeyFor(chatId: number, isGroup: boolean, threadId?: number): string {
  if (isGroup) return `telegram:group:${chatId}${threadId ? `:topic:${threadId}` : ''}`;
  return `telegram:chat:${chatId}${threadId ? `:topic:${threadId}` : ''}`;
}

export function isOwnerUser(policy: AccessPolicy, userId?: number): boolean {
  if (typeof userId !== 'number') return false;
  return policy.ownerUserIds.has(userId) || policy.allowedChatIds.has(userId);
}

export function isAllowedUser(policy: AccessPolicy, userId?: number): boolean {
  return typeof userId === 'number' && (policy.allowedUserIds.has(userId) || policy.ownerUserIds.has(userId));
}

export function isAllowedGroup(policy: AccessPolicy, chatId?: number): boolean {
  return typeof chatId === 'number' && (policy.allowedGroupIds.has(chatId) || policy.allowedChatIds.has(chatId));
}

export function isAllowed(policy: AccessPolicy, chat: ChatLike | undefined, userId?: number): boolean {
  if (!chat) return false;
  if (isGroupChatType(chat.type)) {
    if (!isAllowedGroup(policy, chat.id)) return false;
    if (policy.allowedUserIds.size === 0 && policy.ownerUserIds.size === 0) return true;
    return isAllowedUser(policy, userId);
  }
  return policy.allowedChatIds.has(chat.id) || isAllowedUser(policy, userId);
}

export function stripBotMention(text: string, botUsernames: Iterable<string>): string {
  let out = text;
  for (const username of botUsernames) {
    out = out.replace(new RegExp(`@${username}\\b`, 'gi'), '').trim();
  }
  return out;
}

export function isReplyToBot(message: MessageLike, botUsernames: Set<string>): boolean {
  const username = message.reply_to_message?.from?.username;
  return Boolean(username && botUsernames.has(username.toLowerCase()));
}

export function isBotMentioned(text: string, botUsernames: Set<string>, mentionPatterns: RegExp[]): boolean {
  const lower = text.toLowerCase();
  for (const username of botUsernames) {
    if (lower.includes(`@${username}`)) return true;
  }
  return mentionPatterns.some((pattern) => pattern.test(text));
}

export function shouldProcessText(options: {
  chat: ChatLike | undefined;
  message?: MessageLike;
  text: string;
  requireMention: boolean;
  botUsernames: Set<string>;
  mentionPatterns: RegExp[];
}): boolean {
  const { chat, message, text, requireMention, botUsernames, mentionPatterns } = options;
  if (!chat || !isGroupChatType(chat.type)) return true;
  if (!requireMention) return true;
  if (text.startsWith('/')) return true;
  if (message && isReplyToBot(message, botUsernames)) return true;
  return isBotMentioned(text, botUsernames, mentionPatterns);
}
