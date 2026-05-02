#!/usr/bin/env node
import { Bot, GrammyError, HttpError, InlineKeyboard, InputFile, type Context } from 'grammy';
import type { Message, ReactionTypeEmoji } from 'grammy/types';
import path from 'node:path';
import fs from 'node:fs';
import { homedir } from 'node:os';
import http, { type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, splitArgs } from './config.js';
import { redactProxyUrl, telegramClientOptions, telegramFetch } from './telegram-client.js';
import { planSession } from './session-planner.js';
import { approvePairingRecord, createPairingCode, normalizePairingStore, prunePairingRecords, revokePairingUser, type PairingRecord, type PairingStore } from './pairing.js';
import { createWebhookServer, normalizePath } from './webhook-server.js';
import { accessDecision, isRuntimeAllowed, isRuntimeOwner } from './access-flow.js';
import { forwardPiError, forwardPiEvent, forwardPiExit, forwardPiStderr } from './pi-event-forwarder.js';
import { imageMimeForTelegramPhoto } from './mime.js';
import { effectiveTopicConfig, isTopicUserAllowed, loadTopicConfigFile } from './topic-config.js';
import { formatReactionNote, prependSystemEvents, shouldRecordReaction, type ReactionMode } from './reaction-notifications.js';
import { parseTelegramActions, resolveTelegramActionFile, type TelegramAction } from './telegram-actions.js';
import { isTextDocumentExtension, mediaSavedPrompt, saveTelegramMediaFile, supportedTextDocumentExtensions } from './media-input.js';
import { PiRpcClient, type PiRpcEvent } from './pi-rpc.js';
import { displayProject, ensureProjectDirectory, resolveProjectPath } from './project.js';
import { resolveOutboundMediaFiles, stripMediaMarkers, type OutboundMediaFile } from './outbound-media.js';
import { escapeHtml, formatToolArgs, markdownToTelegramHtml, splitForTelegram, truncateMiddle } from './telegram-format.js';
import {
  messageThreadId,
  sessionKeyFor,
  shouldProcessText as shouldProcessTextByPolicy,
  stripBotMention as stripBotMentionByPolicy,
  threadParams,
  isGroupChatType,
  type AccessPolicy,
} from './telegram-routing.js';

const execFileAsync = promisify(execFile);
const config = loadConfig();
const bot = new Bot(config.TELEGRAM_BOT_TOKEN, { client: telegramClientOptions(config) });

const MAX_TELEGRAM_API_CHARS = 4096;

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
  systemEvents: string[];
  botMessageIds: Set<number>;
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
const runtimeAllowedUserIds = new Set<number>();
const pendingPairing = new Map<string, PairingRecord>();
const topicConfig = loadTopicConfigFile(config.TELEGRAM_TOPIC_CONFIG_FILE);
const startedAt = Date.now();
let idleSweepTimer: NodeJS.Timeout | null = null;
let healthServer: Server | null = null;
let webhookServer: Server | null = null;
let shuttingDown = false;

function contextThreadId(ctx: Context): number | undefined {
  return messageThreadId(ctx.message ?? ctx.callbackQuery?.message);
}

function effectiveConfigFor(ctx: Context) {
  return effectiveTopicConfig(topicConfig, ctx.chat, contextThreadId(ctx));
}

function accessPolicy(): AccessPolicy {
  return {
    allowedChatIds: config.allowedChatIds,
    allowedUserIds: config.allowedUserIds,
    allowedGroupIds: config.allowedGroupIds,
    ownerUserIds: config.ownerUserIds,
  };
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

function runtimeAccessPolicy() {
  return { ...accessPolicy(), runtimeAllowedUserIds };
}

function isOwnerUser(userId?: number): boolean {
  return isRuntimeOwner(runtimeAccessPolicy(), userId);
}

function isAllowed(ctx: Context): boolean {
  return isRuntimeAllowed(runtimeAccessPolicy(), ctx.chat, ctx.from?.id);
}

function replyParams(ctx: Context): { message_thread_id?: number } {
  return threadParams(contextThreadId(ctx));
}

function replyText(ctx: Context, text: string): void {
  void ctx.reply(text, replyParams(ctx)).catch(() => undefined);
}

function requireAllowed(ctx: Context): boolean {
  const topic = effectiveConfigFor(ctx);
  if (topic.enabled === false) {
    replyText(ctx, 'This Telegram topic is disabled for this bridge.');
    return false;
  }
  if (!isTopicUserAllowed(topic, ctx.from?.id)) {
    replyText(ctx, 'This Telegram topic is restricted to specific users.');
    return false;
  }
  const decision = accessDecision(runtimeAccessPolicy(), ctx.chat, ctx.from?.id, config.TELEGRAM_PAIRING_ENABLED);
  if (decision.allowed) return true;
  replyText(ctx, decision.message);
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

function pairingFilePath(): string {
  return path.isAbsolute(config.TELEGRAM_PAIRING_FILE) ? config.TELEGRAM_PAIRING_FILE : path.resolve(process.cwd(), config.TELEGRAM_PAIRING_FILE);
}

function loadPairingStore(): PairingStore {
  try {
    return normalizePairingStore(JSON.parse(fs.readFileSync(pairingFilePath(), 'utf8')));
  } catch {
    return { allowedUserIds: [], pending: [] };
  }
}

function savePairingStore(store: PairingStore): void {
  const filePath = pairingFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`);
}

function loadRuntimeAllowlist(): void {
  const store = loadPairingStore();
  runtimeAllowedUserIds.clear();
  for (const id of store.allowedUserIds) runtimeAllowedUserIds.add(id);
}

function pruneExpiredPairings(now = Date.now()): void {
  const active = prunePairingRecords(pendingPairing.values(), now);
  if (active.length === pendingPairing.size) return;
  pendingPairing.clear();
  for (const record of active) pendingPairing.set(record.code, record);
}

function createPairingRequest(ctx: Context): PairingRecord {
  if (!ctx.chat || !ctx.from) throw new Error('Missing chat/from');
  pruneExpiredPairings();
  for (const existing of pendingPairing.values()) {
    if (existing.userId === ctx.from.id) return existing;
  }
  const code = createPairingCode(new Set(pendingPairing.keys()));
  const now = Date.now();
  const record: PairingRecord = {
    code,
    userId: ctx.from.id,
    chatId: ctx.chat.id,
    username: ctx.from.username,
    firstName: ctx.from.first_name,
    createdAt: now,
    expiresAt: now + config.TELEGRAM_PAIRING_CODE_TTL_MS,
  };
  pendingPairing.set(code, record);
  return record;
}

function approvePairing(code: string): PairingRecord | undefined {
  pruneExpiredPairings();
  const normalized = code.trim().toUpperCase();
  const record = pendingPairing.get(normalized);
  if (!record) return undefined;
  const store = approvePairingRecord(loadPairingStore(), record);
  savePairingStore(store);
  runtimeAllowedUserIds.add(record.userId);
  pendingPairing.delete(normalized);
  return record;
}

function revokePairedUser(userId: number): boolean {
  const result = revokePairingUser(loadPairingStore(), userId);
  savePairingStore(result.store);
  runtimeAllowedUserIds.delete(userId);
  return result.revoked;
}

function getOrCreateSession(ctx: Context): SessionState {
  if (!ctx.chat) throw new Error('Missing chat');
  const plan = planSession(ctx.chat, ctx.message ?? ctx.callbackQuery?.message);
  const threadId = plan.threadId;
  const key = plan.key;
  const existing = sessions.get(key);
  if (existing) {
    existing.chatId = ctx.chat.id;
    existing.chatType = ctx.chat.type;
    existing.messageThreadId = threadId;
    existing.lastActivityAt = Date.now();
    return existing;
  }

  const topic = effectiveConfigFor(ctx);
  const cwd = resolveProjectPath(config.WORKSPACE_ROOT, topic.project ?? '');
  const pi = new PiRpcClient({ piBin: config.PI_BIN, cwd, args: config.piArgs });
  const session: SessionState = {
    key,
    chatId: plan.chatId,
    chatType: plan.chatType,
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
    systemEvents: [],
    botMessageIds: new Set(),
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
  const id = await sendTelegramMessage(session.chatId, text, { keyboard, threadId: session.messageThreadId, plain });
  if (typeof id === 'number') session.botMessageIds.add(id);
  return id;
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

async function sendMediaWithRetry(method: string, send: () => Promise<unknown>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= config.TELEGRAM_SEND_RETRIES; attempt += 1) {
    try {
      await send();
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= config.TELEGRAM_SEND_RETRIES || !isRetryableTelegramSendError(error)) break;
      const retryAfter = telegramRetryAfterMs(error);
      const backoff = retryAfter ?? config.TELEGRAM_SEND_RETRY_BASE_MS * 2 ** attempt;
      console.warn(`${method} failed; retrying in ${backoff}ms`, error);
      await sleep(backoff + Math.floor(Math.random() * 250));
    }
  }
  throw lastError;
}

async function sendOutboundMediaFile(session: SessionState, file: OutboundMediaFile, customCaption?: string): Promise<void> {
  const caption = customCaption ?? `📎 ${file.fileName}`;
  const baseOptions = threadParams(session.messageThreadId);
  switch (file.kind) {
    case 'photo':
      try {
        await sendMediaWithRetry('sendPhoto', () => bot.api.sendPhoto(session.chatId, new InputFile(file.path), { caption, ...baseOptions }));
      } catch (error) {
        if (!isRetryableTelegramSendError(error)) throw error;
        console.warn(`sendPhoto failed for ${file.path}; falling back to sendDocument`, error);
        await sendMediaWithRetry('sendDocument', () => bot.api.sendDocument(session.chatId, new InputFile(file.path), { caption, ...baseOptions }));
      }
      return;
    case 'audio':
      await sendMediaWithRetry('sendAudio', () => bot.api.sendAudio(session.chatId, new InputFile(file.path), { caption, ...baseOptions }));
      return;
    case 'voice':
      await sendMediaWithRetry('sendVoice', () => bot.api.sendVoice(session.chatId, new InputFile(file.path), { caption, ...baseOptions }));
      return;
    case 'video':
      await sendMediaWithRetry('sendVideo', () => bot.api.sendVideo(session.chatId, new InputFile(file.path), { caption, ...baseOptions }));
      return;
    case 'document':
      await sendMediaWithRetry('sendDocument', () => bot.api.sendDocument(session.chatId, new InputFile(file.path), { caption, ...baseOptions }));
      return;
  }
}

function defaultOutboundMediaRoots(): string[] {
  return [
    path.join(homedir(), 'Pictures', 'pi-generated-images'),
    path.join(config.WORKSPACE_ROOT, 'Pictures', 'pi-generated-images'),
  ];
}

function outboundMediaAllowedRoots(): string[] {
  return [...defaultOutboundMediaRoots(), ...config.outboundMediaAllowedRoots];
}

async function executeTelegramAction(session: SessionState, action: TelegramAction, ctx?: Context): Promise<void> {
  if (action.type === 'send_message') {
    await sendSession(session, markdownToTelegramHtml(action.text));
    return;
  }
  if (action.type === 'react') {
    if (ctx) await react(ctx, action.emoji as ReactionTypeEmoji['emoji']);
    return;
  }
  if (action.type === 'buttons') {
    const keyboard = new InlineKeyboard();
    for (const row of action.buttons) {
      for (const label of row) keyboard.text(label, `tg_action:${label.slice(0, 32)}`);
      keyboard.row();
    }
    await sendSession(session, markdownToTelegramHtml(action.text), keyboard);
    return;
  }
  const resolved = resolveTelegramActionFile(action, config.WORKSPACE_ROOT, config.MAX_OUTBOUND_FILE_BYTES, outboundMediaAllowedRoots());
  if (resolved.error || !resolved.file) throw new Error(resolved.error ?? 'Could not resolve telegram-action file');
  await sendOutboundMediaFile(session, { ...resolved.file, kind: action.type.replace('send_', '') as OutboundMediaFile['kind'] }, action.caption);
}

async function executeTelegramActions(session: SessionState, text: string, ctx?: Context): Promise<string> {
  if (!config.TELEGRAM_ACTIONS_ENABLED) return text;
  const parsed = parseTelegramActions(text);
  const errors = [...parsed.errors];
  for (const action of parsed.actions) {
    try {
      await executeTelegramAction(session, action, ctx);
    } catch (error) {
      errors.push(`telegram-action ${action.type} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (errors.length) await sendSession(session, `⚠️ <b>Telegram action issues</b>\n<code>${escapeHtml(errors.join('\n'))}</code>`).catch(console.error);
  return parsed.visibleText;
}

async function sendOutboundMedia(session: SessionState, text: string): Promise<string> {
  const { files, errors } = resolveOutboundMediaFiles({
    text,
    workspaceRoot: config.WORKSPACE_ROOT,
    maxBytes: config.MAX_OUTBOUND_FILE_BYTES,
    extraAllowedRoots: outboundMediaAllowedRoots(),
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

  return executeTelegramActions(session, stripMediaMarkers(text));
}

function envEnabled(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

function sessionSummary(session: SessionState): Record<string, unknown> {
  return {
    key: session.key,
    chatType: session.chatType,
    topic: session.messageThreadId,
    project: displayProject(config.WORKSPACE_ROOT, session.pi.cwd),
    piRunning: session.pi.isRunning,
    streaming: session.isStreaming,
    idleMs: Date.now() - session.lastActivityAt,
    pendingTextChars: session.pendingText.length,
    lastError: session.lastError ? truncateMiddle(session.lastError, 300) : undefined,
  };
}

async function sendDiagnostics(session: SessionState): Promise<void> {
  let currentPiState: unknown;
  try {
    const response = await session.pi.getState();
    currentPiState = response.data ?? response;
  } catch (error) {
    currentPiState = { error: error instanceof Error ? error.message : String(error) };
  }

  const diagnostics = {
    bot: {
      usernames: [...botUsernames],
      transport: isWebhookMode() ? 'webhook' : 'long_polling',
      uptimeMs: Date.now() - startedAt,
    },
    config: {
      workspaceRoot: config.WORKSPACE_ROOT,
      piBin: config.PI_BIN,
      piArgs: config.piArgs.map((arg) => (arg.includes(config.TELEGRAM_BOT_TOKEN) ? '<redacted>' : arg)),
      verboseEvents: config.VERBOSE_EVENTS,
      controlButtons: config.SHOW_CONTROL_BUTTONS,
      typing: config.TELEGRAM_ENABLE_TYPING,
      reactions: config.TELEGRAM_ENABLE_REACTIONS,
      sessionIdleTimeoutMs: config.SESSION_IDLE_TIMEOUT_MS,
      healthcheck: config.HEALTHCHECK_PORT > 0 ? `${config.HEALTHCHECK_HOST}:${config.HEALTHCHECK_PORT}${config.HEALTHCHECK_PATH}` : 'disabled',
      sendRetries: config.TELEGRAM_SEND_RETRIES,
      telegramApiRoot: config.TELEGRAM_API_ROOT,
      telegramFileApiRoot: config.TELEGRAM_FILE_API_ROOT,
      telegramProxy: redactProxyUrl(config.TELEGRAM_PROXY),
      proxy: {
        HTTPS_PROXY: envEnabled('HTTPS_PROXY'),
        HTTP_PROXY: envEnabled('HTTP_PROXY'),
        ALL_PROXY: envEnabled('ALL_PROXY'),
        NO_PROXY: envEnabled('NO_PROXY'),
      },
      allowlists: {
        allowedChatIds: config.allowedChatIds.size,
        allowedUserIds: config.allowedUserIds.size,
        allowedGroupIds: config.allowedGroupIds.size,
        ownerUserIds: config.ownerUserIds.size,
        approverUserIds: config.approverUserIds.size,
      },
    },
    currentSession: sessionSummary(session),
    activeSessions: [...sessions.values()].map(sessionSummary),
    albumsBuffered: albums.size,
    currentPiState,
  };

  await sendSession(session, `<b>Diagnostics</b>\n<code>${escapeHtml(JSON.stringify(diagnostics, null, 2))}</code>`, controlsKeyboard());
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
    uptimeMs: Date.now() - startedAt,
    transport: isWebhookMode() ? 'webhook' : 'long_polling',
    lastActivityAt: new Date(session.lastActivityAt).toISOString(),
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
  const forwardConfig = {
    verboseEvents: config.VERBOSE_EVENTS,
    toolUpdateThrottleMs: config.TOOL_UPDATE_THROTTLE_MS,
    shuttingDown: () => shuttingDown,
  };
  const forwardDeps = {
    send: async (html: string) => {
      await sendSession(session, html, controlsKeyboard());
    },
    flushText: async () => {
      const text = session.pendingText.trim();
      session.pendingText = '';
      const visibleText = await sendOutboundMedia(session, text);
      if (visibleText) await editOrSendPreview(session, visibleText);
    },
    handleAssistantFinal: async (event: Record<string, unknown>) => {
      await handleAssistantFinal(session, assistantMessageFromEvent(event as PiRpcEvent));
    },
    startTyping: () => startTyping(session),
    stopTyping: () => stopTyping(session),
    formatToolArgs,
    escapeHtml,
    truncateMiddle,
    projectLabel: () => displayProject(config.WORKSPACE_ROOT, pi.cwd),
    now: () => Date.now(),
  };

  pi.on('event', (event: PiRpcEvent) => {
    void (async () => {
      const action = await forwardPiEvent(session, event as Record<string, unknown>, forwardConfig, forwardDeps);
      if (action === 'delta') scheduleTextFlush(session);
    })().catch(console.error);
  });

  pi.on('stderr', (text: string) => {
    void forwardPiStderr(session, text, forwardConfig, forwardDeps).catch(console.error);
  });

  pi.on('exit', (info: unknown) => {
    void forwardPiExit(session, info, forwardConfig, forwardDeps).catch(console.error);
  });

  pi.on('error', (error) => {
    forwardPiError(session, error);
  });
}

async function sendPromptToSession(session: SessionState, text: string, images?: RpcImage[], ctx?: Context): Promise<void> {
  if (ctx) await react(ctx, '👀');
  if (session.systemEvents.length) {
    text = prependSystemEvents(text, session.systemEvents.splice(0));
  }
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
  return stripBotMentionByPolicy(text, botUsernames);
}

function shouldProcessText(ctx: Context, text: string): boolean {
  const topic = effectiveConfigFor(ctx);
  return shouldProcessTextByPolicy({
    chat: ctx.chat,
    message: ctx.message,
    text,
    requireMention: topic.requireMention ?? config.TELEGRAM_GROUP_REQUIRE_MENTION,
    botUsernames,
    mentionPatterns: [...config.mentionPatterns, ...topic.mentionRegexes],
  });
}

async function fetchTelegramFile(fileId: string, maxBytes: number): Promise<{ data: Buffer; mimeType: string; filePath?: string }> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) throw new Error('Telegram file path is missing');
  const fileRoot = config.TELEGRAM_FILE_API_ROOT.replace(/\/$/, '');
  const url = `${fileRoot}/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const response = await telegramFetch(config)(url);
  if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) throw new Error(`File too large (${length} bytes)`);
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > maxBytes) throw new Error(`File too large (${arrayBuffer.byteLength} bytes)`);
  return { data: Buffer.from(arrayBuffer), mimeType: response.headers.get('content-type') ?? 'application/octet-stream', filePath: file.file_path };
}

async function imageFromPhoto(message: Message): Promise<{ image: RpcImage; bytes: number }> {
  const photo = message.photo?.at(-1);
  if (!photo) throw new Error('Missing photo');
  if (photo.file_size && photo.file_size > config.MAX_IMAGE_BYTES) throw new Error(`Image too large (${photo.file_size} bytes)`);
  const file = await fetchTelegramFile(photo.file_id, config.MAX_IMAGE_BYTES);
  const mimeType = imageMimeForTelegramPhoto({ headerMime: file.mimeType, filePath: file.filePath, data: file.data });
  return { image: { type: 'image', data: file.data.toString('base64'), mimeType }, bytes: file.data.byteLength };
}

function albumKey(ctx: Context): string {
  if (!ctx.chat || !ctx.message) throw new Error('Missing chat/message');
  return `${ctx.chat.id}:${contextThreadId(ctx) ?? 'root'}:${ctx.message.media_group_id ?? 'burst'}`;
}

function getSessionByAlbumEntry(entry: AlbumEntry): SessionState {
  const existing = sessions.get(entry.sessionKey);
  if (existing) return existing;
  const topic = effectiveTopicConfig(topicConfig, { id: entry.chatId, type: entry.chatType }, entry.messageThreadId);
  const cwd = resolveProjectPath(config.WORKSPACE_ROOT, topic.project ?? '');
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
    systemEvents: [],
    botMessageIds: new Set(),
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

function healthPayload(): Record<string, unknown> {
  const sessionsList = [...sessions.values()];
  return {
    ok: true,
    transport: isWebhookMode() ? 'webhook' : 'long_polling',
    uptimeMs: Date.now() - startedAt,
    botUsernames: [...botUsernames],
    activeSessions: sessionsList.length,
    runningPiSessions: sessionsList.filter((session) => session.pi.isRunning).length,
    streamingSessions: sessionsList.filter((session) => session.isStreaming).length,
    bufferedAlbums: albums.size,
    shuttingDown,
    timestamp: new Date().toISOString(),
  };
}

function startHealthcheckServer(): void {
  if (config.HEALTHCHECK_PORT <= 0 || healthServer) return;
  const healthPath = normalizePath(config.HEALTHCHECK_PATH);
  healthServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'GET' || url.pathname !== healthPath) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not_found' }));
      return;
    }
    res.writeHead(shuttingDown ? 503 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(healthPayload()));
  });
  healthServer.listen(config.HEALTHCHECK_PORT, config.HEALTHCHECK_HOST, () => {
    console.log(`Healthcheck listening on http://${config.HEALTHCHECK_HOST}:${config.HEALTHCHECK_PORT}${healthPath}`);
  });
  healthServer.on('error', (error) => {
    console.error(`Healthcheck server error: ${error instanceof Error ? error.message : String(error)}`);
  });
  healthServer.unref?.();
}

async function stopHealthcheckServer(): Promise<void> {
  if (!healthServer) return;
  const server = healthServer;
  healthServer = null;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function isWebhookMode(): boolean {
  return Boolean(config.TELEGRAM_WEBHOOK_URL.trim());
}

function startWebhookServer(): void {
  if (!isWebhookMode() || webhookServer) return;
  if (config.TELEGRAM_WEBHOOK_PORT <= 0) throw new Error('TELEGRAM_WEBHOOK_PORT must be positive in webhook mode');
  if (!config.TELEGRAM_WEBHOOK_SECRET.trim()) throw new Error('TELEGRAM_WEBHOOK_SECRET is required in webhook mode');
  const webhookPath = normalizePath(config.TELEGRAM_WEBHOOK_PATH);

  webhookServer = createWebhookServer(
    {
      path: webhookPath,
      secret: config.TELEGRAM_WEBHOOK_SECRET,
      maxBodyBytes: config.TELEGRAM_WEBHOOK_MAX_BODY_BYTES,
    },
    (update) => bot.handleUpdate(update as Parameters<typeof bot.handleUpdate>[0]),
  );

  webhookServer.listen(config.TELEGRAM_WEBHOOK_PORT, config.TELEGRAM_WEBHOOK_HOST, () => {
    console.log(`Webhook listening on http://${config.TELEGRAM_WEBHOOK_HOST}:${config.TELEGRAM_WEBHOOK_PORT}${webhookPath}`);
  });
  webhookServer.on('error', (error) => {
    console.error(`Webhook server error: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function stopWebhookServer(): Promise<void> {
  if (!webhookServer) return;
  const server = webhookServer;
  webhookServer = null;
  await new Promise<void>((resolve) => server.close(() => resolve()));
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
      '/diagnostics - owner-only verbose diagnostics',
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

bot.command('pair', async (ctx) => {
  const match = ctx.match.trim();
  const [action, value] = match.split(/\s+/).filter(Boolean);

  if (!action || action === 'request') {
    if (!config.TELEGRAM_PAIRING_ENABLED) {
      await ctx.reply('Pairing is disabled. Ask the bridge owner to configure TELEGRAM_PAIRING_ENABLED=true.', replyParams(ctx));
      return;
    }
    if (isAllowed(ctx)) {
      await ctx.reply('You are already allowed to use this bridge.', replyParams(ctx));
      return;
    }
    const record = createPairingRequest(ctx);
    await ctx.reply(`Pairing request created. Send this code to the bridge owner: ${record.code}\nExpires: ${new Date(record.expiresAt).toISOString()}`, replyParams(ctx));
    return;
  }

  if (!requireAllowed(ctx) || !requireOwner(ctx)) return;

  if (action === 'approve') {
    if (!value) {
      await ctx.reply('Usage: /pair approve <code>', replyParams(ctx));
      return;
    }
    const record = approvePairing(value);
    await ctx.reply(record ? `Approved user ${record.userId}${record.username ? ` (@${record.username})` : ''}.` : 'Pairing code not found or expired.', replyParams(ctx));
    return;
  }

  if (action === 'list') {
    pruneExpiredPairings();
    const store = loadPairingStore();
    const summary = {
      enabled: config.TELEGRAM_PAIRING_ENABLED,
      file: pairingFilePath(),
      allowedUserIds: store.allowedUserIds,
      pending: [...pendingPairing.values()].map((item) => ({ code: item.code, userId: item.userId, username: item.username, expiresAt: new Date(item.expiresAt).toISOString() })),
    };
    await sendTelegramMessage(ctx.chat!.id, `<b>Pairing</b>\n<code>${escapeHtml(JSON.stringify(summary, null, 2))}</code>`, { threadId: contextThreadId(ctx) });
    return;
  }

  if (action === 'revoke') {
    const userId = Number(value);
    if (!Number.isFinite(userId)) {
      await ctx.reply('Usage: /pair revoke <userId>', replyParams(ctx));
      return;
    }
    await ctx.reply(revokePairedUser(userId) ? `Revoked paired user ${userId}.` : `User ${userId} was not in the paired allowlist.`, replyParams(ctx));
    return;
  }

  await ctx.reply('Usage: /pair [request] | /pair approve <code> | /pair list | /pair revoke <userId>', replyParams(ctx));
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

bot.command('diagnostics', async (ctx) => {
  if (!requireAllowed(ctx) || !requireOwner(ctx)) return;
  await sendDiagnostics(getOrCreateSession(ctx));
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

bot.on('message:sticker', async (ctx) => {
  if (!requireAllowed(ctx)) return;
  const session = getOrCreateSession(ctx);
  const sticker = ctx.message.sticker;
  if (sticker.is_animated || sticker.is_video) {
    await ctx.reply('Sticker type is not supported yet. Static WEBP stickers are supported.', threadParams(session.messageThreadId));
    return;
  }
  try {
    const file = await fetchTelegramFile(sticker.file_id, config.MAX_IMAGE_BYTES);
    const mimeType = imageMimeForTelegramPhoto({ headerMime: file.mimeType, filePath: file.filePath, data: file.data, fallback: 'image/webp' });
    const prompt = `Please inspect this Telegram sticker${sticker.emoji ? ` (${sticker.emoji})` : ''}.`;
    await sendPromptToPi(ctx, prompt, [{ type: 'image', data: file.data.toString('base64'), mimeType }]);
  } catch (error) {
    await ctx.reply(`Sticker handling failed: ${error instanceof Error ? error.message : String(error)}`, threadParams(session.messageThreadId));
  }
});

bot.on('message_reaction', async (ctx) => {
  if (config.TELEGRAM_REACTION_NOTIFICATIONS === 'off') return;
  const reaction = ctx.update.message_reaction;
  if (!reaction?.chat) return;
  const key = sessionKeyFor(reaction.chat.id, isGroupChatType(reaction.chat.type));
  const session = sessions.get(key);
  if (!session) return;
  const emoji = reaction.new_reaction?.find((item) => item.type === 'emoji')?.emoji;
  if (!emoji) return;
  const isOwnMessage = session.botMessageIds.has(reaction.message_id);
  if (!shouldRecordReaction(config.TELEGRAM_REACTION_NOTIFICATIONS as ReactionMode, { isOwnMessage })) return;
  session.systemEvents.push(formatReactionNote({ emoji, userId: reaction.user?.id, username: reaction.user?.username, messageId: reaction.message_id, isOwnMessage }));
});

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

bot.on('message:audio', async (ctx) => {
  if (!requireAllowed(ctx)) return;
  const session = getOrCreateSession(ctx);
  const audio = ctx.message.audio;
  if (audio.file_size && audio.file_size > config.MAX_AUDIO_BYTES) {
    await ctx.reply(`Audio too large (${audio.file_size} bytes). MAX_AUDIO_BYTES=${config.MAX_AUDIO_BYTES}`, threadParams(session.messageThreadId));
    return;
  }
  try {
    const file = await fetchTelegramFile(audio.file_id, config.MAX_AUDIO_BYTES);
    const filePath = await saveTelegramMediaFile({ data: file.data, workspaceRoot: config.WORKSPACE_ROOT, fileName: audio.file_name ?? `${audio.file_unique_id}.mp3` });
    await ctx.reply('🎧 Audio saved.', threadParams(session.messageThreadId));
    await sendPromptToPi(ctx, mediaSavedPrompt('audio file', filePath, ctx.message.caption?.trim()));
  } catch (error) {
    await ctx.reply(`Audio handling failed: ${error instanceof Error ? error.message : String(error)}`, threadParams(session.messageThreadId));
  }
});

bot.on('message:video', async (ctx) => {
  if (!requireAllowed(ctx)) return;
  const session = getOrCreateSession(ctx);
  const video = ctx.message.video;
  if (video.file_size && video.file_size > config.MAX_VIDEO_BYTES) {
    await ctx.reply(`Video too large (${video.file_size} bytes). MAX_VIDEO_BYTES=${config.MAX_VIDEO_BYTES}`, threadParams(session.messageThreadId));
    return;
  }
  try {
    const file = await fetchTelegramFile(video.file_id, config.MAX_VIDEO_BYTES);
    const ext = path.extname(file.filePath ?? '') || '.mp4';
    const filePath = await saveTelegramMediaFile({ data: file.data, workspaceRoot: config.WORKSPACE_ROOT, fileName: `${video.file_unique_id}${ext}` });
    await ctx.reply('🎬 Video saved.', threadParams(session.messageThreadId));
    await sendPromptToPi(ctx, mediaSavedPrompt('video file', filePath, ctx.message.caption?.trim()));
  } catch (error) {
    await ctx.reply(`Video handling failed: ${error instanceof Error ? error.message : String(error)}`, threadParams(session.messageThreadId));
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
    if (!isTextDocumentExtension(ext)) {
      const filePath = await saveTelegramMediaFile({ data: file.data, workspaceRoot: config.WORKSPACE_ROOT, fileName });
      await ctx.reply(`📎 Document saved at ${filePath}`, threadParams(session.messageThreadId));
      await sendPromptToPi(ctx, mediaSavedPrompt('document', filePath, ctx.message.caption?.trim()));
      return;
    }
    const content = file.data.toString('utf8');
    const caption = ctx.message.caption?.trim();
    const prompt = [`Please inspect this document: ${fileName}`, '', '```', truncateMiddle(content, 50_000), '```', caption ? `\nUser note: ${caption}` : ''].join('\n');
    await ctx.reply(`📄 Document received. Supported text types include: ${supportedTextDocumentExtensions().slice(0, 12).join(', ')}...`, threadParams(session.messageThreadId));
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
  await stopHealthcheckServer();
  await stopWebhookServer();
  for (const album of albums.values()) clearTimeout(album.timer);
  albums.clear();
  for (const session of sessions.values()) stopSession(session);
  sessions.clear();
  await bot.stop().catch(() => undefined);
}

process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));

if (isWebhookMode()) {
  await bot.api.setWebhook(`${config.TELEGRAM_WEBHOOK_URL.replace(/\/$/, '')}${normalizePath(config.TELEGRAM_WEBHOOK_PATH)}`, {
    secret_token: config.TELEGRAM_WEBHOOK_SECRET,
    drop_pending_updates: false,
  });
} else {
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: false });
  } catch (error) {
    console.warn(`deleteWebhook failed (continuing): ${error instanceof Error ? error.message : String(error)}`);
  }
}

loadRuntimeAllowlist();

const me = await bot.api.getMe();
botUsernames.add(me.username.toLowerCase());

await bot.api.setMyCommands([
  { command: 'help', description: 'Show help' },
  { command: 'project', description: 'Show or switch project' },
  { command: 'pair', description: 'Request or manage pairing' },
  { command: 'sessions', description: 'Show active sessions' },
  { command: 'new', description: 'Start a fresh pi session' },
  { command: 'status', description: 'Show pi session state' },
  { command: 'diagnostics', description: 'Owner diagnostics' },
  { command: 'abort', description: 'Abort current pi run' },
  { command: 'steer', description: 'Steer current run' },
  { command: 'followup', description: 'Queue follow-up message' },
  { command: 'thinking', description: 'Set thinking level' },
]).catch((error) => console.warn(`setMyCommands failed: ${error instanceof Error ? error.message : String(error)}`));

startIdleSweep();
startHealthcheckServer();
startWebhookServer();

console.log(`pi-telegram-bridge-plus started as @${me.username}. Workspace: ${config.WORKSPACE_ROOT}`);
if (isWebhookMode()) {
  console.log(`Telegram bot @${me.username} is using webhook mode.`);
} else {
  await bot.start({
    onStart: (botInfo) => {
      console.log(`Telegram bot @${botInfo.username} is polling.`);
    },
  });
}
