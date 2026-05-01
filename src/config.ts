import dotenv from 'dotenv';
import { z } from 'zod';

// Local bridge config should win over shell-exported variables by default.
// Otherwise a TELEGRAM_BOT_TOKEN from another project can silently hijack polling.
dotenv.config({ override: process.env.DOTENV_OVERRIDE !== 'false' });

const boolFromEnv = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return value;
}, z.boolean());

const schema = z.object({
  DOTENV_OVERRIDE: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().min(1),

  // Legacy private-chat allowlist. Kept for backwards compatibility.
  TELEGRAM_ALLOWED_CHAT_IDS: z.string().default(''),

  // New identity-aware access controls.
  TELEGRAM_ALLOWED_USER_IDS: z.string().default(''),
  TELEGRAM_ALLOWED_GROUP_IDS: z.string().default(''),
  TELEGRAM_OWNER_USER_IDS: z.string().default(''),
  TELEGRAM_APPROVER_USER_IDS: z.string().default(''),
  TELEGRAM_GROUP_REQUIRE_MENTION: boolFromEnv.default(true),
  TELEGRAM_MENTION_PATTERNS: z.string().default(''),
  TELEGRAM_ENABLE_REACTIONS: boolFromEnv.default(false),
  TELEGRAM_ENABLE_TYPING: boolFromEnv.default(true),
  TELEGRAM_SEND_RETRIES: z.coerce.number().int().nonnegative().default(3),
  TELEGRAM_SEND_RETRY_BASE_MS: z.coerce.number().int().positive().default(750),

  WORKSPACE_ROOT: z.string().default(process.cwd()),
  PI_BIN: z.string().default('pi'),
  PI_ARGS: z.string().default(''),
  PI_MODEL: z.string().optional(),
  PI_PROVIDER: z.string().optional(),
  PI_THINKING: z.string().optional(),
  PI_SESSION_DIR: z.string().optional(),

  MAX_TELEGRAM_CHARS: z.coerce.number().int().positive().default(3500),
  MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(8_000_000),
  MAX_DOCUMENT_BYTES: z.coerce.number().int().positive().default(10_000_000),
  MAX_VOICE_BYTES: z.coerce.number().int().positive().default(20_000_000),
  MAX_ALBUM_IMAGES: z.coerce.number().int().positive().default(10),
  MAX_OUTBOUND_FILE_BYTES: z.coerce.number().int().positive().default(20_000_000),

  VERBOSE_EVENTS: boolFromEnv.default(false),
  SHOW_CONTROL_BUTTONS: boolFromEnv.default(false),
  TOOL_UPDATE_THROTTLE_MS: z.coerce.number().int().nonnegative().default(1200),
  TEXT_UPDATE_THROTTLE_MS: z.coerce.number().int().nonnegative().default(1200),
  ALBUM_DEBOUNCE_MS: z.coerce.number().int().nonnegative().default(850),
  TYPING_INTERVAL_MS: z.coerce.number().int().positive().default(4500),
  // 0 disables automatic idle session cleanup. Sessions that are actively streaming are never cleaned up.
  SESSION_IDLE_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(0),
  SESSION_IDLE_SWEEP_MS: z.coerce.number().int().positive().default(60_000),

  // Optional local healthcheck HTTP endpoint. Disabled by default when port is 0.
  HEALTHCHECK_HOST: z.string().default('127.0.0.1'),
  HEALTHCHECK_PORT: z.coerce.number().int().nonnegative().default(0),
  HEALTHCHECK_PATH: z.string().default('/healthz'),

  // Optional command hook. The downloaded voice file path is appended as the last arg.
  // Example: VOICE_TRANSCRIBE_CMD='whisper-cli --model base --file'
  VOICE_TRANSCRIBE_CMD: z.string().default(''),
});

export type Config = z.infer<typeof schema> & {
  allowedChatIds: Set<number>;
  allowedUserIds: Set<number>;
  allowedGroupIds: Set<number>;
  ownerUserIds: Set<number>;
  approverUserIds: Set<number>;
  mentionPatterns: RegExp[];
  piArgs: string[];
};

function splitCsvNumbers(value: string): Set<number> {
  return new Set(
    value
      .split(',')
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isFinite(v)),
  );
}

export function splitArgs(value: string): string[] {
  // Minimal shell-like split for common flags. Users needing complex quoting should prefer dedicated env vars.
  return value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^["']|["']$/g, '')) ?? [];
}

function compileMentionPatterns(value: string): RegExp[] {
  return value
    .split('\n')
    .flatMap((line) => line.split(','))
    .map((v) => v.trim())
    .filter(Boolean)
    .flatMap((pattern) => {
      try {
        return [new RegExp(pattern, 'i')];
      } catch {
        console.warn(`Ignoring invalid TELEGRAM_MENTION_PATTERNS entry: ${pattern}`);
        return [];
      }
    });
}

export function loadConfig(): Config {
  const parsed = schema.parse(process.env);
  const allowedChatIds = splitCsvNumbers(parsed.TELEGRAM_ALLOWED_CHAT_IDS);
  const allowedUserIds = splitCsvNumbers(parsed.TELEGRAM_ALLOWED_USER_IDS);
  const allowedGroupIds = splitCsvNumbers(parsed.TELEGRAM_ALLOWED_GROUP_IDS);
  const ownerUserIds = splitCsvNumbers(parsed.TELEGRAM_OWNER_USER_IDS);
  const approverUserIds = splitCsvNumbers(parsed.TELEGRAM_APPROVER_USER_IDS);

  // Backwards compatibility: legacy private chat IDs are also user IDs for DMs/owner commands.
  for (const id of allowedChatIds) {
    if (id > 0) allowedUserIds.add(id);
  }
  if (ownerUserIds.size === 0) {
    for (const id of allowedUserIds) ownerUserIds.add(id);
  }
  if (approverUserIds.size === 0) {
    for (const id of ownerUserIds) approverUserIds.add(id);
  }

  if (allowedChatIds.size === 0 && allowedUserIds.size === 0 && allowedGroupIds.size === 0) {
    throw new Error('Configure at least one Telegram allowlist: TELEGRAM_ALLOWED_CHAT_IDS, TELEGRAM_ALLOWED_USER_IDS, or TELEGRAM_ALLOWED_GROUP_IDS');
  }

  const piArgs = splitArgs(parsed.PI_ARGS);
  if (parsed.PI_PROVIDER) piArgs.push('--provider', parsed.PI_PROVIDER);
  if (parsed.PI_MODEL) piArgs.push('--model', parsed.PI_MODEL);
  if (parsed.PI_THINKING) piArgs.push('--thinking', parsed.PI_THINKING);
  if (parsed.PI_SESSION_DIR) piArgs.push('--session-dir', parsed.PI_SESSION_DIR);

  return {
    ...parsed,
    allowedChatIds,
    allowedUserIds,
    allowedGroupIds,
    ownerUserIds,
    approverUserIds,
    mentionPatterns: compileMentionPatterns(parsed.TELEGRAM_MENTION_PATTERNS),
    piArgs,
  };
}
