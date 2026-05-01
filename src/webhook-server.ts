import http, { type IncomingMessage, type ServerResponse } from 'node:http';

export type WebhookServerConfig = {
  secret: string;
  path: string;
  maxBodyBytes: number;
};

export type WebhookHandler = (update: unknown) => Promise<void> | void;

export type WebhookHandleResult = {
  status: number;
  body: { ok: boolean; error?: string };
};

export function normalizePath(value: string): string {
  return value.startsWith('/') ? value : `/${value}`;
}

export function validateWebhookRequest(options: {
  method?: string;
  path: string;
  secretHeader?: string | string[];
  config: WebhookServerConfig;
}): WebhookHandleResult | undefined {
  const webhookPath = normalizePath(options.config.path);
  if (options.method !== 'POST' || options.path !== webhookPath) return { status: 404, body: { ok: false, error: 'not_found' } };
  if (options.secretHeader !== options.config.secret) return { status: 401, body: { ok: false, error: 'unauthorized' } };
  return undefined;
}

export function createWebhookRequestListener(config: WebhookServerConfig, handleUpdate: WebhookHandler, logError: (message: string) => void = console.error) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const early = validateWebhookRequest({ method: req.method, path: url.pathname, secretHeader: req.headers['x-telegram-bot-api-secret-token'], config });
    if (early) {
      res.writeHead(early.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(early.body));
      return;
    }

    let done = false;
    let size = 0;
    const chunks: Buffer[] = [];

    const finish = (status: number, body: WebhookHandleResult['body']): void => {
      if (done) return;
      done = true;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.byteLength;
      if (size > config.maxBodyBytes) {
        finish(413, { ok: false, error: 'payload_too_large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (done) return;
      finish(200, { ok: true });
      try {
        const update = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        void Promise.resolve(handleUpdate(update)).catch((error) => logError(error instanceof Error ? error.message : String(error)));
      } catch (error) {
        logError(`Invalid webhook update: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  };
}

export function createWebhookServer(config: WebhookServerConfig, handleUpdate: WebhookHandler, logError?: (message: string) => void): http.Server {
  return http.createServer(createWebhookRequestListener(config, handleUpdate, logError));
}
