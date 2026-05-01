# pi-telegram-bridge-plus

A Telegram remote control for [pi](https://pi.dev) coding agent using pi's native `--mode rpc` protocol.

> Status: beta / local-first. This bridge can trigger a local coding agent from Telegram, so keep allowlists tight and never commit your `.env` file.

This `plus` variant was created beside the original `pi-telegram-bridge` so the currently running bridge is not affected while new functionality is developed.

## Highlights

- Native pi RPC integration (`pi --mode rpc`).
- Telegram long polling; no public URL required.
- Backwards-compatible private chat allowlist via `TELEGRAM_ALLOWED_CHAT_IDS`.
- New user/group/owner allowlists for safer multi-chat use.
- Per-chat/per-topic session isolation with a separate `pi --mode rpc` client per session.
- Owner-controlled session listing/closing plus optional idle session cleanup.
- Safe project switching under `WORKSPACE_ROOT`; `/project` is session-scoped.
- Telegram group support with mention/reply gating.
- Telegram forum topic routing using `message_thread_id`.
- Session-aware inline controls for Status / New / Abort.
- Text prompts.
- Single-photo and album image prompts forwarded to pi as RPC images.
- Optional voice message transcription through `VOICE_TRANSCRIBE_CMD`.
- Text document ingestion for common source/text formats.
- Outbound local file delivery via `MEDIA:/absolute/path` markers in pi responses.
- Message-edit streaming preview for assistant deltas.
- Telegram command menu registration.
- Optional typing indicators and reactions.
- Telegram send retry/backoff for flood control and transient send failures.
- Owner-only `/diagnostics` for transport/session/pi/proxy troubleshooting.
- Basic HTML fallback and Telegram message splitting.

## Requirements

- Node.js 20+
- pi installed and authenticated (`pi` works in your terminal)
- Telegram bot token from [@BotFather](https://t.me/BotFather)
- Your numeric Telegram user/chat ID

## Quick start

```bash
cd pi-telegram-bridge-plus
npm install
cp .env.example .env
$EDITOR .env
npm run dev
```

For production-style usage:

```bash
npm run build
npm start
```

## Configuration

See [`.env.example`](.env.example).

Minimal private-chat config:

```env
TELEGRAM_BOT_TOKEN=123456:replace-me
TELEGRAM_ALLOWED_CHAT_IDS=123456789
WORKSPACE_ROOT=/Users/you/Workspace
PI_BIN=pi
```

Recommended group-capable config:

```env
TELEGRAM_BOT_TOKEN=123456:replace-me
TELEGRAM_ALLOWED_USER_IDS=123456789
TELEGRAM_ALLOWED_GROUP_IDS=-1001234567890
TELEGRAM_OWNER_USER_IDS=123456789
TELEGRAM_GROUP_REQUIRE_MENTION=true
WORKSPACE_ROOT=/Users/you/Workspace
```

Important permissions:

| Setting | Purpose |
| --- | --- |
| `TELEGRAM_ALLOWED_CHAT_IDS` | Legacy private chat IDs; still works for single-user DM setup |
| `TELEGRAM_ALLOWED_USER_IDS` | Telegram users allowed to talk to the bot |
| `TELEGRAM_ALLOWED_GROUP_IDS` | Groups/supergroups where the bot may operate |
| `TELEGRAM_OWNER_USER_IDS` | Users allowed to run owner commands like `/project`, `/abort`, `/thinking` |
| `TELEGRAM_APPROVER_USER_IDS` | Reserved for future exec/tool approval UI |

If `TELEGRAM_OWNER_USER_IDS` is unset, allowed users become owners for backwards-compatible single-user behavior.

## Bot commands

| Command | Description |
| --- | --- |
| `/start`, `/help` | Show help and control buttons |
| `/project` | Show current session project and workspace root |
| `/project <path>` | Owner-only; switch this chat/topic session project under `WORKSPACE_ROOT` |
| `/sessions` | Owner-only; show active Telegram sessions |
| `/sessions cleanup` | Owner-only; close idle non-streaming sessions now |
| `/sessions close <key\|current>` | Owner-only; close a session and stop its pi subprocess |
| `/new` | Restart this chat/topic's pi RPC process for a fresh session |
| `/status` | Show pi RPC/session state |
| `/diagnostics` | Owner-only; show verbose bridge/session/pi/proxy diagnostics |
| `/abort` | Owner-only; abort current pi run |
| `/steer <text>` | Queue steering instruction during a run |
| `/followup <text>` | Queue follow-up after current run |
| `/thinking <level>` | Owner-only; set pi thinking level if supported |

Any normal private-chat text message is sent as a pi prompt. In groups, text is processed only when group policy allows it and the message mentions the bot, replies to the bot, is a slash command, or matches `TELEGRAM_MENTION_PATTERNS`.

Set `SESSION_IDLE_TIMEOUT_MS` to automatically close idle, non-streaming sessions and stop their pi subprocesses. The default `0` disables automatic cleanup. Owners can also run `/sessions cleanup` or `/sessions close current` manually.

Telegram sends are retried for flood-control and transient failures. Tune this with `TELEGRAM_SEND_RETRIES` and `TELEGRAM_SEND_RETRY_BASE_MS`.

## Media

### Photos and albums

Send a Telegram photo with an optional caption to forward the image to pi. Albums with `media_group_id` are debounced and forwarded as one prompt.

### Voice

Voice support is command-hook based. Configure:

```env
VOICE_TRANSCRIBE_CMD="your-transcriber --flag"
```

The downloaded `.ogg` path is appended as the final argument. The command must print the transcript to stdout.

### Documents

Supported text-like document extensions are injected into the prompt:

- `.txt`, `.md`, `.json`, `.csv`, `.log`
- `.ts`, `.js`, `.py`, `.yaml`, `.yml`

Other document types are rejected for now.

### Outbound files

If pi replies with a line like this, the bridge will try to send the referenced local file back to Telegram:

```text
MEDIA:/absolute/path/under/workspace/report.pdf
```

Rules:

- Paths must be absolute.
- Files must exist under `WORKSPACE_ROOT`.
- File size must be at or below `MAX_OUTBOUND_FILE_BYTES`.
- Image extensions are sent as photos, audio/video extensions as media, and everything else as documents.
- Invalid markers are reported back to the chat without exposing bridge configuration.

## Architecture

```text
Telegram app
  ↓ long polling
pi-telegram-bridge-plus
  ↓ session manager
pi --mode rpc per chat/topic session
  ↓
local workspace
```

The bridge intentionally does not expose an HTTP server in this phase.

## Safety notes

This project can make an AI agent edit files and run shell commands on your machine.

Recommended:

- Never commit `.env`; it contains your Telegram bot token and allowlists.
- If a bot token is exposed, revoke/regenerate it in BotFather immediately.
- Use a dedicated Telegram bot token.
- Keep allowlists narrow.
- Set `WORKSPACE_ROOT` to a specific workspace directory, not `/` or `$HOME`.
- Use group mode only with `TELEGRAM_GROUP_REQUIRE_MENTION=true` unless you really want always-on group behavior.
- Consider running pi in a container or restricted environment for untrusted work.
- Do not put secrets in Telegram messages.

## Current limitations

- No webhook mode yet.
- No dynamic pairing yet.
- Outbound file/media delivery currently supports local files under `WORKSPACE_ROOT` via `MEDIA:/absolute/path` markers; structured pi RPC media events are not supported yet.
- No per-tool approval UI yet; this depends on pi RPC approval event support.
- `/diagnostics` is Telegram-command based; there is no HTTP healthcheck endpoint yet.
- Voice transcription requires a user-provided local command.

## Development

```bash
npm run typecheck
npm run build
npm run dev
```

Project layout:

```text
src/config.ts            env parsing and access-control config
src/pi-rpc.ts            pi RPC JSONL subprocess client
src/project.ts           workspace-safe project path handling
src/telegram-format.ts   escaping/splitting helpers
src/index.ts             Telegram bot entrypoint and session manager
```

## License

MIT
