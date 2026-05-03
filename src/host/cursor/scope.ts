/**
 * Scope inference for `/allow!` / `/deny!` rule remembering.
 *
 * Path-based tools (Write/Edit/Delete/...) remember by the project root so
 * users don't have to /allow! every individual file. Shell commands remember
 * a command prefix; MCP tools remember the exact mcp__server__tool name
 * because their arguments are typically empty or volatile JSON.
 *
 * Ported from agent2lark-cursor's normalize.js but kept in its own module
 * for unit-testability.
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

const PATH_BASED_TOOLS: ReadonlySet<string> = new Set([
  'Write', 'Edit', 'Delete', 'ApplyPatch', 'MultiEdit',
]);

const PACKAGE_MANAGER_COMMANDS: ReadonlySet<string> = new Set(['pnpm', 'npm', 'yarn', 'bun']);

const PROJECT_MARKERS = [
  '.git', 'package.json', 'pnpm-workspace.yaml', 'yarn.lock', 'package-lock.json',
  'pyproject.toml', 'go.mod', 'Cargo.toml',
];

export interface RuleScope {
  commandPrefix: string;
  pathPrefix: string;
  toolScope?: boolean;
}

export interface ScopeInput {
  tool: string;
  command?: string;
  cwd?: string;
}

export function isRiskyPreToolUse(toolName: string): boolean {
  return /^(Bash|Shell|Write|Edit|Delete|ApplyPatch|MultiEdit)$/i.test(toolName)
    || /^mcp__/i.test(toolName)
    || /^MCP:/i.test(toolName);
}

export function isPathBasedTool(toolName: string): boolean {
  return PATH_BASED_TOOLS.has(toolName);
}

function ensureTrailingSlash(value: string): string {
  if (!value) return '';
  return value.endsWith('/') ? value : `${value}/`;
}

function absolutePathFromCommand(command: string): string {
  const text = command.trim();
  if (!text) return '';
  if (path.isAbsolute(text)) return text;
  const firstToken = text.split(/\s+/, 1)[0] ?? '';
  return path.isAbsolute(firstToken) ? firstToken : '';
}

function safeIsDirectory(target: string): boolean {
  try { return existsSync(target) && statSync(target).isDirectory(); }
  catch { return false; }
}

function hasProjectMarker(directory: string): boolean {
  return PROJECT_MARKERS.some((marker) => existsSync(path.join(directory, marker)));
}

function findProjectRootForPath(target: string): string {
  const absolutePath = absolutePathFromCommand(target);
  if (!absolutePath) return '';
  let current = safeIsDirectory(absolutePath) ? absolutePath : path.dirname(absolutePath);
  while (current && current !== path.dirname(current)) {
    if (hasProjectMarker(current)) return current;
    current = path.dirname(current);
  }
  return '';
}

export function inferRuleScope(input: ScopeInput): RuleScope {
  const tool = input.tool ?? '';
  const command = input.command ?? '';
  const cwd = input.cwd ?? '';

  if (tool.startsWith('mcp__')) {
    return { commandPrefix: '', pathPrefix: '', toolScope: true };
  }

  if (isPathBasedTool(tool)) {
    const projectRoot = findProjectRootForPath(command) || cwd;
    if (projectRoot) {
      return { pathPrefix: ensureTrailingSlash(projectRoot), commandPrefix: '' };
    }
  }

  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { commandPrefix: '', pathPrefix: '' };

  if ((tool === 'Shell' || tool === 'Bash') && PACKAGE_MANAGER_COMMANDS.has(tokens[0]!)) {
    return { commandPrefix: tokens[0]!, pathPrefix: '' };
  }

  if (tokens.length === 1) return { commandPrefix: tokens[0]!, pathPrefix: '' };
  return { commandPrefix: `${tokens[0]} ${tokens[1]}`, pathPrefix: '' };
}
