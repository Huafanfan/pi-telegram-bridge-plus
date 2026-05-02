import { resolveOutboundMediaFiles, type OutboundMediaFile } from './outbound-media.js';

export type TelegramAction =
  | { type: 'send_message'; text: string }
  | { type: 'send_photo' | 'send_document' | 'send_audio' | 'send_voice' | 'send_video'; path: string; caption?: string }
  | { type: 'react'; emoji: string }
  | { type: 'buttons'; text: string; buttons: string[][] };

export type ParsedTelegramActions = {
  visibleText: string;
  actions: TelegramAction[];
  errors: string[];
};

const ACTION_BLOCK_RE = /```telegram-action\s*\n([\s\S]*?)```/gim;

export function parseTelegramActions(text: string): ParsedTelegramActions {
  const actions: TelegramAction[] = [];
  const errors: string[] = [];
  const visibleText = text.replace(ACTION_BLOCK_RE, (_block, jsonText: string) => {
    try {
      const parsed = JSON.parse(jsonText) as unknown;
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        const action = normalizeAction(item);
        if (action) actions.push(action);
        else errors.push('Invalid telegram-action item ignored.');
      }
    } catch (error) {
      errors.push(`Invalid telegram-action JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  return { visibleText, actions, errors };
}

function normalizeAction(value: unknown): TelegramAction | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  const type = item.type;
  if (type === 'send_message' && typeof item.text === 'string') return { type, text: item.text };
  if (['send_photo', 'send_document', 'send_audio', 'send_voice', 'send_video'].includes(String(type)) && typeof item.path === 'string') {
    return { type: type as TelegramAction['type'], path: item.path, caption: typeof item.caption === 'string' ? item.caption : undefined } as TelegramAction;
  }
  if (type === 'react' && typeof item.emoji === 'string') return { type, emoji: item.emoji };
  if (type === 'buttons' && typeof item.text === 'string' && Array.isArray(item.buttons)) {
    const buttons = item.buttons
      .filter(Array.isArray)
      .map((row) => row.filter((button): button is string => typeof button === 'string' && button.trim().length > 0));
    return { type, text: item.text, buttons };
  }
  return undefined;
}

export function resolveTelegramActionFile(action: TelegramAction, workspaceRoot: string, maxBytes: number, extraAllowedRoots?: string[]): { file?: OutboundMediaFile; error?: string } {
  if (!('path' in action)) return {};
  const { files, errors } = resolveOutboundMediaFiles({ text: `MEDIA:${action.path}`, workspaceRoot, maxBytes, extraAllowedRoots });
  if (errors.length) return { error: errors.join('; ') };
  const file = files[0];
  if (!file) return { error: `No file resolved for telegram-action path: ${action.path}` };
  return { file };
}
