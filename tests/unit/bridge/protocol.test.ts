import { describe, expect, it } from 'vitest';
import {
  BRIDGE_MESSAGE_TYPES,
  decodeRequest,
  encodeMessage,
  isBridgeMessageType,
} from '../../../src/bridge/protocol.js';

describe('protocol — type guards', () => {
  it('isBridgeMessageType accepts every advertised type', () => {
    for (const t of BRIDGE_MESSAGE_TYPES) {
      expect(isBridgeMessageType(t)).toBe(true);
    }
  });

  it('isBridgeMessageType rejects unknown types', () => {
    expect(isBridgeMessageType('host_session_end')).toBe(false);
    expect(isBridgeMessageType('')).toBe(false);
    expect(isBridgeMessageType(null)).toBe(false);
    expect(isBridgeMessageType(42)).toBe(false);
    expect(isBridgeMessageType(undefined)).toBe(false);
  });
});

describe('protocol — encode', () => {
  it('encodeMessage produces a single line ending with newline', () => {
    const wire = encodeMessage({ type: 'host_progress', host_session_id: 's1', tool: 'shell' });
    expect(wire.endsWith('\n')).toBe(true);
    expect(wire.indexOf('\n')).toBe(wire.length - 1);
  });

  it('encodeMessage round-trips through JSON.parse', () => {
    const msg = { type: 'host_stop' as const, host_session_id: 's1' };
    const wire = encodeMessage(msg);
    expect(JSON.parse(wire.trim())).toEqual(msg);
  });
});

describe('protocol — decode', () => {
  it('decodes a valid request', () => {
    const wire = JSON.stringify({ type: 'host_session_start', host_session_id: 'abc' });
    const result = decodeRequest(wire);
    expect(result.ok).toBe(true);
    expect(result.message?.type).toBe('host_session_start');
  });

  it('attack: empty line is parse_error', () => {
    expect(decodeRequest('').error?.error).toBe('parse_error');
    expect(decodeRequest('   ').error?.error).toBe('parse_error');
  });

  it('attack: malformed JSON is parse_error', () => {
    expect(decodeRequest('{not json}').error?.error).toBe('parse_error');
    expect(decodeRequest('{"type":').error?.error).toBe('parse_error');
  });

  it('attack: non-object payload is parse_error', () => {
    expect(decodeRequest('"a string"').error?.error).toBe('parse_error');
    expect(decodeRequest('42').error?.error).toBe('parse_error');
    expect(decodeRequest('null').error?.error).toBe('parse_error');
    expect(decodeRequest('[1,2]').error?.error).toBe('parse_error');
  });

  it('attack: unknown type is unknown_type', () => {
    const r = decodeRequest(JSON.stringify({ type: 'host_session_end' }));
    expect(r.error?.error).toBe('unknown_type');
  });

  it('attack: missing type is unknown_type', () => {
    const r = decodeRequest(JSON.stringify({ host_session_id: 'x' }));
    expect(r.error?.error).toBe('unknown_type');
  });

  it('attack: numeric type is unknown_type', () => {
    const r = decodeRequest(JSON.stringify({ type: 42 }));
    expect(r.error?.error).toBe('unknown_type');
  });
});
