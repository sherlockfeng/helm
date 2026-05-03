import { existsSync, unlinkSync, chmodSync } from 'node:fs';
import net from 'node:net';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import {
  decodeRequest,
  encodeMessage,
  type BridgeErrorResponse,
  type BridgeMessageType,
  type BridgeRequest,
  type BridgeResponse,
  type RequestForType,
  type ResponseForType,
} from './protocol.js';

export type BridgeHandler<T extends BridgeMessageType = BridgeMessageType> = (
  req: RequestForType<T>,
) => Promise<ResponseForType<T>> | ResponseForType<T>;

export interface BridgeServerOptions {
  socketPath: string;
  /** Per-connection idle timeout. Connection is closed if no data within this window. */
  connectionIdleMs?: number;
  /** Optional logger; defaults to no-op. */
  onError?: (err: Error, context: string) => void;
}

export class BridgeServer {
  private server?: net.Server;
  private readonly handlers = new Map<BridgeMessageType, BridgeHandler>();
  private readonly socketPath: string;
  private readonly connectionIdleMs: number;
  private readonly onError: (err: Error, context: string) => void;
  private readonly activeSockets = new Set<net.Socket>();

  constructor(options: BridgeServerOptions) {
    this.socketPath = options.socketPath;
    this.connectionIdleMs = options.connectionIdleMs ?? 60_000;
    this.onError = options.onError ?? (() => {});
  }

  registerHandler<T extends BridgeMessageType>(type: T, handler: BridgeHandler<T>): void {
    this.handlers.set(type, handler as unknown as BridgeHandler);
  }

  hasHandler(type: BridgeMessageType): boolean {
    return this.handlers.has(type);
  }

  async start(): Promise<void> {
    if (this.server) throw new Error('BridgeServer already started');

    mkdirSync(dirname(this.socketPath), { recursive: true });
    if (existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath); }
      catch (err) { this.onError(err as Error, 'unlink stale socket'); }
    }

    this.server = net.createServer((socket) => this.handleConnection(socket));
    this.server.on('error', (err) => this.onError(err, 'server'));

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.socketPath, () => {
        this.server!.off('error', reject);
        try { chmodSync(this.socketPath, 0o600); }
        catch (err) { this.onError(err as Error, 'chmod socket'); }
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;

    for (const socket of this.activeSockets) {
      socket.destroy();
    }
    this.activeSockets.clear();

    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });
    this.server = undefined;

    if (existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath); }
      catch (err) { this.onError(err as Error, 'unlink socket on stop'); }
    }
  }

  private handleConnection(socket: net.Socket): void {
    this.activeSockets.add(socket);
    let buffer = '';
    let handled = false;

    socket.setTimeout(this.connectionIdleMs);

    const cleanup = (): void => {
      this.activeSockets.delete(socket);
      socket.destroy();
    };

    const respond = (msg: BridgeResponse | BridgeErrorResponse): void => {
      if (handled) return;
      handled = true;
      try {
        socket.write(encodeMessage(msg), () => {
          socket.end();
          cleanup();
        });
      } catch (err) {
        this.onError(err as Error, 'write response');
        cleanup();
      }
    };

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;

      const line = buffer.slice(0, newline);
      buffer = '';
      void this.dispatch(line, respond);
    });

    socket.on('timeout', () => {
      if (!handled) {
        respond({ error: 'parse_error', message: 'idle timeout' });
      } else {
        cleanup();
      }
    });

    socket.on('error', (err) => {
      this.onError(err, 'socket');
      cleanup();
    });

    socket.on('close', cleanup);
  }

  private async dispatch(line: string, respond: (m: BridgeResponse | BridgeErrorResponse) => void): Promise<void> {
    const decoded = decodeRequest(line);
    if (!decoded.ok || !decoded.message) {
      respond(decoded.error ?? { error: 'parse_error' });
      return;
    }

    const handler = this.handlers.get(decoded.message.type);
    if (!handler) {
      respond({ error: 'no_handler', message: `no handler registered for ${decoded.message.type}` });
      return;
    }

    try {
      const result = await handler(decoded.message as RequestForType<BridgeMessageType>);
      respond(result);
    } catch (err) {
      this.onError(err as Error, `handler:${decoded.message.type}`);
      respond({ error: 'handler_error', message: (err as Error).message });
    }
  }
}

export type { BridgeRequest };
