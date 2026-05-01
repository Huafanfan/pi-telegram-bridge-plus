import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redactProxyUrl, telegramClientOptions, telegramFetch } from './telegram-client.js';

describe('telegram client helpers', () => {
  it('redacts proxy credentials', () => {
    assert.equal(redactProxyUrl('http://user:pass@127.0.0.1:8080'), 'http://%3Credacted%3E:%3Credacted%3E@127.0.0.1:8080/');
    assert.equal(redactProxyUrl('not a url'), '<invalid-url>');
    assert.equal(redactProxyUrl(''), '');
  });

  it('builds client options with api root and fetch', () => {
    const options = telegramClientOptions({ TELEGRAM_API_ROOT: 'https://telegram.example', TELEGRAM_PROXY: '' });
    assert.equal(options.apiRoot, 'https://telegram.example');
    assert.equal(typeof options.fetch, 'function');
    assert.equal(telegramFetch({ TELEGRAM_PROXY: '' }), fetch);
  });

  it('builds a proxied fetch when TELEGRAM_PROXY is set', () => {
    const proxied = telegramFetch({ TELEGRAM_PROXY: 'http://127.0.0.1:8080' });
    assert.equal(typeof proxied, 'function');
    assert.notEqual(proxied, fetch);
  });
});
