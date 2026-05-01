import fs from 'node:fs';
import path from 'node:path';
import type { ChatLike } from './telegram-routing.js';

export type TopicConfigEntry = {
  enabled?: boolean;
  requireMention?: boolean;
  project?: string;
  allowedUserIds?: number[];
  mentionPatterns?: string[];
};

export type GroupTopicConfig = TopicConfigEntry & {
  topics?: Record<string, TopicConfigEntry>;
};

export type TopicConfigFile = Record<string, GroupTopicConfig>;

export type EffectiveTopicConfig = TopicConfigEntry & {
  mentionRegexes: RegExp[];
};

export function loadTopicConfigFile(filePath: string): TopicConfigFile {
  if (!filePath.trim()) return {};
  try {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) return {};
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown;
    return normalizeTopicConfig(parsed);
  } catch (error) {
    console.warn(`Ignoring invalid TELEGRAM_TOPIC_CONFIG_FILE: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

export function normalizeTopicConfig(value: unknown): TopicConfigFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output: TopicConfigFile = {};
  for (const [groupId, rawGroup] of Object.entries(value as Record<string, unknown>)) {
    if (!rawGroup || typeof rawGroup !== 'object' || Array.isArray(rawGroup)) continue;
    const group = normalizeEntry(rawGroup as Record<string, unknown>) as GroupTopicConfig;
    const rawTopics = (rawGroup as Record<string, unknown>).topics;
    if (rawTopics && typeof rawTopics === 'object' && !Array.isArray(rawTopics)) {
      group.topics = {};
      for (const [topicId, rawTopic] of Object.entries(rawTopics as Record<string, unknown>)) {
        if (!rawTopic || typeof rawTopic !== 'object' || Array.isArray(rawTopic)) continue;
        group.topics[topicId] = normalizeEntry(rawTopic as Record<string, unknown>);
      }
    }
    output[groupId] = group;
  }
  return output;
}

function normalizeEntry(raw: Record<string, unknown>): TopicConfigEntry {
  const entry: TopicConfigEntry = {};
  if (typeof raw.enabled === 'boolean') entry.enabled = raw.enabled;
  if (typeof raw.requireMention === 'boolean') entry.requireMention = raw.requireMention;
  if (typeof raw.project === 'string') entry.project = raw.project;
  if (Array.isArray(raw.allowedUserIds)) entry.allowedUserIds = raw.allowedUserIds.map(Number).filter(Number.isFinite);
  if (Array.isArray(raw.mentionPatterns)) entry.mentionPatterns = raw.mentionPatterns.filter((v): v is string => typeof v === 'string');
  return entry;
}

export function effectiveTopicConfig(config: TopicConfigFile, chat: ChatLike | undefined, threadId?: number): EffectiveTopicConfig {
  const group = chat ? config[String(chat.id)] ?? config['*'] : undefined;
  const topic = threadId !== undefined ? group?.topics?.[String(threadId)] : undefined;
  const merged: TopicConfigEntry = { ...(group ?? {}), ...(topic ?? {}) };
  delete (merged as GroupTopicConfig).topics;
  return { ...merged, mentionRegexes: compilePatterns(merged.mentionPatterns ?? []) };
}

function compilePatterns(patterns: string[]): RegExp[] {
  return patterns.flatMap((pattern) => {
    try {
      return [new RegExp(pattern, 'i')];
    } catch {
      return [];
    }
  });
}

export function isTopicUserAllowed(entry: EffectiveTopicConfig, userId?: number): boolean {
  if (!entry.allowedUserIds?.length) return true;
  return typeof userId === 'number' && entry.allowedUserIds.includes(userId);
}
