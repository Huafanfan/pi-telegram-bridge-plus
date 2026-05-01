import { ProxyAgent, fetch as undiciFetch } from 'undici';
import type { ApiClientOptions } from 'grammy';

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

export type TelegramClientConfig = {
  TELEGRAM_API_ROOT: string;
  TELEGRAM_PROXY: string;
};

export function redactProxyUrl(value: string): string {
  if (!value.trim()) return '';
  try {
    const url = new URL(value);
    if (url.username) url.username = '<redacted>';
    if (url.password) url.password = '<redacted>';
    return url.toString();
  } catch {
    return '<invalid-url>';
  }
}

export function telegramFetch(config: Pick<TelegramClientConfig, 'TELEGRAM_PROXY'>): typeof fetch {
  const proxy = config.TELEGRAM_PROXY.trim();
  if (!proxy) return fetch;
  const dispatcher = new ProxyAgent(proxy);
  return ((input, init) => (undiciFetch as unknown as typeof fetch)(input, { ...(init as FetchInit), dispatcher } as unknown as RequestInit)) as typeof fetch;
}

export function telegramClientOptions(config: TelegramClientConfig): ApiClientOptions {
  return {
    apiRoot: config.TELEGRAM_API_ROOT,
    fetch: telegramFetch(config),
  };
}
