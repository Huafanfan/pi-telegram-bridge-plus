import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export type PiRpcEvent = Record<string, unknown> & { type?: string };

type PendingRequest = {
  resolve: (value: PiRpcEvent) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class PiRpcClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private pending = new Map<string, PendingRequest>();
  private stopping = false;

  constructor(
    private readonly options: {
      piBin: string;
      cwd: string;
      args?: string[];
    },
  ) {
    super();
  }

  get cwd(): string {
    return this.options.cwd;
  }

  setCwd(cwd: string): void {
    if (this.options.cwd === cwd) return;
    this.stop();
    this.options.cwd = cwd;
    this.start();
  }

  get isRunning(): boolean {
    return this.child !== null && !this.child.killed;
  }

  start(): void {
    if (this.child) return;
    this.stopping = false;

    const args = ['--mode', 'rpc', ...(this.options.args ?? [])];
    const child = spawn(this.options.piBin, args, {
      cwd: this.options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    this.child = child;

    child.stdout.on('data', (chunk: Buffer) => this.handleStdout(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      this.emit('stderr', chunk.toString('utf8'));
    });
    child.on('error', (error) => this.emit('error', error));
    child.on('exit', (code, signal) => {
      const wasStopping = this.stopping;

      // A project switch calls stop() and immediately starts a replacement child.
      // The old child's late exit must not clear the new child or emit a misleading exit notice.
      if (this.child !== child) return;

      this.emit('exit', { code, signal, stopping: wasStopping });
      this.child = null;
      for (const [id, request] of this.pending.entries()) {
        clearTimeout(request.timer);
        request.reject(new Error(`pi RPC exited before response ${id} (code=${code}, signal=${signal})`));
      }
      this.pending.clear();
      this.buffer = '';
    });
  }

  stop(): void {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    this.stopping = true;
    child.kill('SIGTERM');
  }

  async prompt(
    message: string,
    streamingBehavior?: 'steer' | 'followUp',
    images?: Array<{ type: 'image'; data: string; mimeType: string }>,
  ): Promise<PiRpcEvent> {
    return this.send({ type: 'prompt', message, ...(streamingBehavior ? { streamingBehavior } : {}), ...(images?.length ? { images } : {}) });
  }

  async steer(message: string): Promise<PiRpcEvent> {
    return this.send({ type: 'steer', message });
  }

  async followUp(message: string): Promise<PiRpcEvent> {
    return this.send({ type: 'follow_up', message });
  }

  async abort(): Promise<PiRpcEvent> {
    return this.send({ type: 'abort' });
  }

  async newSession(): Promise<PiRpcEvent> {
    return this.send({ type: 'new_session' });
  }

  async getState(): Promise<PiRpcEvent> {
    return this.send({ type: 'get_state' });
  }

  async setThinking(level: string): Promise<PiRpcEvent> {
    return this.send({ type: 'set_thinking_level', level });
  }

  async send(payload: Record<string, unknown>, timeoutMs = 15_000): Promise<PiRpcEvent> {
    if (!this.child) this.start();
    const child = this.child;
    if (!child) throw new Error('Failed to start pi RPC process');
    if (!child.stdin.writable) {
      this.child = null;
      throw new Error('pi RPC stdin is not writable');
    }

    const id = typeof payload.id === 'string' ? payload.id : randomUUID();
    const command = { ...payload, id };

    const promise = new Promise<PiRpcEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for pi RPC response to ${String(payload.type)}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });

    child.stdin.write(`${JSON.stringify(command)}\n`, (error) => {
      if (!error) return;
      const request = this.pending.get(id);
      if (request) {
        clearTimeout(request.timer);
        this.pending.delete(id);
        request.reject(error);
      }
    });
    return promise;
  }

  private handleStdout(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let event: PiRpcEvent;
    try {
      event = JSON.parse(line) as PiRpcEvent;
    } catch (error) {
      this.emit('parse_error', { line, error });
      return;
    }

    if (event.type === 'response' && typeof event.id === 'string') {
      const request = this.pending.get(event.id);
      if (request) {
        clearTimeout(request.timer);
        this.pending.delete(event.id);
        request.resolve(event);
      }
    }

    this.emit('event', event);
  }
}
