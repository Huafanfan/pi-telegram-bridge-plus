#!/usr/bin/env node
import { Bot, GrammyError, HttpError, InlineKeyboard, InputFile, type Context } from 'grammy';
import type { Message, ReactionTypeEmoji } from 'grammy/types';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, splitArgs } from './config.js';
import { PiRpcClient, type PiRpcEvent } from './pi-rpc.js';
import { displayProject, ensureProjectDirectory, resolveProjectPath } from './project.js';
import { resolveOutboundMediaFiles, stripMediaMarkers, type OutboundMediaFile } from './outbound-media.js';
import { escapeHtml, formatToolArgs, markdownToTelegramHtml, splitForTelegram, truncateMiddle } from './telegram-format.js';

const execFileAsync = promisify(execFile);
const config = loadConfig();
const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

const MAX_TELEGRAM_API_CHARS = 4096;
const GENERAL_TOPIC_THREAD_ID = 1;

type RpcImage = { type: 'image'; data: string; mimeType: string };

type SessionState = {
  key: string;
  chatId: number;
  chatType?: string;
  messageThreadId?: number;
  cwd: string;
  pi: PiRpcClient;
  pendingText: string;
  textFlushTimer: NodeJS.Timeout | null;
  previewMessageId?: number;
  previewLastText: string;
  lastAssistantFinal: string;
  lastToolUpdateAt: number;
  lastActivityAt: number;
  isStreaming: boolean;
  typingTimer: NodeJS.Timeout | null;
  sentMediaMarkers: Set<string>;
  lastError?: string;
};

type AlbumEntry = {
  chatId: number;
  chatType?: string;
  fromId?: number;
  messageThreadId?: number;
  sessionKey: string;
  caption: string;
  images: RpcImage[];
  timer: NodeJS.Timeout;
  totalBytes: number;
};

const sessions = new Map<string, SessionState>();
const albums = new Map<string, AlbumEntry>();
const botUsernames = new Set<string>();
let idleSweepTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;

function isGroupChatType(type?: string): boolean {
  return type === 'group' || type === 'supergroup';
}

function messageThreadId(message: Message | undefined): number | undefined {
  const id = (message as { message_thread_id?: unknown } | undefined)?.message_thread_id;
  return typeof id === 'number' ? id : undefined;
}

function contextThreadId(ctx: Context): number | undefined {
  return messageThreadId(ctx.message ?? ctx.callbackQuery?.message);
}

function threadParams(threadId: number | undefined): { message_thread_id?: number } {
  // Telegram rejects message_thread_id=1 for sends in some general-topic contexts.
  return threadId && threadId !== GENERAL_TOPIC_THREAD_ID ? { message_thread_id: threadId } : {};
}

function sessionKeyFor(chatId: number, isGroup: boolean, threadId?: number): string {
  if (isGroup) return `telegram:group:${chatId}${threadId ? `:topic:${threadId}` : ''}`;
  return `telegram:chat:${chatId}${threadId ? `:topic:${threadId}` : ''}`;
}

function controlsKeyboard(): InlineKeyboard | undefined {
  if (!config.SHOW_CONTROL_BUTTONS) return undefined;
  return new InlineKeyboard()
    .text('📊 Status', 'status')
    .text('🆕 New', 'new')
    .row()
    .text('🛑 Abort', 'abort');
}

function controlMarkup(): { reply_markup?: InlineKeyboard } {
  const keyboard = controlsKeyboard();
  return keyboard ? { reply_markup: keyboard } : {};
}

function canUseLegacyChatAllowlist(chatId: number): boolean {
  return config.allowedChatIds.has(chatId);
}

function isOwnerUser(userId?: number): boolean {
  if (typeof userId !== 'number') return false;
  return config.ownerUserIds.has(userId) || config.allowedChatIds.has(userId);
}

function isAllowedUser(userId?: number): boolean {
  return typeof userId === 'number' && (config.allowedUserIds.has(userId) || config.ownerUserIds.has(userId));
}

function isAllowedGroup(chatId?: number): boolean {
  return typeof chatId === 'number' && (config.allowedGroupIds.has(chatId) || config.allowedChatIds.has(chatId));
}

function isAllowed(ctx: Context): boolean {
  const chat = ctx.chat;
  if (!chat) return false;
  const userId = ctx.from?.id;
  if (isGroupChatType(chat.type)) {
    if (!isAllowedGroup(chat.id)) return false;
    if (config.allowedUserIds.size === 0 && config.ownerUserIds.size === 0) return true;
    return isAllowedUser(userId);
  }
  return canUseLegacyChatAllowlist(chat.id) || isAllowedUser(userId);
}

function replyParams(ctx: Context): { message_thread_id?: number } {
  return threadParams(contextThreadId(ctx));
}

function replyText(ctx: Context, text: string): void {
  void ctx.reply(text, replyParams(ctx)).catch(() => undefined);
}

function requireAllowed(ctx: Context): boolean {
  if (isAllowed(ctx)) return true;
  replyText(ctx, 'Unauthorized. Ask the bridge owner to add your Telegram user/chat id to the allowlist.');
  return false;
}

function requireOwner(ctx: Context): boolean {
  if (isOwnerUser(ctx.from?.id)) return true;
  replyText(ctx, 'Unauthorized. This command requires bridge owner permission.');
  return false;
}

function clearSessionRuntimeState(session: SessionState): void {
  if (session.textFlushTimer) {
    clearTimeout(session.textFlushTimer);
    session.textFlushTimer = null;
  }
  stopTyping(session);
  session.pendingText = '';
  session.previewMessageId = undefined;
  session.previewLastText = '';
  session.lastAssistantFinal = '';
  session.sentMediaMarkers.clear();
}

function restartSessionPi(session: SessionState): void {
  clearSessionRuntimeState(session);
  session.pi.stop();
  session.pi.start();
  session.lastActivityAt = Date.now();
}

function stopSession(session: SessionState): void {
  clearSessionRuntimeState(session);
  session.pi.stop();
}

function closeSession(key: string): boolean {
  const session = sessions.get(key);
  if (!session) return false;
  stopSession(session);
  sessions.delete(key);
  return true;
}

function getOrCreateSession(ctx: Context): SessionState {
  if (!ctx.chat) throw new Error('Missing chat');
  const isGroup = isGroupChatType(ctx.chat.type);
  const threadId = contextThreadId(ctx);
  const key = sessionKeyFor(ctx.chat.id, isGroup, threadId);
  const existing = sessions.get(key);
  if (existing) {
    existing.chatId = ctx.chat.id;
    existing.chatType = ctx.chat.type;
    existing.messageThreadId = threadId;
    existing.lastActivityAt = Date.now();
    return existing;
  }

  const cwd = resolveProjectPath(config.WORKSPACE_ROOT, '');
  const pi = new PiRpcClient({ piBin: config.PI_BIN, cwd, args: config.piArgs });
  const session: SessionState = {
    key,
    chatId: ctx.chat.id,
    chatType: ctx.chat.type,
    messageThreadId: threadId,
    cwd,
    pi,
    pendingText: '',
    textFlushTimer: null,
    previewLastText: '',
    lastAssistantFinal: '',
    lastToolUpdateAt: 0,
    lastActivityAt: Date.now(),
    isStreaming: false,
    typingTimer: null,
    sentMediaMarkers: new Set(),
  };
  setupPiEventForwarding(session);
  pi.start();
  sessions.set(key, session);
  return session;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function telegramErrorDescription(error: unknown): string {
  if (error instanceof GrammyError) return error.description;
  if (error instanceof Error) return error.message;
  return String(error);
}

function telegramRetryAfterMs(error: unknown): number | undefined {
  if (!(error instanceof GrammyError)) return undefined;
  const parameters = (error as unknown as { parameters?: { retry_after?: unknown } }).parameters;
  const seconds = parameters?.retry_after;
  return typeof seconds === 'number' && Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : undefined;
}

function isRetryableTelegramSendError(error: unknown): boolean {
  if (error instanceof GrammyError) {
    if (error.error_code === 429) return true;
    return error.error_code >= 500 && error.error_code < 600;
  }
  if (error instanceof HttpError) return true;
  return error instanceof Error && /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|network|fetch failed/i.test(error.message);
}

function isMissingThreadError(error: unknown): boolean {
  const description = telegramErrorDescription(error).toLowerCase();
  return description.includes('thread') && description.includes('not found');
}

type SendMessageOptions = {
  keyboard?: InlineKeyboard;
  threadId?: number;
  plain?: boolean;
  omitThread?: boolean;
};

async function sendMessageWithRetry(chatId: number, text: string, options: SendMessageOptions = {}): Promise<number> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= config.TELEGRAM_SEND_RETRIES; attempt += 1) {
    try {
      const msg = await bot.api.sendMessage(chatId, text, {
        parse_mode: options.plain ? undefined : 'HTML',
        link_preview_options: { is_disabled: true },
        ...(options.keyboard ? { reply_markup: options.keyboard } : {}),
        ...(options.omitThread ? {} : threadParams(options.threadId)),
      });
      return msg.message_id;
    } catch (error) {
      lastError = error;
      if (attempt >= config.TELEGRAM_SEND_RETRIES || !isRetryableTelegramSendError(error)) break;
      const retryAfter = telegramRetryAfterMs(error);
      const backoff = retryAfter ?? config.TELEGRAM_SEND_RETRY_BASE_MS * 2 ** attempt;
      await sleep(backoff + Math.floor(Math.random() * 250));
    }
  }
  throw lastError;
}

async function sendTelegramMessage(
  chatId: number,
  text: string,
  options: { keyboard?: InlineKeyboard; threadId?: number; plain?: boolean } = {},
): Promise<number | undefined> {
  let firstMessageId: number | undefined;
  const safeMax = Math.min(config.MAX_TELEGRAM_CHARS, MAX_TELEGRAM_API_CHARS - 100);
  for (const chunk of splitForTelegram(text, safeMax)) {
    try {
      const messageId = await sendMessageWithRetry(chatId, chunk, options);
      firstMessageId ??= messageId;
    } catch (error) {
      if (options.plain) {
        if (options.threadId && isMissingThreadError(error)) {
          const messageId = await sendMessageWithRetry(chatId, chunk, { ...options, omitThread: true });
          firstMessageId ??= messageId;
          continue;
        }
        throw error;
      }

      const plainText = chunk.replace(/<[^>]*>/g, '');
      try {
        const messageId = await sendMessageWithRetry(chatId, plainText, { ...options, plain: true });
        firstMessageId ??= messageId;
      } catch (fallbackError) {
        if (options.threadId && isMissingThreadError(fallbackError)) {
          const messageId = await sendMessageWithRetry(chatId, plainText, { ...options, plain: true, omitThread: true });
          firstMessageId ??= messageId;
        } else {
          throw fallbackError;
        }
      }
    }
  }
  return firstMessageId;
}

async function sendSession(session: SessionState, text: string, keyboard?: InlineKeyboard, plain = false): Promise<number | undefined> {
  return sendTelegramMessage(session.chatId, text, { keyboard, threadId: session.messageThreadId, plain });
}

async function editOrSendPreview(session: SessionState, text: string): Promise<void> {
  const clipped = markdownToTelegramHtml(truncateMiddle(text, Math.min(config.MAX_TELEGRAM_CHARS, MAX_TELEGRAM_API_CHARS - 100)));
  if (!clipped.trim() || clipped === session.previewLastText) return;

  if (!session.previewMessageId) {
    session.previewMessageId = await sendSession(session, clipped);
    session.previewLastText = clipped;
    return;
  }

  try {
    await bot.api.editMessageText(session.chatId, session.previewMessageId, clipped, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...threadParams(session.messageThreadId),
    });
    session.previewLastText = clipped;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (text.toLowerCase().includes('message is not modified')) return;
    session.previewMessageId = await sendSession(session, clipped);
    session.previewLastText = clipped;
  }
}

function scheduleTextFlush(session: SessionState): void {
  if (session.textFlushTimer) return;
  session.textFlushTimer = setTimeout(() => {
    session.textFlushTimer = null;
    const text = session.pendingText.trim();
    if (text) void editOrSendPreview(session, text).catch(console.error);
  }, config.TEXT_UPDATE_THROTTLE_MS);
}

function startTyping(session: SessionState): void {
  if (!config.TELEGRAM_ENABLE_TYPING || session.typingTimer) return;
  const tick = () => {
    void bot.api.sendChatAction(session.chatId, 'typing', threadParams(session.messageThreadId)).catch(() => undefined);
  };
  tick();
  session.typingTimer = setInterval(tick, config.TYPING_INTERVAL_MS);
}

function stopTyping(session: SessionState): void {
  if (!session.typingTimer) return;
  clearInterval(session.typingTimer);
  session.typingTimer = null;
}

async function react(ctx: Context, emoji: ReactionTypeEmoji['emoji']): Promise<void> {
  if (!config.TELEGRAM_ENABLE_REACTIONS || !ctx.chat || !ctx.message) return;
  try {
    await bot.api.setMessageReaction(ctx.chat.id, ctx.message.message_id, [{ type: 'emoji', emoji }]);
  } catch {
    // Reactions are best-effort and may be disabled in a chat.
  }
}

function assistantTextDelta(event: PiRpcEvent): string | null {
  const nested = event.assistantMessageEvent;
  if (typeof nested === 'object' && nested !== null) {
    const maybe = nested as Record<string, unknown>;
    if (maybe.type === 'text_delta' && typeof maybe.delta === 'string') return maybe.delta;
  }
  return null;
}

function eventType(event: PiRpcEvent): string {
  return typeof event.type === 'string' ? event.type : 'unknown';
}

function messageText(message: unknown): string {
  if (typeof message !== 'object' || message === null) return '';
  const msg = message as Record<string, unknown>;
  if (typeof msg.errorMessage === 'string' && msg.errorMessage.trim()) {
    return `⚠️ ${msg.errorMessage.trim()}`;
  }
  const content = msg.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (typeof part !== 'object' || part === null) return '';
      const item = part as Record<string, unknown>;
      if (typeof item.text === 'string') return item.text;
      if (typeof item.content === 'string') return item.content;
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

async function sendOutboundMediaFile(session: SessionState, file: OutboundMediaFile): Promise<void> {
  const caption = `📎 ${file.fileName}`;
  const baseOptions = threadParams(session.messageThreadId);
  switch (file.kind) {
    case 'photo':
      await bot.api.sendPhoto(session.chatId, new InputFile(file.path), { caption, ...baseOptions });
      return;
    case 'audio':
      await bot.api.sendAudio(session.chatId, new InputFile(file.path), { caption, ...baseOptions });
      return;
    case 'voice':
      await bot.api.sendVoice(session.chatId, new InputFile(file.path), { caption, ...baseOptions });
      return;
    case 'video':
      await bot.api.sendVideo(session.chatId, new InputFile(file.path), { caption, ...baseOptions });
      return;
    case 'document':
      await bot.api.sendDocument(session.chatId, new InputFile(file.path), { caption, ...baseOptions });
      return;
  }
}

async function sendOutboundMedia(session: SessionState, text: string): Promise<string> {
  const { files, errors } = resolveOutboundMediaFiles({
    text,
    workspaceRoot: config.WORKSPACE_ROOT,
    maxBytes: config.MAX_OUTBOUND_FILE_BYTES,
  });

  for (const file of files) {
    if (session.sentMediaMarkers.has(file.marker)) continue;
    try {
      await sendOutboundMediaFile(session, file);
      session.sentMediaMarkers.add(file.marker);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`Failed to send MEDIA file ${file.path}: ${message}`);
    }
  }

  if (errors.length) {
    await sendSession(session, `⚠️ <b>MEDIA delivery issues</b>\n<code>${escapeHtml(errors.join('\n'))}</code>`).catch(console.error);
  }

  return stripMediaMarkers(text);
}

async function sendStatus(session: SessionState): Promise<void> {
  const response = await session.pi.getState();
  const state = (response.data ?? response) as Record<string, unknown>;
  const compact = {
    sessionKey: session.key,
    project: displayProject(config.WORKSPACE_ROOT, session.pi.cwd),
    model: state.model,
    thinkingLevel: state.thinkingLevel,
    isStreaming: state.isStreaming,
    pendingMessageCount: state.pendingMessageCount,
    sessionName: state.sessionName,
    sessionId: state.sessionId,
    sessionFile: state.sessionFile,
    piRunning: session.pi.isRunning,
    activeSessions: sessions.size,
    lastError: session.lastError,
  };
  await sendSession(session, `<b>Status</b>\n<code>${escapeHtml(JSON.stringify(compact, null, 2))}</code>`, controlsKeyboard());
}

function assistantMessageFromEvent(event: PiRpcEvent): Record<string, unknown> | undefined {
  const direct = event.message as Record<string, unknown> | undefined;
  if (direct?.role === 'assistant') return direct;

  if (Array.isArray(event.messages)) {
    return [...event.messages]
      .reverse()
      .find((message): message is Record<string, unknown> => typeof message === 'object' && message !== null && (message as Record<string, unknown>).role === 'assistant');
  }

  return undefined;
}

async function handleAssistantFinal(session: SessionState, message: Record<string, unknown> | undefined): Promise<boolean> {
  if (!message) return false;
  const text = messageText(message);
  if (!text || text === session.lastAssistantFinal || session.pendingText.includes(text)) return false;
  session.lastAssistantFinal = text;
  const visibleText = await sendOutboundMedia(session, text);
  if (!visibleText) return false;
  session.pendingText = visibleText;
  await editOrSendPreview(session, visibleText);
  return true;
}

function setupPiEventForwarding(session: SessionState): void {
  const { pi } = session;
  pi.on('event', (event: PiRpcEvent) => {
    const type = eventType(event);

    // Avoid sending final assistant text on message_end/turn_end because agent_end
    // carries the same final message. Handling all three races with preview reset
    // and can duplicate the same answer in Telegram.
    if (type === 'message_end' || type === 'turn_end') return;

    if (type === 'agent_start') {
      session.isStreaming = true;
      startTyping(session);
      if (config.VERBOSE_EVENTS) {
        void sendSession(session, `🚀 <b>pi started</b>\nProject: <code>${escapeHtml(displayProject(config.WORKSPACE_ROOT, pi.cwd))}</code>`, controlsKeyboard()).catch(console.error);
      }
      return;
    }
    if (type === 'agent_end') {
      void (async () => {
        await handleAssistantFinal(session, assistantMessageFromEvent(event));
        stopTyping(session);
        session.isStreaming = false;
        if (session.pendingText.trim()) {
          const text = session.pendingText.trim();
          session.pendingText = '';
          const visibleText = await sendOutboundMedia(session, text);
          if (visibleText) await editOrSendPreview(session, visibleText);
        }
        session.previewMessageId = undefined;
        session.previewLastText = '';
      })().catch(console.error);
      if (config.VERBOSE_EVENTS) {
        void sendSession(session, '✅ <b>pi finished</b>', controlsKeyboard()).catch(console.error);
      }
      return;
    }
    if (type === 'tool_execution_start') {
      if (config.VERBOSE_EVENTS) {
        const now = Date.now();
        if (now - session.lastToolUpdateAt < config.TOOL_UPDATE_THROTTLE_MS) return;
        session.lastToolUpdateAt = now;
        const toolName = typeof event.toolName === 'string' ? event.toolName : 'tool';
        const details = truncateMiddle(formatToolArgs(event.args), 700);
        void sendSession(session, `🔧 <b>${escapeHtml(toolName)}</b>${details ? `\n<code>${escapeHtml(details)}</code>` : ''}`).catch(console.error);
      }
      return;
    }
    if (type === 'tool_execution_end' && event.isError === true) {
      const toolName = typeof event.toolName === 'string' ? event.toolName : 'tool';
      const result = truncateMiddle(formatToolArgs(event.result), 1000);
      void sendSession(session, `❌ <b>${escapeHtml(toolName)} failed</b>${result ? `\n<code>${escapeHtml(result)}</code>` : ''}`, controlsKeyboard()).catch(console.error);
      return;
    }

    const delta = assistantTextDelta(event);
    if (delta) {
      session.pendingText += delta;
      scheduleTextFlush(session);
    }
  });

  pi.on('stderr', (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    session.lastError = trimmed;
    if (config.VERBOSE_EVENTS) {
      void sendSession(session, `⚠️ <b>pi stderr</b>\n<code>${escapeHtml(truncateMiddle(trimmed, 1200))}</code>`).catch(console.error);
    }
  });

  pi.on('exit', (info: unknown) => {
    stopTyping(session);
    session.isStreaming = false;
    session.lastError = `pi RPC exited: ${JSON.stringify(info)}`;
    if (!shuttingDown) {
      void sendSession(session, `🛑 <b>pi RPC exited</b>\n<code>${escapeHtml(JSON.stringify(info))}</code>`, controlsKeyboard()).catch(console.error);
    }
  });

  pi.on('error', (error) => {
    session.lastError = error instanceof Error ? error.message : String(error);
  });
}

async function sendPromptToSession(session: SessionState, text: string, images?: RpcImage[], ctx?: Context): Promise<void> {
  if (ctx) await react(ctx, '👀');
  if (images?.length) {
    await sendSession(session, `🖼️ 收到 ${images.length} 张图片，我看一下。`, controlsKeyboard());
  }
  try {
    const state = await session.pi.getState();
    const data = state.data as { isStreaming?: boolean } | undefined;
    if (data?.isStreaming) {
      await session.pi.prompt(text, 'followUp', images);
      await sendSession(session, '⏳ pi is busy; message queued as follow-up. Use /steer if you want to alter the current run.');
    } else {
      session.pendingText = '';
      session.previewMessageId = undefined;
      session.previewLastText = '';
      session.lastAssistantFinal = '';
      await session.pi.prompt(text, undefined, images);
    }
  } catch (error) {
    session.lastError = error instanceof Error ? error.message : String(error);
    if (ctx) await react(ctx, '😢');
    await sendSession(session, `Failed to send prompt: ${session.lastError}`, undefined, true);
  }
}

async function sendPromptToPi(ctx: Context, text: string, images?: RpcImage[]): Promise<void> {
  await sendPromptToSession(getOrCreateSession(ctx), text, images, ctx);
}

function stripBotMention(text: string): string {
  let out = text;
  for (const username of botUsernames) {
    out = out.replace(new RegExp(`@${username}\\b`, 'gi'), '').trim();
  }
  return out;
}

function isReplyToBot(message: Message): boolean {
  const username = message.reply_to_message?.from?.username;
  return Boolean(username && botUsernames.has(username.toLowerCase()));
}

function isBotMentioned(text: string): boolean {
  const lower = text.toLowerCase();
  for (const username of botUsernames) {
    if (lower.includes(`@${username}`)) return true;
  }
  return config.mentionPatterns.some((pattern) => pattern.test(text));
}

function shouldProcessText(ctx: Context, text: string): boolean {
  const chat = ctx.chat;
  if (!chat || !isGroupChatType(chat.type)) return true;
  if (!config.TELEGRAM_GROUP_REQUIRE_MENTION) return true;
  if (text.startsWith('/')) return true;
  if (ctx.message && isReplyToBot(ctx.message)) return true;
  return isBotMentioned(text);
}

async function fetchTelegramFile(fileId: string, maxBytes: number): Promise<{ data: Buffer; mimeType: string }> {
  const file = await bot.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) throw new Error(`File too large (${length} bytes)`);
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > maxBytes) throw new Error(`File too large (${arrayBuffer.byteLength} bytes)`);
  return { data: Buffer.from(arrayBuffer), mimeType: response.headers.get('content-type') ?? 'application/octet-stream' };
}

async function imageFromPhoto(message: Message): Promise<{ image: RpcImage; bytes: number }> {
  const photo = message.photo?.at(-1);
  if (!photo) throw new Error('Missing photo');
  if (photo.file_size && photo.file_size > config.MAX_IMAGE_BYTES) throw new Error(`Image too large (${photo.file_size} bytes)`);
  const file = await fetchTelegramFile(photo.file_id, config.MAX_IMAGE_BYTES);
  return { image: { type: 'image', data: file.data.toString('base64'), mimeType: file.mimeType || 'image/jpeg' }, bytes: file.data.byteLength };
}

function albumKey(ctx: Context): string {
  if (!ctx.chat || !ctx.message) throw new Error('Missing chat/message');
  return `${ctx.chat.id}:${contextThreadId(ctx) ?? 'root'}:${ctx.message.media_group_id ?? 'burst'}`;
}

function getSessionByAlbumEntry(entry: AlbumEntry): SessionState {
  const existing = sessions.get(entry.sessionKey);
  if (existing) return existing;
  const cwd = resolveProjectPath(config.WORKSPACE_ROOT, '');
  const pi = new PiRpcClient({ piBin: config.PI_BIN, cwd, args: config.piArgs });
  const session: SessionState = {
    key: entry.sessionKey,
    chatId: entry.chatId,
    chatType: entry.chatType,
    messageThreadId: entry.messageThreadId,
    cwd,
    pi,
    pendingText: '',
    textFlushTimer: null,
    previewLastText: '',
    lastAssistantFinal: '',
    lastToolUpdateAt: 0,
    lastActivityAt: Date.now(),
    isStreaming: false,
    typingTimer: null,
    sentMediaMarkers: new Set(),
  };
  setupPiEventForwarding(session);
  pi.start();
  sessions.set(session.key, session);
  return session;
}

async function flushAlbum(key: string): Promise<void> {
  const entry = albums.get(key);
  if (!entry) return;
  albums.delete(key);
  const session = getSessionByAlbumEntry(entry);
  const prompt = entry.caption || `Please inspect these ${entry.images.length} images.`;
  await sendPromptToSession(session, prompt, entry.images);
}

async function handlePhoto(ctx: Context): Promise<void> {
  if (!requireAllowed(ctx)) return;
  if (!ctx.message) return;
  if (!shouldProcessText(ctx, ctx.message.caption ?? '')) return;
  const session = getOrCreateSession(ctx);
  try {
    const { image, bytes } = await imageFromPhoto(ctx.message);
    if (ctx.message.media_group_id) {
      const key = albumKey(ctx);
      const existing = albums.get(key);
      if (existing) {
        existing.images.push(image);
        existing.totalBytes += bytes;
        if (ctx.message.caption?.trim()) existing.caption = [existing.caption, stripBotMention(ctx.message.caption.trim())].filter(Boolean).join('\n');
        clearTimeout(existing.timer);
        existing.timer = setTimeout(() => void flushAlbum(key).catch(console.error), config.ALBUM_DEBOUNCE_MS);
        if (existing.images.length > config.MAX_ALBUM_IMAGES || existing.totalBytes > config.MAX_IMAGE_BYTES * config.MAX_ALBUM_IMAGES) {
          clearTimeout(existing.timer);
          albums.delete(key);
          await ctx.reply('Album too large; please send fewer/smaller images.', threadParams(session.messageThreadId));
        }
      } else {
        const timer = setTimeout(() => void flushAlbum(key).catch(console.error), config.ALBUM_DEBOUNCE_MS);
        albums.set(key, {
          chatId: ctx.chat!.id,
          chatType: ctx.chat!.type,
          fromId: ctx.from?.id,
          messageThreadId: session.messageThreadId,
          sessionKey: session.key,
          caption: stripBotMention(ctx.message.caption?.trim() || ''),
          images: [image],
          timer,
          totalBytes: bytes,
        });
      }
      return;
    }
    const caption = stripBotMention(ctx.message.caption?.trim() || '') || 'Please inspect this image.';
    await sendPromptToPi(ctx, caption, [image]);
  } catch (error) {
    await ctx.reply(`Image handling failed: ${error instanceof Error ? error.message : String(error)}`, threadParams(session.messageThreadId));
  }
}

function cleanupIdleSessions(now = Date.now()): string[] {
  if (config.SESSION_IDLE_TIMEOUT_MS <= 0) return [];
  const closed: string[] = [];
  for (const [key, session] of sessions.entries()) {
    if (session.isStreaming) continue;
    if (now - session.lastActivityAt < config.SESSION_IDLE_TIMEOUT_MS) continue;
    if (closeSession(key)) closed.push(key);
  }
  return closed;
}

function startIdleSweep(): void {
  if (config.SESSION_IDLE_TIMEOUT_MS <= 0 || idleSweepTimer) return;
  idleSweepTimer = setInterval(() => {
    const closed = cleanupIdleSessions();
    if (closed.length) console.log(`Closed ${closed.length} idle Telegram session(s): ${closed.join(', ')}`);
  }, config.SESSION_IDLE_SWEEP_MS);
  idleSweepTimer.unref?.();
}

async function transcribeVoice(filePath: string): Promise<string> {
  if (!config.VOICE_TRANSCRIBE_CMD.trim()) {
    throw new Error('Voice transcription is not configured. Set VOICE_TRANSCRIBE_CMD.');
  }
  const parts = splitArgs(config.VOICE_TRANSCRIBE_CMD);
  const [cmd, ...args] = parts;
  if (!cmd) throw new Error('VOICE_TRANSCRIBE_CMD is empty');
  const { stdout } = await execFileAsync(cmd, [...args, filePath], { timeout: 120_000, maxBuffer: 1024 * 1024 * 10 });
  return stdout.trim();
}

bot.command(['start', 'help'], async (ctx) => {
  if (!requireAllowed(ctx)) return;
  await ctx.reply(
    [
      'π Telegram Bridge Plus',
      '',
      '/project [path] - show or switch project for this chat/topic',
      '/sessions - show active sessions',
      '/new - start a fresh pi session',
      '/status - show pi session state',
      '/abort - abort current pi run',
      '/steer <text> - queue steering instruction during a run',
      '/followup <text> - queue follow-up after current run',
      '/thinking <level> - set pi thinking level if supported',
      '/help - show this help',
      '',
      'Send text to prompt pi. Send photos/albums with optional captions for image prompts.',
      'Voice transcription requires VOICE_TRANSCRIBE_CMD.',
    ].join('\n'),
    { ...controlMarkup(), ...replyParams(ctx) },
  );
});

bot.command('project', async (ctx) => {
  if (!requireAllowed(ctx) || !requireOwner(ctx)) return;
  const session = getOrCreateSession(ctx);
  const value = ctx.match.trim();
  if (!value) {
    await ctx.reply(`Current project: ${displayProject(config.WORKSPACE_ROOT, session.pi.cwd)}\nWorkspace root: ${path.resolve(config.WORKSPACE_ROOT)}`, threadParams(session.messageThreadId));
    return;
  }
  try {
    const projectPath = resolveProjectPath(config.WORKSPACE_ROOT, value);
    ensureProjectDirectory(projectPath);
    session.cwd = projectPath;
    session.pi.setCwd(projectPath);
    await ctx.reply(`📁 Switched this session to ${displayProject(config.WORKSPACE_ROOT, projectPath)}. pi RPC restarted.`, { ...controlMarkup(), ...threadParams(session.messageThreadId) });
  } catch (error) {
    await ctx.reply(`Project switch failed: ${error instanceof Error ? error.message : String(error)}`, threadParams(session.messageThreadId));
  }
});

bot.command('sessions', async (ctx) => {
  if (!requireAllowed(ctx) || !requireOwner(ctx)) return;
  const session = getOrCreateSession(ctx);
  const match = ctx.match.trim();
  const [action, ...rest] = match.split(/\s+/).filter(Boolean);

  if (action === 'cleanup') {
    const closed = cleanupIdleSessions();
    await sendSession(
      session,
      closed.length
        ? `<b>Closed idle sessions</b>\n<code>${escapeHtml(JSON.stringify(closed, null, 2))}</code>`
        : 'No idle sessions matched the configured cleanup threshold.',
      controlsKeyboard(),
    );
    return;
  }

  if (action === 'close') {
    const requestedKey = rest.join(' ');
    const targetKey = requestedKey === 'current' || requestedKey === '' ? session.key : requestedKey;
    if (targetKey === session.key && sessions.size === 1) {
      await sendSession(session, 'Refusing to close the only active session from inside itself. Start another session first or let shutdown stop it.');
      return;
    }
    const target = sessions.get(targetKey);
    if (!target) {
      await sendSession(session, `Session not found: <code>${escapeHtml(targetKey)}</code>`);
      return;
    }
    const replySession = targetKey === session.key ? undefined : session;
    closeSession(targetKey);
    if (replySession) {
      await sendSession(replySession, `Closed session: <code>${escapeHtml(targetKey)}</code>`, controlsKeyboard());
    } else {
      await bot.api.sendMessage(ctx.chat!.id, `Closed current session: ${targetKey}`, threadParams(contextThreadId(ctx))).catch(() => undefined);
    }
    return;
  }

  const rows = [...sessions.values()].map((s) => ({
    key: s.key,
    project: displayProject(config.WORKSPACE_ROOT, s.pi.cwd),
    running: s.pi.isRunning,
    streaming: s.isStreaming,
    idleMs: Date.now() - s.lastActivityAt,
    lastActivityAt: new Date(s.lastActivityAt).toISOString(),
  }));
  const help = 'Usage: /sessions | /sessions cleanup | /sessions close <key|current>';
  await sendSession(session, `<b>Sessions</b>\n<code>${escapeHtml(JSON.stringify(rows, null, 2))}</code>\n\n${escapeHtml(help)}`, controlsKeyboard());
});

bot.command('new', async (ctx) => {
  if (!requireAllowed(ctx)) return;
  const session = getOrCreateSession(ctx);
  await ctx.reply('🆕 Restarting this Telegram session with a fresh pi RPC process...', threadParams(session.messageThreadId));
  restartSessionPi(session);
  await sendSession(session, '🆕 <b>New session ready</b>\nStarted a fresh pi RPC process for this chat/topic.', controlsKeyboard());
});

bot.command('status', async (ctx) => {
  if (!requireAllowed(ctx)) return;
  await sendStatus(getOrCreateSession(ctx));
});

bot.command('abort', async (ctx) => {
  if (!requireAllowed(ctx) || !requireOwner(ctx)) return;
  const session = getOrCreateSession(ctx);
  const response = await session.pi.abort();
  await sendSession(session, `🛑 <b>Abort requested</b>\n<code>${escapeHtml(JSON.stringify(response, null, 2))}</code>`, controlsKeyboard());
});

bot.command('steer', async (ctx) => {
  if (!requireAllowed(ctx)) return;
  const session = getOrCreateSession(ctx);
  const text = ctx.match.trim();
  if (!text) {
    await ctx.reply('Usage: /steer <instruction>', threadParams(session.messageThreadId));
    return;
  }
  await session.pi.steer(text);
  await ctx.reply('🧭 Steering queued.', { ...controlMarkup(), ...threadParams(session.messageThreadId) });
});

bot.command('followup', async (ctx) => {
  if (!requireAllowed(ctx)) return;
  const session = getOrCreateSession(ctx);
  const text = ctx.match.trim();
  if (!text) {
    await ctx.reply('Usage: /followup <message>', threadParams(session.messageThreadId));
    return;
  }
  await session.pi.followUp(text);
  await ctx.reply('📌 Follow-up queued.', { ...controlMarkup(), ...threadParams(session.messageThreadId) });
});

bot.command('thinking', async (ctx) => {
  if (!requireAllowed(ctx) || !requireOwner(ctx)) return;
  const session = getOrCreateSession(ctx);
  const level = ctx.match.trim();
  if (!level) {
    await ctx.reply('Usage: /thinking off|minimal|low|medium|high|xhigh', threadParams(session.messageThreadId));
    return;
  }
  const response = await session.pi.setThinking(level);
  await sendSession(session, `<code>${escapeHtml(JSON.stringify(response, null, 2))}</code>`, controlsKeyboard());
});

bot.callbackQuery('status', async (ctx) => {
  if (!requireAllowed(ctx)) return;
  await ctx.answerCallbackQuery();
  await sendStatus(getOrCreateSession(ctx));
});

bot.callbackQuery('new', async (ctx) => {
  if (!requireAllowed(ctx)) return;
  await ctx.answerCallbackQuery('Starting new session');
  const session = getOrCreateSession(ctx);
  restartSessionPi(session);
  await sendSession(session, '🆕 <b>New session ready</b>\nStarted a fresh pi RPC process for this chat/topic.', controlsKeyboard());
});

bot.callbackQuery('abort', async (ctx) => {
  if (!requireAllowed(ctx) || !isOwnerUser(ctx.from?.id)) {
    await ctx.answerCallbackQuery('Unauthorized');
    return;
  }
  await ctx.answerCallbackQuery('Abort requested');
  const session = getOrCreateSession(ctx);
  const response = await session.pi.abort();
  await sendSession(session, `🛑 <b>Abort requested</b>\n<code>${escapeHtml(JSON.stringify(response, null, 2))}</code>`, controlsKeyboard());
});

bot.on('message:photo', handlePhoto);

bot.on('message:voice', async (ctx) => {
  if (!requireAllowed(ctx)) return;
  const session = getOrCreateSession(ctx);
  const voice = ctx.message.voice;
  if (voice.file_size && voice.file_size > config.MAX_VOICE_BYTES) {
    await ctx.reply(`Voice message too large (${voice.file_size} bytes). MAX_VOICE_BYTES=${config.MAX_VOICE_BYTES}`, threadParams(session.messageThreadId));
    return;
  }
  try {
    const file = await fetchTelegramFile(voice.file_id, config.MAX_VOICE_BYTES);
    const tmpPath = path.join(process.cwd(), `.telegram-voice-${Date.now()}-${voice.file_unique_id}.ogg`);
    await import('node:fs/promises').then((fs) => fs.writeFile(tmpPath, file.data));
    try {
      const transcript = await transcribeVoice(tmpPath);
      if (!transcript) throw new Error('Transcription returned empty text');
      await ctx.reply('🎙️ Voice transcribed.', threadParams(session.messageThreadId));
      await sendPromptToPi(ctx, transcript);
    } finally {
      await import('node:fs/promises').then((fs) => fs.unlink(tmpPath).catch(() => undefined));
    }
  } catch (error) {
    await ctx.reply(`Voice handling failed: ${error instanceof Error ? error.message : String(error)}`, threadParams(session.messageThreadId));
  }
});

bot.on('message:document', async (ctx) => {
  if (!requireAllowed(ctx)) return;
  const session = getOrCreateSession(ctx);
  const doc = ctx.message.document;
  if (doc.file_size && doc.file_size > config.MAX_DOCUMENT_BYTES) {
    await ctx.reply(`Document too large (${doc.file_size} bytes). MAX_DOCUMENT_BYTES=${config.MAX_DOCUMENT_BYTES}`, threadParams(session.messageThreadId));
    return;
  }
  try {
    const file = await fetchTelegramFile(doc.file_id, config.MAX_DOCUMENT_BYTES);
    const fileName = doc.file_name ?? 'document';
    const ext = path.extname(fileName).toLowerCase();
    const textExts = new Set(['.txt', '.md', '.json', '.csv', '.log', '.ts', '.js', '.py', '.yaml', '.yml']);
    if (!textExts.has(ext)) {
      await ctx.reply(`Unsupported document type '${ext || 'unknown'}'. Supported: ${[...textExts].join(', ')}`, threadParams(session.messageThreadId));
      return;
    }
    const content = file.data.toString('utf8');
    const caption = ctx.message.caption?.trim();
    const prompt = [`Please inspect this document: ${fileName}`, '', '```', truncateMiddle(content, 50_000), '```', caption ? `\nUser note: ${caption}` : ''].join('\n');
    await ctx.reply('📄 Document received.', threadParams(session.messageThreadId));
    await sendPromptToPi(ctx, prompt);
  } catch (error) {
    await ctx.reply(`Document handling failed: ${error instanceof Error ? error.message : String(error)}`, threadParams(session.messageThreadId));
  }
});

bot.on('message:text', async (ctx) => {
  if (!requireAllowed(ctx)) return;
  const raw = ctx.message.text;
  if (raw.startsWith('/')) return;
  if (!shouldProcessText(ctx, raw)) return;
  const text = stripBotMention(raw);
  if (!text) return;
  await sendPromptToPi(ctx, text);
});

bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`Error while handling update ${ctx.update.update_id}:`);
  const e = err.error;
  if (e instanceof GrammyError) {
    console.error('Error in request:', e.description);
    if (e.error_code === 409 && /getUpdates|terminated by other getUpdates request/i.test(e.description)) {
      console.error('Telegram polling conflict detected. Another bridge/bot process is likely polling with the same TELEGRAM_BOT_TOKEN. Stop the other instance or use a different bot token.');
    }
  } else if (e instanceof HttpError) console.error('Could not contact Telegram:', e);
  else console.error('Unknown error:', e);
});

async function shutdown(): Promise<void> {
  shuttingDown = true;
  if (idleSweepTimer) {
    clearInterval(idleSweepTimer);
    idleSweepTimer = null;
  }
  for (const album of albums.values()) clearTimeout(album.timer);
  albums.clear();
  for (const session of sessions.values()) stopSession(session);
  sessions.clear();
  await bot.stop().catch(() => undefined);
}

process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));

try {
  await bot.api.deleteWebhook({ drop_pending_updates: false });
} catch (error) {
  console.warn(`deleteWebhook failed (continuing): ${error instanceof Error ? error.message : String(error)}`);
}

const me = await bot.api.getMe();
botUsernames.add(me.username.toLowerCase());

await bot.api.setMyCommands([
  { command: 'help', description: 'Show help' },
  { command: 'project', description: 'Show or switch project' },
  { command: 'sessions', description: 'Show active sessions' },
  { command: 'new', description: 'Start a fresh pi session' },
  { command: 'status', description: 'Show pi session state' },
  { command: 'abort', description: 'Abort current pi run' },
  { command: 'steer', description: 'Steer current run' },
  { command: 'followup', description: 'Queue follow-up message' },
  { command: 'thinking', description: 'Set thinking level' },
]).catch((error) => console.warn(`setMyCommands failed: ${error instanceof Error ? error.message : String(error)}`));

startIdleSweep();

console.log(`pi-telegram-bridge-plus started as @${me.username}. Workspace: ${config.WORKSPACE_ROOT}`);
await bot.start({
  onStart: (botInfo) => {
    console.log(`Telegram bot @${botInfo.username} is polling.`);
  },
});
