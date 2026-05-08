/**
 * `read_lark_doc` tool unit tests (Phase 58).
 *
 * Drives the tool against a stub LarkCliRunner — captures the args passed
 * to the CLI, returns canned stdout, asserts the tool extracts the doc
 * markdown correctly. Doesn't reach a real Lark API.
 */

import { describe, expect, it } from 'vitest';
import { createReadLarkDocTool } from '../../../../src/llm/tools/lark-doc.js';
import type {
  LarkCliRunner,
  LarkCliRunResult,
  LarkCliSpawnHandle,
} from '../../../../src/channel/lark/cli-runner.js';

class StubCli implements LarkCliRunner {
  readonly runs: Array<{ args: readonly string[]; options?: { timeoutMs?: number } }> = [];
  next: LarkCliRunResult = { stdout: '', stderr: '', exitCode: 0 };
  async run(
    args: readonly string[],
    options?: { timeoutMs?: number },
  ): Promise<LarkCliRunResult> {
    this.runs.push({ args, ...(options ? { options } : {}) });
    return this.next;
  }
  spawn(): LarkCliSpawnHandle { throw new Error('not used'); }
}

describe('read_lark_doc tool', () => {
  it('shells out to `lark-cli docs +fetch --api-version v2 --doc-format markdown`', async () => {
    const cli = new StubCli();
    cli.next = {
      stdout: JSON.stringify({ data: { content: '# Goofy 概览\n\nDeploys via XYZ.' } }),
      stderr: '', exitCode: 0,
    };
    const tool = createReadLarkDocTool({ cli });
    const r = await tool.run({ url_or_token: 'https://acme.feishu.cn/wiki/abc123' });
    expect(r.content).toBe('# Goofy 概览\n\nDeploys via XYZ.');

    const args = cli.runs[0]!.args;
    expect(args).toEqual([
      'docs', '+fetch',
      '--api-version', 'v2',
      '--doc', 'https://acme.feishu.cn/wiki/abc123',
      '--doc-format', 'markdown',
      '--as', 'user',
    ]);
  });

  it('handles raw markdown stdout (non-JSON) — returns stdout as-is', async () => {
    const cli = new StubCli();
    cli.next = { stdout: '# Doc title\n\nbody', stderr: '', exitCode: 0 };
    const tool = createReadLarkDocTool({ cli });
    const r = await tool.run({ url_or_token: 'token123' });
    expect(r.content).toBe('# Doc title\n\nbody');
  });

  it('handles JSON without a recognized content path — falls back to data payload', async () => {
    const cli = new StubCli();
    cli.next = {
      stdout: JSON.stringify({ data: { items: [{ title: 'x' }] } }),
      stderr: '', exitCode: 0,
    };
    const tool = createReadLarkDocTool({ cli });
    const r = await tool.run({ url_or_token: 't' });
    // Should JSON-stringify the data so the LLM sees structured info.
    expect(r.content).toContain('"items"');
    expect(r.content).toContain('"title": "x"');
  });

  it('truncates large content at 16KB with a clear marker', async () => {
    const cli = new StubCli();
    const big = '# huge\n' + 'lorem '.repeat(5000);
    cli.next = { stdout: big, stderr: '', exitCode: 0 };
    const tool = createReadLarkDocTool({ cli });
    const r = await tool.run({ url_or_token: 't' });
    expect(r.content.length).toBeLessThanOrEqual(big.length);
    expect(r.content).toContain('truncated');
    expect(r.content.startsWith('# huge')).toBe(true);
  });

  it('attack: lark-cli non-zero exit surfaces with stderr detail', async () => {
    const cli = new StubCli();
    cli.next = { stdout: '', stderr: 'Permission denied: missing wiki:read scope', exitCode: 1 };
    const tool = createReadLarkDocTool({ cli });
    await expect(tool.run({ url_or_token: 't' }))
      .rejects.toThrow(/Permission denied.*wiki:read/);
  });

  it('attack: missing input throws before invoking lark-cli', async () => {
    const cli = new StubCli();
    const tool = createReadLarkDocTool({ cli });
    await expect(tool.run({})).rejects.toThrow(/url_or_token/);
    await expect(tool.run({ url_or_token: '   ' })).rejects.toThrow(/url_or_token/);
    expect(cli.runs).toHaveLength(0);
  });

  it('attack: shell metacharacters in input are rejected (defensive — no command injection)', async () => {
    const cli = new StubCli();
    const tool = createReadLarkDocTool({ cli });
    for (const bad of ['token; rm -rf /', 'token`whoami`', 'token | tee out', 'token && evil']) {
      await expect(tool.run({ url_or_token: bad })).rejects.toThrow(/suspicious/);
    }
    expect(cli.runs).toHaveLength(0);
  });

  it('respects timeoutMs override (passed through to cli.run)', async () => {
    const cli = new StubCli();
    const tool = createReadLarkDocTool({ cli, timeoutMs: 5000 });
    await tool.run({ url_or_token: 't' });
    expect(cli.runs[0]?.options).toEqual({ timeoutMs: 5000 });
  });
});
