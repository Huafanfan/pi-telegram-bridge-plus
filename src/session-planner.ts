import { isGroupChatType, messageThreadId, sessionKeyFor, type ChatLike, type MessageLike } from './telegram-routing.js';

export type SessionPlan = {
  key: string;
  chatId: number;
  chatType?: string;
  threadId?: number;
};

export function planSession(chat: ChatLike, message?: MessageLike): SessionPlan {
  const threadId = messageThreadId(message);
  return {
    key: sessionKeyFor(chat.id, isGroupChatType(chat.type), threadId),
    chatId: chat.id,
    chatType: chat.type,
    threadId,
  };
}
