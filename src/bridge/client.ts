import { existsSync } from 'node:fs';
import net from 'node:net';
import { PATHS, DEFAULT_TIMEOUTS } from '../constants.js';
import { encodeMessage, type BridgeErrorResponse, type BridgeRequest, type BridgeResponse } from './protocol.js';

export interface SendOptions {
  socketPath?: string;
  timeoutMs?: number;
}

export function bridgeSocketExists(socketPath: string = PATHS.bridgeSocket): boolean {
  return existsSync(socketPath);
}

/**
 * Single-shot bridge client. Opens a UDS connection, sends one JSON-Lines request,
 * receives one JSON-Lines response, closes. The server may return either a
 * typed response or a `BridgeErrorResponse`; callers must handle both shapes.
 */
export function sendBridgeMessage(
  message: BridgeRequest,
  options: SendOptions = {},
): Promise<BridgeResponse | BridgeErrorResponse> {
  const socketPath = options.socketPath
    ?? process.env['HELM_BRIDGE_SOCKET']
    ?? PATHS.bridgeSocket;
  const envTimeout = Number(process.env['HELM_BRIDGE_TIMEOUT_MS']);
  const timeoutMs = options.timeoutMs
    ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUTS.bridgeMs);

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    let settled = false;

    const settle = (fn: (v: unknown) => void, value: unknown): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn(value);
    };

    socket.setTimeout(timeoutMs);

    socket.on('connect', () => {
      socket.write(encodeMessage(message));
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;

      const line = buffer.slice(0, newline).trim();
      if (!line) {
        settle(reject as (v: unknown) => void, new Error('empty bridge response'));
        return;
      }
      try {
        settle(resolve as (v: unknown) => void, JSON.parse(line));
      } catch (err) {
        settle(reject as (v: unknown) => void, err);
      }
    });

    socket.on('timeout', () => {
      settle(reject as (v: unknown) => void, new Error(`bridge timeout after ${timeoutMs}ms`));
    });

    socket.on('error', (err) => {
      settle(reject as (v: unknown) => void, err);
    });

    socket.on('end', () => {
      if (!settled && buffer.trim()) {
        try {
          settle(resolve as (v: unknown) => void, JSON.parse(buffer.trim()));
        } catch (err) {
          settle(reject as (v: unknown) => void, err);
        }
      } else if (!settled) {
        settle(reject as (v: unknown) => void, new Error('bridge closed before response'));
      }
    });
  });
}
