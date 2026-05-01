import assert from 'node:assert/strict';
import http from 'node:http';
import { afterEach, describe, it } from 'node:test';
import { createWebhookServer, normalizePath, validateWebhookRequest } from './webhook-server.js';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function listen(server: http.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert(address && typeof address === 'object');
      resolve(address.port);
    });
  });
}

async function post(port: number, path: string, body: string, secret = 'secret'): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
    body,
  });
  return { status: response.status, json: await response.json() };
}

describe('webhook server helpers', () => {
  it('normalizes webhook paths', () => {
    assert.equal(normalizePath('telegram'), '/telegram');
    assert.equal(normalizePath('/telegram'), '/telegram');
  });

  it('validates method, path, and secret token', () => {
    const config = { path: '/hook', secret: 's', maxBodyBytes: 1024 };
    assert.deepEqual(validateWebhookRequest({ method: 'GET', path: '/hook', secretHeader: 's', config }), { status: 404, body: { ok: false, error: 'not_found' } });
    assert.deepEqual(validateWebhookRequest({ method: 'POST', path: '/bad', secretHeader: 's', config }), { status: 404, body: { ok: false, error: 'not_found' } });
    assert.deepEqual(validateWebhookRequest({ method: 'POST', path: '/hook', secretHeader: 'bad', config }), { status: 401, body: { ok: false, error: 'unauthorized' } });
    assert.equal(validateWebhookRequest({ method: 'POST', path: '/hook', secretHeader: 's', config }), undefined);
  });

  it('acks valid updates quickly and dispatches handleUpdate', async () => {
    const received: unknown[] = [];
    const server = createWebhookServer({ path: '/hook', secret: 'secret', maxBodyBytes: 1024 }, (update) => {
      received.push(update);
    });
    const port = await listen(server);
    const result = await post(port, '/hook', JSON.stringify({ update_id: 1, message: { text: 'hi' } }));

    assert.equal(result.status, 200);
    assert.deepEqual(result.json, { ok: true });
    assert.deepEqual(received, [{ update_id: 1, message: { text: 'hi' } }]);
  });

  it('rejects invalid secret and oversized bodies', async () => {
    const received: unknown[] = [];
    const server = createWebhookServer({ path: '/hook', secret: 'secret', maxBodyBytes: 4 }, (update) => {
      received.push(update);
    });
    const port = await listen(server);

    assert.deepEqual(await post(port, '/hook', '{}', 'bad'), { status: 401, json: { ok: false, error: 'unauthorized' } });
    const tooLarge = await post(port, '/hook', '{"too":"large"}');
    assert.equal(tooLarge.status, 413);
    assert.deepEqual(tooLarge.json, { ok: false, error: 'payload_too_large' });
    assert.deepEqual(received, []);
  });

  it('acks malformed JSON but logs and does not dispatch', async () => {
    const received: unknown[] = [];
    const errors: string[] = [];
    const server = createWebhookServer({ path: '/hook', secret: 'secret', maxBodyBytes: 1024 }, (update) => {
      received.push(update);
    }, (message) => {
      errors.push(message);
    });
    const port = await listen(server);

    assert.deepEqual(await post(port, '/hook', '{not-json'), { status: 200, json: { ok: true } });
    assert.deepEqual(received, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Invalid webhook update/);
  });
});
