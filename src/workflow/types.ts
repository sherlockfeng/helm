import type { Screenshot } from '../storage/types.js';

export interface CreateTaskInput {
  role: 'dev' | 'test';
  title: string;
  description?: string;
  acceptance?: string[];
  e2eScenarios?: string[];
}

export interface CompleteTaskInput {
  result: string;
  docAuditToken?: string;
}

export interface CompleteCycleInput {
  passRate?: number;
  failedTests?: string[];
  screenshots?: Screenshot[];
}

export interface BugInput {
  title: string;
  description?: string;
  expected?: string;
  actual?: string;
  screenshotDescription?: string;
}
