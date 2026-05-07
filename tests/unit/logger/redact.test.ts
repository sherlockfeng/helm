import { describe, expect, it } from 'vitest';
import { redact } from '../../../src/logger/redact.js';

describe('redact — sensitive keys', () => {
  it('replaces apiKey / token / secret values with mask', () => {
    expect(redact({ apiKey: 'sk-abc12345xxxxxxxx', token: 'longSecret123' })).toEqual({
      apiKey: 'sk-a***',
      token: 'long***',
    });
  });

  it('mask uses *** when value is shorter than 6 chars', () => {
    expect(redact({ token: 'abc' })).toEqual({ token: '***' });
  });

  it('case-insensitive key matching', () => {
    expect(redact({ APIKEY: 'longvalue' })).toEqual({ APIKEY: 'long***' });
    expect(redact({ Authorization: 'Bearer longvalue' })).toEqual({ Authorization: 'Bear***' });
  });

  it('handles non-string values for sensitive keys', () => {
    expect(redact({ apiKey: 12345, password: ['a', 'b'] })).toEqual({
      apiKey: '***',
      password: '***',
    });
  });

  // Phase 29: expanded key list
  it('Phase 29: redacts private_key / client_secret / refresh / id token variants', () => {
    expect(redact({
      private_key: 'rsa-key-data-here',
      client_secret: 'cs-12345678',
      refresh_token: 'rt-1234567890',
      id_token: 'idt-abc123',
      proxy_authorization: 'Basic dXNlcjpwYXNz',
    })).toEqual({
      private_key: 'rsa-***',
      client_secret: 'cs-1***',
      refresh_token: 'rt-1***',
      id_token: 'idt-***',
      proxy_authorization: 'Basi***',
    });
  });

  it('Phase 29: AWS / Lark / Cursor key variants are caught', () => {
    expect(redact({
      aws_access_key_id: 'AKIAIOSFODNN7EXAMPLE',
      aws_secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCY',
      lark_app_secret: 'lark-secret-blah',
      cursor_api_key: 'cur-12345678',
    })).toEqual({
      aws_access_key_id: 'AKIA***',
      aws_secret_access_key: 'wJal***',
      lark_app_secret: 'lark***',
      cursor_api_key: 'cur-***',
    });
  });

  it('Phase 29: connection_string / dsn carry creds — masked', () => {
    expect(redact({
      connection_string: 'postgres://u:p@host/db',
      dsn: 'mysql://root:pass@db:3306/app',
    })).toEqual({
      connection_string: 'post***',
      dsn: 'mysq***',
    });
  });

  it('Phase 29: normalizes API-Key / api key / apiKey / api_key to the same key', () => {
    expect(redact({ 'API-Key': 'verysecretvalue' })).toEqual({ 'API-Key': 'very***' });
    expect(redact({ 'api key': 'verysecretvalue' })).toEqual({ 'api key': 'very***' });
    expect(redact({ apiKey: 'verysecretvalue' })).toEqual({ apiKey: 'very***' });
    expect(redact({ api_key: 'verysecretvalue' })).toEqual({ api_key: 'very***' });
  });
});

describe('redact — token-like values', () => {
  it('masks bearer / sk- / xoxb- whole-string patterns even when key name is benign', () => {
    expect(redact({ note: 'Bearer abcdefg12345' })).toEqual({ note: 'Bear***' });
    expect(redact({ note: 'sk-abcdefghijklmnopqrst' })).toEqual({ note: 'sk-a***' });
  });

  it('leaves short or non-pattern strings alone', () => {
    expect(redact({ note: 'hello world' })).toEqual({ note: 'hello world' });
    expect(redact({ note: 'sk-' })).toEqual({ note: 'sk-' });
  });

  it('Phase 29: Basic auth header gets masked end-to-end', () => {
    expect(redact({ note: 'Basic dXNlcjpwYXNzd29yZA==' })).toEqual({ note: 'Basi***' });
  });
});

describe('redact — embedded patterns (Phase 29)', () => {
  it('masks JWT inside free-form text — surrounding text preserved', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.s3cretSig';
    const out = redact({ msg: `auth failed for ${jwt} please retry` });
    expect((out as { msg: string }).msg).not.toContain(jwt);
    expect((out as { msg: string }).msg).toContain('please retry');
    expect((out as { msg: string }).msg).toContain('eyJh***');
  });

  it('masks GitHub PAT embedded in a curl example', () => {
    const out = redact({ note: 'try: curl -H "Authorization: token ghp_abcdefghijklmnopqrstuvwxyz1234" /api' });
    const note = (out as { note: string }).note;
    expect(note).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz1234');
    expect(note).toMatch(/ghp_\*\*\*/);
    expect(note).toContain('curl -H');
  });

  it('masks AWS access key id wherever it appears', () => {
    const out = redact({ note: 'failed to authenticate AKIAIOSFODNN7EXAMPLE on s3' });
    expect((out as { note: string }).note).toContain('AKIA***');
    expect((out as { note: string }).note).toContain('s3');
  });

  it('masks Stripe live/test keys', () => {
    // NB: deliberately mangled fixtures so GitHub's push-protection scanner
    // doesn't flag the test file as a real-looking sample key while the
    // regex still matches.
    const live = 'sk_live_' + 'FakeFakeFakeFake1234';
    const test = 'pk_test_' + 'FakeFakeFakeFake5678';
    const out = redact({
      lines: [`using ${live}`, `using ${test}`],
    });
    const lines = (out as { lines: string[] }).lines;
    expect(lines[0]).toContain('sk_l***');
    expect(lines[0]).not.toContain('FakeFakeFakeFake1234');
    expect(lines[1]).toContain('pk_t***');
    expect(lines[1]).not.toContain('FakeFakeFakeFake5678');
  });

  it('masks Slack non-bot tokens (xoxp / xoxa / xoxr / xoxs)', () => {
    const out = redact({
      a: 'token: xoxp-1234567890-abcdefg',
      b: 'token: xoxa-1234567890-abcdefg',
    });
    expect((out as { a: string; b: string }).a).toContain('xoxp***');
    expect((out as { a: string; b: string }).b).toContain('xoxa***');
  });

  it('masks Google OAuth ya29 access tokens', () => {
    const out = redact({ token_url: 'https://example.com?access_token=ya29.AHES6ZTtm7SuokEB-RGtbBty9IIlNiP9-eNMMQKtXdMP3sfjL1Fc' });
    expect((out as { token_url: string }).token_url).toContain('ya29***');
  });

  it('masks URLs with embedded credentials across schemes — host preserved, user:pass gone', () => {
    const out = redact({
      mongo: 'connecting to mongodb://admin:s3cret@db.example.com:27017/app',
      postgres: 'pg url is postgres://u:realpass@db:5432/app',
      redis: 'redis://default:wowwow@cache:6379',
    });
    const lines = out as Record<string, string>;
    // user:pass@ block masked; host + path preserved for debug
    expect(lines.mongo).not.toContain('admin');
    expect(lines.mongo).not.toContain('s3cret');
    expect(lines.mongo).toContain('db.example.com:27017/app');
    expect(lines.postgres).not.toContain('realpass');
    expect(lines.postgres).toContain('db:5432/app');
    expect(lines.redis).not.toContain('wowwow');
    expect(lines.redis).toContain('cache:6379');
  });

  it('masks PEM private key blocks (multi-line)', () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAA\n-----END OPENSSH PRIVATE KEY-----';
    const out = redact({ key: `here is a key:\n${pem}\nthx` });
    const note = (out as { key: string }).key;
    // The whole PEM block is one match — masked but surrounding text intact.
    expect(note).not.toContain('OPENSSH');
    expect(note).toContain('here is a key:');
    expect(note).toContain('thx');
  });

  it('masks npm tokens and GitLab PATs', () => {
    const out = redact({
      a: 'NPM_TOKEN=npm_abcdefghijklmnopqrstuvwxyz0123456789',
      b: 'GITLAB_TOKEN=glpat-AbCdEfGhIjKlMnOpQrSt',
    });
    expect((out as { a: string; b: string }).a).toContain('npm_***');
    expect((out as { a: string; b: string }).b).toContain('glpa***');
  });

  it('attack: legitimate text matching token shape but too short stays untouched', () => {
    expect(redact({ note: 'see PR ghp_short' })).toEqual({ note: 'see PR ghp_short' });
    expect(redact({ note: 'sk-x' })).toEqual({ note: 'sk-x' });
  });

  it('attack: oversized strings skip the embedded scan to keep work bounded', () => {
    const huge = 'sk-realsecret123456789012'.repeat(1) + 'a'.repeat(200_000);
    const start = Date.now();
    const out = redact({ note: huge });
    const elapsed = Date.now() - start;
    // Caller chose performance over redaction here. We don't assert masked,
    // just that the call returned in well under a second.
    expect(elapsed).toBeLessThan(500);
    expect(typeof (out as { note: string }).note).toBe('string');
  });

  it('attack: embedded scan applies to plain string input too (not just object values)', () => {
    const result = redact('Bearer ghp_abcdefghijklmnopqrstuvwxyz1234 worked');
    expect(result).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz1234');
    expect(result).toContain('worked');
  });
});

describe('redact — recursion', () => {
  it('walks nested objects', () => {
    expect(redact({ outer: { inner: { apiKey: 'longvalue123' } } }))
      .toEqual({ outer: { inner: { apiKey: 'long***' } } });
  });

  it('walks arrays', () => {
    expect(redact([{ token: 'longSecret123' }, { other: 'safe' }]))
      .toEqual([{ token: 'long***' }, { other: 'safe' }]);
  });

  it('attack: stops at MAX_DEPTH (no infinite recursion)', () => {
    const a: Record<string, unknown> = {};
    let cur: Record<string, unknown> = a;
    for (let i = 0; i < 20; i++) {
      cur['x'] = {};
      cur = cur['x'] as Record<string, unknown>;
    }
    expect(() => redact(a)).not.toThrow();
  });

  it('null / undefined / primitives pass through', () => {
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
    expect(redact(42)).toBe(42);
    expect(redact('hello')).toBe('hello');
    expect(redact(true)).toBe(true);
  });
});
