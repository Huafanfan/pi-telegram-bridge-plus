# pi-telegram-bridge TODO / Roadmap

This roadmap compares the current lightweight bridge with mature Telegram gateway implementations in OpenClaw and Hermes Agent, then scopes improvements for `pi-telegram-bridge` while preserving its main goal: a local-first Telegram remote control for `pi --mode rpc`.

## Guiding principles

- Keep the bridge small and pi-native; avoid turning it into a full multi-platform gateway.
- Prioritize features that improve daily reliability and remote coding workflow.
- Keep security fail-closed: unauthorized users/groups must not be able to trigger pi.
- Prefer incremental changes with clear tests over broad rewrites.
- Preserve current single-user private-chat behavior as the default.

## Current baseline

Already implemented:

- Telegram long polling via grammY.
- Private chat allowlist using `TELEGRAM_ALLOWED_CHAT_IDS`.
- Persistent local `pi --mode rpc` subprocess.
- Safe `/project` switching under `WORKSPACE_ROOT`.
- Commands: `/project`, `/new`, `/status`, `/abort`, `/steer`, `/followup`, `/thinking`.
- Text prompts.
- Telegram photo prompts forwarded to pi as RPC images.
- Basic pi event forwarding: agent start/end, tool start, tool errors, assistant deltas.
- Telegram HTML escaping and message splitting.
- launchd/systemd deployment examples.
- GitHub Actions CI.

Known limitations:

- One pi process/session per bridge instance.
- One global `homeChatId`; multiple chats/users can collide.
- No group/topic-aware routing.
- No voice transcription.
- No document/audio/video/sticker handling.
- No per-tool approval UI.
- No message-edit streaming; deltas are sent as new messages.
- Limited Telegram polling/network recovery.
- No dynamic pairing or role-based permissions.
- No outbound file/media delivery.

---

## Phase 1 — Safe multi-chat/session foundation

Goal: make the bridge safe and predictable beyond a single private chat, without changing the default UX.

### 1.1 Session manager

- [x] Replace global `homeChatId`, `pendingText`, `lastAssistantFinal`, and tool throttling state with per-session state.
- [x] Introduce a stable Telegram session key:
  - private chat: `telegram:chat:<chatId>`
  - group: `telegram:group:<chatId>`
  - forum topic: `telegram:group:<chatId>:topic:<messageThreadId>`
- [x] Maintain `Map<string, SessionState>` where `SessionState` includes:
  - `chatId`
  - optional `messageThreadId`
  - `PiRpcClient`
  - `cwd`
  - pending streaming text buffer
  - last assistant final text
  - last tool update timestamp
  - last activity timestamp
- [x] Keep current behavior as default by creating exactly one session for a private chat.
- [x] Add idle shutdown or explicit `/sessions` cleanup later if needed; do not over-optimize first pass.
  - Added `SESSION_IDLE_TIMEOUT_MS`, `SESSION_IDLE_SWEEP_MS`, `/sessions cleanup`, and `/sessions close <key|current>`.

Acceptance criteria:

- Two authorized chats can send prompts without overwriting each other's state.
- `/project` in one chat does not change another chat's project.
- pi events route back to the originating chat/session.

### 1.2 Group and topic support

- [x] Read `message_thread_id` from incoming Telegram updates.
- [x] Include `message_thread_id` when replying inside forum topics.
- [x] Treat Telegram general topic (`thread_id=1`) carefully; sends omit thread id for general topic.
- [x] Add group configuration:
  - `TELEGRAM_ALLOWED_GROUP_IDS`
  - `TELEGRAM_ALLOWED_USER_IDS`
  - `TELEGRAM_GROUP_REQUIRE_MENTION=true` by default
- [x] In groups, only process messages when one of these is true:
  - slash command
  - direct `@botusername` mention
  - reply to bot message
  - configured mention regex/wake phrase matches
- [x] Strip bot mentions from text before sending to pi.

Acceptance criteria:

- Bot can be added to an allowed group without responding to normal chatter.
- Mentioning/replying to the bot triggers pi.
- Forum topic replies stay in the same topic.

### 1.3 Permission model hardening

- [x] Split permissions by identity type:
  - `TELEGRAM_ALLOWED_CHAT_IDS`: legacy compatibility
  - `TELEGRAM_ALLOWED_USER_IDS`: users allowed to talk to the bot
  - `TELEGRAM_ALLOWED_GROUP_IDS`: groups where the bot may operate
  - `TELEGRAM_OWNER_USER_IDS`: users allowed to run owner commands
  - `TELEGRAM_APPROVER_USER_IDS`: users allowed to approve sensitive actions later
- [x] Keep `TELEGRAM_ALLOWED_CHAT_IDS` working for private chats to avoid breaking existing setup.
- [x] Require owner permission for high-impact commands:
  - `/project`
  - `/thinking`
  - `/abort`
  - future `/config`, `/pair`, approval actions
- [x] Validate `callbackQuery.from.id` for inline buttons, not just chat id.
- [x] Add clear unauthorized messages that reveal no sensitive config.

Acceptance criteria:

- A user in an allowed group but not in `TELEGRAM_ALLOWED_USER_IDS` cannot trigger pi unless group policy explicitly allows it.
- Unauthorized callback button clicks are rejected.
- Existing single-user `.env` continues to work.

### 1.4 Polling and subprocess reliability

- [x] On startup, call Telegram `deleteWebhook({ drop_pending_updates: false })` before long polling.
- [x] Detect and explain `409 Conflict: terminated by other getUpdates request`. (Actionable log now points to another process using the same bot token; full polling supervisor still pending.)
- [ ] Add retry/backoff for transient Telegram polling/network errors. (Pending deeper polling supervisor.)
- [x] Add handling for Telegram `retry_after` flood control on sends. (Implemented in the send retry wrapper with `TELEGRAM_SEND_RETRIES` and `TELEGRAM_SEND_RETRY_BASE_MS`.)
- [x] Add pi RPC restart policy:
  - if pi exits while idle, restart on next prompt
  - if pi exits during a run, notify the session and mark state unhealthy
- [x] Add graceful shutdown for all pi subprocesses on process exit.

Acceptance criteria:

- Bridge gives actionable error when another bot instance uses the same token.
- Temporary Telegram network failures do not permanently kill the bridge.
- A crashed idle pi process is restarted on the next prompt.

---

## Phase 2 — Telegram UX and media support

Goal: make daily mobile usage much smoother.

### 2.1 Message-edit streaming

- [x] Replace repeated assistant delta messages with one editable preview message per session/run.
- [x] Throttle `editMessageText` updates, default around 1000-1800 ms.
- [x] Fall back to sending a final message if edit fails or preview grows too large.
- [x] Avoid duplicate final answer when `message_end` arrives after streamed deltas.
- [x] Keep current quiet default for tool events unless `VERBOSE_EVENTS=true`.
- [ ] Optionally merge tool progress into the preview when verbose mode is enabled.

Acceptance criteria:

- Long assistant responses appear as an updating message instead of many separate messages.
- Final answer is sent exactly once.
- Parse/edit failures degrade to plain final send.

### 2.2 Better Telegram formatting

- [x] Retry failed HTML sends as plain text.
- [ ] Improve message splitting around code blocks and HTML tags.
- [ ] Use Telegram-safe length accounting, ideally UTF-16 aware.
- [x] Respect Telegram caption limits when sending media later. (Outbound media MVP uses short generated captions.)
- [ ] Consider converting markdown tables to mobile-friendly bullet lists.

Acceptance criteria:

- Telegram parse errors do not drop messages.
- Large code-heavy responses remain readable.

### 2.3 Voice message input

- [x] Handle `message:voice`.
- [x] Download voice `.ogg` file with size limit.
- [x] Add configurable STT backend:
  - local command hook first, e.g. `VOICE_TRANSCRIBE_CMD`
  - optional OpenAI/Groq/faster-whisper adapter later
- [x] Send transcription to pi as the prompt.
- [x] Include a short acknowledgement in Telegram, e.g. `🎙️ Transcribed voice message`.

Acceptance criteria:

- Sending a voice note prompts pi with transcribed text.
- Oversized or failed voice messages return a clear error.

### 2.4 Document and text-file input

- [x] Handle `message:document`.
- [x] Download files with file size limits; text content is injected directly without persistent cache.
- [x] Support `.txt`, `.md`, `.json`, `.csv`, `.log` by injecting text content into the prompt.
- [x] For unsupported files, pass metadata and local path only if pi can consume it; otherwise reply with supported types.
- [x] Protect against path traversal and unsafe filenames by not writing document filenames to disk in phase 2 implementation.
- [x] Add configurable `MAX_DOCUMENT_BYTES`.

Acceptance criteria:

- A small text/markdown document can be sent to pi for review.
- Large/unsupported files are rejected safely and clearly.

### 2.5 Media groups and multi-image prompts

- [x] Detect `media_group_id`.
- [x] Debounce album items for around 800 ms.
- [x] Merge all images and captions into one pi prompt.
- [x] Preserve image order where possible.
- [x] Apply total media size limits.

Acceptance criteria:

- Sending a Telegram album creates one pi turn, not N separate turns.

### 2.6 Command menu and controls

- [x] Register Telegram command menu via `setMyCommands`.
- [x] Keep commands under Telegram limits.
- [x] Add `/sessions` to show active sessions once session manager exists.
- [ ] Add `/model` or `/config` only if pi RPC supports runtime switching cleanly.
- [x] Improve inline controls to be session-aware:
  - Status
  - New
  - Abort
  - optionally Project

Acceptance criteria:

- Telegram `/` menu shows supported commands.
- Inline buttons affect the correct session.

### 2.7 Typing indicators and reactions

- [x] Send `typing` chat action while pi is processing.
- [x] Optionally react to the triggering message:
  - 👀 queued/processing
  - ✅ complete
  - ❌ error
- [x] Make reactions configurable because not all chats allow them.

Acceptance criteria:

- User gets lightweight feedback without extra chat noise.

---

## Phase 3 — Safety, approvals, and richer delivery

Goal: close the biggest safety/feature gaps compared with mature gateways.

### 3.1 Per-tool / exec approval UI

- [ ] Investigate pi RPC support for approval request/response events.
- [ ] If pi exposes approval events, render Telegram inline buttons:
  - Allow once
  - Allow for session
  - Allow always
  - Deny
- [ ] Authorize approval clicks using `TELEGRAM_APPROVER_USER_IDS` or owners.
- [ ] Preserve originating chat/topic for approval prompts.
- [ ] Expire stale approvals.
- [ ] If pi RPC does not support approvals, document this as a pi-side requirement and keep bridge-side UI deferred.

Acceptance criteria:

- Dangerous tool execution can be approved/denied from Telegram when pi supports it.
- Unauthorized users cannot approve commands.

### 3.2 Outbound media and generated files

- [x] Define a simple convention for pi responses, e.g. `MEDIA:/absolute/path` or structured RPC event if available.
  - MVP supports line-based `MEDIA:/absolute/path` markers.
- [x] Send existing local files back to Telegram as:
  - photo for images
  - document for general files
  - audio/voice for audio
  - video for video
- [x] Add path allowlist rooted under workspace/session output directories.
  - MVP restricts files to `WORKSPACE_ROOT`.
- [ ] Give helpful errors for container-only paths like `/workspace/...`.
- [x] Add `MAX_OUTBOUND_FILE_BYTES`.

Acceptance criteria:

- If pi creates a report/image/file, the bridge can send it back as a Telegram attachment.

### 3.3 Dynamic pairing and allowlist management

- [x] Add optional pairing mode for private chats:
  - unknown user receives one-time code
  - owner approves code via CLI or Telegram command
  - approved user stored in local JSON allowlist
- [x] Add commands:
  - `/pair approve <code>`
  - `/pair list`
  - `/pair revoke <userId>`
- [x] Protect pairing approval as owner-only.
- [x] Add rate limiting for pairing code generation and attempts.
  - Existing pending request is reused until expiry; code TTL is configurable.

Acceptance criteria:

- New trusted users can be added without editing `.env` and restarting.
- Pairing cannot be brute-forced trivially.

### 3.4 Webhook mode

- [x] Add optional webhook transport:
  - `TELEGRAM_WEBHOOK_URL`
  - `TELEGRAM_WEBHOOK_SECRET`
  - `TELEGRAM_WEBHOOK_HOST`
  - `TELEGRAM_WEBHOOK_PORT`
  - `TELEGRAM_WEBHOOK_PATH`
- [x] Require secret token in webhook mode.
- [x] Add body size limits and request timeout.
- [x] ACK Telegram quickly and process updates asynchronously.
- [x] Keep long polling as default.

Acceptance criteria:

- Bridge can run on cloud hosts that prefer inbound webhook delivery.
- Webhook mode is not fail-open.

### 3.5 Proxy and network configuration

- [x] Support `TELEGRAM_PROXY` explicitly.
  - Implemented with undici `ProxyAgent` for grammY API calls and Telegram file downloads.
- [x] Respect standard `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, and `NO_PROXY` where grammY/fetch allows.
  - Node/grammY/fetch inherit process env; `/diagnostics` reports proxy presence.
- [x] Add configurable Telegram API root for self-hosted Bot API server if needed.
  - Added `TELEGRAM_API_ROOT` and `TELEGRAM_FILE_API_ROOT`.
- [x] Add network diagnostics to `/status` or `/diagnostics`.

Acceptance criteria:

- Bridge works in restricted networks with a configured proxy.

### 3.6 Diagnostics and observability

- [x] Expand `/status` with:
  - bot username
  - current transport mode
  - active session count
  - per-session project/session id
  - pi process running state
  - last activity time
  - pending queue status
  - last error summary
  - `/status` now includes transport, uptime, active session count, project, pi state, and last activity/error.
- [x] Add owner-only `/diagnostics` for verbose details.
  - Includes bot username, transport mode, uptime, sanitized config, proxy presence, active sessions, buffered albums, current pi state, and per-session error summaries.
- [ ] Add structured logs with event names and session keys.
- [x] Add optional healthcheck command or HTTP endpoint for service managers.
  - Added optional local `GET /healthz` endpoint enabled by `HEALTHCHECK_PORT`.

Acceptance criteria:

- Operator can diagnose common failures from Telegram or logs.

---

## Testing plan

### Unit tests

- [x] `project.ts`: path resolution remains workspace-safe.
- [x] `telegram-format.ts`: split/escape/truncate behavior.
- [x] session key derivation for private/group/topic messages.
- [x] permission checks for users/groups/owners/approvers.
- [x] mention stripping and group trigger detection.
- [ ] media group batching logic.
- [x] `outbound-media.ts`: MEDIA marker extraction, workspace allowlist, size checks, and media type classification.
- [x] `telegram-routing.ts`: session keys, thread params, access checks, owner legacy compatibility, mention stripping, and group trigger detection.

### Integration tests with mocked Telegram/pi

- [ ] Private chat text prompt routes to correct pi client.
- [ ] Two chats do not share session state.
- [ ] Group mention triggers; normal group chatter is ignored.
- [ ] Forum topic reply includes thread id.
- [ ] Callback button authorization rejects unauthorized users.
- [ ] pi exit during run notifies user.
- [ ] Telegram send parse failure retries plain text.

### Manual QA checklist

- [ ] Fresh install with current `.env.example` works.
- [ ] Existing single-user private chat workflow unchanged.
- [ ] `/project`, `/new`, `/status`, `/abort`, `/steer`, `/followup`, `/thinking` work.
- [ ] Photo prompt works.
- [ ] Long answer streams cleanly.
- [ ] Group mention behavior works with Telegram privacy mode documented.
- [ ] Service restart shuts down pi subprocesses cleanly.

---

## Suggested implementation order

1. Session manager and per-session event routing.
2. Permission model split while preserving legacy `TELEGRAM_ALLOWED_CHAT_IDS`.
3. Group/topic support and mention gating.
4. Polling/subprocess reliability improvements.
5. Message-edit streaming.
6. Voice input.
7. Document and media group input.
8. Command menu and session-aware inline controls.
9. Exec approval UI if pi RPC supports it.
10. Outbound media delivery. ✅ MVP complete via `MEDIA:/absolute/path` markers.
11. Pairing.
12. Webhook/proxy/diagnostics polish.

## Open questions for review

- Should we keep exactly one `PiRpcClient` per Telegram session, or should we map multiple Telegram sessions to pi RPC sessions inside one subprocess if pi supports it?
- Should `/project` be per-session by default, or should there be a global default project plus session overrides?
- Do we want group support now, or should we keep the bridge private-chat-only and only implement multi-DM sessions?
- Which STT backend should be the first supported option for voice messages?
- Does pi RPC expose structured approval events we can respond to, or is approval UI blocked on pi changes?
- What convention should pi use for outbound files: text marker like `MEDIA:/path`, structured RPC event, or both? Current MVP supports text markers; structured RPC events remain open.

---

## Implementation status update

Created `pi-telegram-bridge-plus` as a separate project so the original running `pi-telegram-bridge` is untouched. Phase 1 and the main Phase 2 items are implemented in `src/index.ts`, `src/config.ts`, and `src/pi-rpc.ts`.

Completed in this pass:

- Per-chat/per-topic `SessionState` and `Map<string, SessionState>`.
- Session-scoped pi RPC clients, project cwd, streaming buffers, tool throttles, and last-error state.
- Group allowlist and user/owner allowlists while preserving legacy `TELEGRAM_ALLOWED_CHAT_IDS`.
- Mention/reply gating for group messages.
- Forum-topic session keys and topic-aware replies.
- Owner checks for `/project`, `/abort`, `/thinking`, `/sessions`, and abort callback.
- Startup `deleteWebhook` before polling.
- Graceful shutdown of all pi subprocesses.
- Message-edit streaming preview for assistant deltas.
- HTML-send fallback to plain text.
- Telegram command menu registration.
- Single-photo and album image prompt handling.
- Voice message handling via `VOICE_TRANSCRIBE_CMD`.
- Text-document handling for common code/text extensions.
- Optional typing indicators and reactions.
- Session idle cleanup and owner commands `/sessions cleanup` and `/sessions close <key|current>`.
- Telegram send retry/backoff for 429 `retry_after`, 5xx, and transient send/network errors.
- Actionable 409 polling conflict log when another process uses the same bot token.
- Outbound local file/media delivery MVP via `MEDIA:/absolute/path` markers under `WORKSPACE_ROOT`.
- Unit tests for `project.ts`, `telegram-format.ts`, `outbound-media.ts`, and `telegram-routing.ts`.
- Updated `.env.example` and `README.md`.
- Verified with `npm test`, `npm run typecheck`, and `npm run build`.

Still pending / intentionally deferred:

- Full Telegram polling supervisor with polling-level retry/backoff. Current implementation improves startup cleanup, 409 conflict visibility, and send retry/flood-control handling but does not yet supervise long-polling restarts at OpenClaw/Hermes level.
- Webhook mode is implemented as an optional minimal transport; long polling remains default.
- Dynamic pairing is implemented with local JSON allowlist and owner approval.
- Structured RPC outbound media events and container-path translation; text marker based outbound delivery is implemented.
- Per-tool exec approval UI; this likely depends on pi RPC exposing approval events.
- Markdown table/mobile formatting and code-block-aware splitting beyond the current HTML fallback.
- More unit/integration tests for permissions, session key derivation, group mention gating, callbacks, diagnostics, and mocked Telegram/pi flows.

### Self-review fixes

A follow-up self-review pass fixed several runtime issues:

- Fixed `PiRpcClient.setCwd()` race where the old child process exit could clear the newly started child after project switching.
- Suppressed misleading pi-exit notifications from the old child during project switch replacement.
- Fixed streaming preview dedupe so failed preview sends do not poison `previewLastText` before a message actually lands.
- Added fallback retry without `message_thread_id` when Telegram reports a missing topic/thread during plain-text fallback sends.
- Reworked album buffering to avoid storing a live grammY `Context` across debounce timers; album flush now stores only serializable chat/session metadata and routes to the correct session.
- Added topic-aware unauthorized replies through a shared reply helper.

Validation after latest milestone:

- `npm test` ✅ — 15 tests passing
- `npm run typecheck` ✅
- `npm run build` ✅

### Runtime compatibility fix

- Changed `/new` and inline New from pi RPC `new_session` to bridge-side pi RPC subprocess restart. This avoids a current pi extension compatibility failure where `pi-memory-md` can throw a stale extension context error after `ctx.newSession()`. The Telegram UX remains a fresh chat/topic pi session, but implementation avoids the problematic pi RPC `new_session` path until the extension/pi side is fixed.
