/**********************************************************************
 * Copyright (C) 2025 LobsterTrap Community
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 ***********************************************************************/

import * as extensionApi from '@podman-desktop/api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProviderType =
  | 'claude'
  | 'opencode'
  | 'codex'
  | 'copilot'
  | 'generic'
  | 'openai'
  | 'anthropic'
  | 'nvidia'
  | 'gitlab'
  | 'github'
  | 'outlook';

export const PROVIDER_TYPES: ProviderType[] = [
  'claude',
  'opencode',
  'codex',
  'copilot',
  'generic',
  'openai',
  'anthropic',
  'nvidia',
  'gitlab',
  'github',
  'outlook',
];

export const AGENT_TYPES = ['claude', 'opencode', 'codex', 'copilot'] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export interface GatewayInfo {
  name: string;
  endpoint: string;
  status: string;
  raw: string;
}

export interface SandboxInfo {
  name: string;
  id: string;
  status: string;
  age: string;
  raw: string;
}

export interface ProviderInfo {
  name: string;
  type: string;
  raw: string;
}

export interface GatewayStartOptions {
  name?: string;
  port?: number;
  gpu?: boolean;
  remote?: string;
  sshKey?: string;
  recreate?: boolean;
  plaintext?: boolean;
  disableGatewayAuth?: boolean;
  registryUsername?: string;
  registryToken?: string;
  gatewayHost?: string;
}

export interface SandboxCreateOptions {
  name?: string;
  from?: string;
  providers?: string[];
  gpu?: boolean;
  policy?: string;
  forward?: string;
  command?: string[];
  noKeep?: boolean;
  upload?: string;
  editor?: 'vscode' | 'cursor';
  tty?: boolean;
  noBootstrap?: boolean;
  autoProviders?: boolean;
}

export interface ProviderCreateOptions {
  name: string;
  type: ProviderType;
  fromExisting?: boolean;
  credentials?: string[];
  config?: string[];
}

export interface LogsOptions {
  name?: string;
  n?: number;
  tail?: boolean;
  since?: string;
  source?: string[];
  level?: string;
}

export interface DoctorLogsOptions {
  name?: string;
  lines?: number;
  tail?: boolean;
}

// ---------------------------------------------------------------------------
// CLI Wrapper
// ---------------------------------------------------------------------------

/**
 * Typed wrapper around the `openshell` CLI binary.
 *
 * All methods call `extensionApi.process.exec()` under the hood, parsing
 * stdout into structured results where possible. Errors from non-zero exit
 * codes are propagated as-is so callers can show them to the user.
 */
export class OpenShellCli {
  constructor(private binaryPath: string) {}

  /** Update the binary path (e.g. after install or user config change). */
  setPath(path: string): void {
    this.binaryPath = path;
  }

  getPath(): string {
    return this.binaryPath;
  }

  // -----------------------------------------------------------------------
  // Low-level exec
  // -----------------------------------------------------------------------

  private async exec(
    args: string[],
    options?: extensionApi.RunOptions,
  ): Promise<extensionApi.RunResult> {
    return extensionApi.process.exec(this.binaryPath, args, options);
  }

  // -----------------------------------------------------------------------
  // Version / detection
  // -----------------------------------------------------------------------

  async getVersion(): Promise<string> {
    const result = await this.exec(['--version']);
    // Output: "openshell 0.5.2" or similar
    const parts = result.stdout.trim().split(/\s+/);
    return parts.length > 1 ? parts[1] : parts[0];
  }

  // -----------------------------------------------------------------------
  // Gateway commands
  // -----------------------------------------------------------------------

  async gatewayStart(
    opts: GatewayStartOptions,
    logger?: extensionApi.Logger,
    token?: extensionApi.CancellationToken,
  ): Promise<extensionApi.RunResult> {
    const args = ['gateway', 'start'];
    if (opts.name) args.push('--name', opts.name);
    if (opts.port) args.push('--port', String(opts.port));
    if (opts.gpu) args.push('--gpu');
    if (opts.remote) args.push('--remote', opts.remote);
    if (opts.sshKey) args.push('--ssh-key', opts.sshKey);
    if (opts.recreate) args.push('--recreate');
    if (opts.plaintext) args.push('--plaintext');
    if (opts.disableGatewayAuth) args.push('--disable-gateway-auth');
    if (opts.registryUsername) args.push('--registry-username', opts.registryUsername);
    if (opts.registryToken) args.push('--registry-token', opts.registryToken);
    if (opts.gatewayHost) args.push('--gateway-host', opts.gatewayHost);
    return this.exec(args, { logger, token });
  }

  async gatewayStop(
    name?: string,
    logger?: extensionApi.Logger,
  ): Promise<extensionApi.RunResult> {
    const args = ['gateway', 'stop'];
    if (name) args.push('--name', name);
    return this.exec(args, { logger });
  }

  async gatewayDestroy(
    name?: string,
    logger?: extensionApi.Logger,
  ): Promise<extensionApi.RunResult> {
    const args = ['gateway', 'destroy'];
    if (name) args.push('--name', name);
    return this.exec(args, { logger });
  }

  async gatewayInfo(name?: string): Promise<string> {
    const args = ['gateway', 'info'];
    if (name) args.push('--name', name);
    const result = await this.exec(args);
    return result.stdout;
  }

  async gatewaySelect(name?: string): Promise<string> {
    const args = ['gateway', 'select'];
    if (name) args.push(name);
    const result = await this.exec(args);
    return result.stdout;
  }

  async gatewayAdd(
    endpoint: string,
    opts?: { name?: string; remote?: string; sshKey?: string; local?: boolean },
  ): Promise<extensionApi.RunResult> {
    const args = ['gateway', 'add', endpoint];
    if (opts?.name) args.push('--name', opts.name);
    if (opts?.remote) args.push('--remote', opts.remote);
    if (opts?.sshKey) args.push('--ssh-key', opts.sshKey);
    if (opts?.local) args.push('--local');
    return this.exec(args);
  }

  // -----------------------------------------------------------------------
  // Sandbox commands
  // -----------------------------------------------------------------------

  async sandboxCreate(
    opts: SandboxCreateOptions,
    logger?: extensionApi.Logger,
    token?: extensionApi.CancellationToken,
  ): Promise<extensionApi.RunResult> {
    const args = ['sandbox', 'create'];
    if (opts.name) args.push('--name', opts.name);
    if (opts.from) args.push('--from', opts.from);
    if (opts.gpu) args.push('--gpu');
    if (opts.policy) args.push('--policy', opts.policy);
    if (opts.forward) args.push('--forward', opts.forward);
    if (opts.noKeep) args.push('--no-keep');
    if (opts.upload) args.push('--upload', opts.upload);
    if (opts.editor) args.push('--editor', opts.editor);
    if (opts.tty === false) args.push('--no-tty');
    if (opts.noBootstrap) args.push('--no-bootstrap');
    if (opts.autoProviders) args.push('--auto-providers');
    if (opts.providers) {
      for (const p of opts.providers) {
        args.push('--provider', p);
      }
    }
    if (opts.command && opts.command.length > 0) {
      args.push('--');
      args.push(...opts.command);
    }
    return this.exec(args, { logger, token });
  }

  async sandboxList(): Promise<SandboxInfo[]> {
    const result = await this.exec(['sandbox', 'list']);
    return parseSandboxList(result.stdout);
  }

  async sandboxListNames(): Promise<string[]> {
    const result = await this.exec(['sandbox', 'list', '--names']);
    return result.stdout
      .trim()
      .split('\n')
      .filter(l => l.length > 0);
  }

  async sandboxGet(name: string): Promise<string> {
    const result = await this.exec(['sandbox', 'get', name]);
    return result.stdout;
  }

  async sandboxDelete(
    names: string[],
    logger?: extensionApi.Logger,
  ): Promise<extensionApi.RunResult> {
    return this.exec(['sandbox', 'delete', ...names], { logger });
  }

  async sandboxDeleteAll(logger?: extensionApi.Logger): Promise<extensionApi.RunResult> {
    return this.exec(['sandbox', 'delete', '--all'], { logger });
  }

  async sandboxConnect(name: string): Promise<extensionApi.RunResult> {
    return this.exec(['sandbox', 'connect', name]);
  }

  async sandboxSshConfig(name: string): Promise<string> {
    const result = await this.exec(['sandbox', 'ssh-config', name]);
    return result.stdout;
  }

  async sandboxExec(
    name: string,
    command: string[],
    opts?: { workdir?: string; timeout?: number },
  ): Promise<extensionApi.RunResult> {
    const args = ['sandbox', 'exec', '--name', name];
    if (opts?.workdir) args.push('--workdir', opts.workdir);
    if (opts?.timeout) args.push('--timeout', String(opts.timeout));
    args.push('--');
    args.push(...command);
    return this.exec(args);
  }

  // -----------------------------------------------------------------------
  // Provider commands
  // -----------------------------------------------------------------------

  async providerCreate(opts: ProviderCreateOptions): Promise<extensionApi.RunResult> {
    const args = ['provider', 'create', '--name', opts.name, '--type', opts.type];
    if (opts.fromExisting) {
      args.push('--from-existing');
    }
    if (opts.credentials) {
      for (const c of opts.credentials) {
        args.push('--credential', c);
      }
    }
    if (opts.config) {
      for (const c of opts.config) {
        args.push('--config', c);
      }
    }
    return this.exec(args);
  }

  async providerList(): Promise<ProviderInfo[]> {
    const result = await this.exec(['provider', 'list']);
    return parseProviderList(result.stdout);
  }

  async providerListNames(): Promise<string[]> {
    const result = await this.exec(['provider', 'list', '--names']);
    return result.stdout
      .trim()
      .split('\n')
      .filter(l => l.length > 0);
  }

  async providerGet(name: string): Promise<string> {
    const result = await this.exec(['provider', 'get', name]);
    return result.stdout;
  }

  async providerDelete(names: string[]): Promise<extensionApi.RunResult> {
    return this.exec(['provider', 'delete', ...names]);
  }

  async providerUpdate(
    name: string,
    opts?: { fromExisting?: boolean; credentials?: string[]; config?: string[] },
  ): Promise<extensionApi.RunResult> {
    const args = ['provider', 'update', name];
    if (opts?.fromExisting) args.push('--from-existing');
    if (opts?.credentials) {
      for (const c of opts.credentials) {
        args.push('--credential', c);
      }
    }
    if (opts?.config) {
      for (const c of opts.config) {
        args.push('--config', c);
      }
    }
    return this.exec(args);
  }

  // -----------------------------------------------------------------------
  // Logs
  // -----------------------------------------------------------------------

  async logs(opts: LogsOptions): Promise<string> {
    const args = ['logs'];
    if (opts.name) args.push(opts.name);
    if (opts.n !== undefined) args.push('-n', String(opts.n));
    if (opts.tail) args.push('--tail');
    if (opts.since) args.push('--since', opts.since);
    if (opts.source) {
      for (const s of opts.source) {
        args.push('--source', s);
      }
    }
    if (opts.level) args.push('--level', opts.level);
    const result = await this.exec(args);
    return result.stdout;
  }

  // -----------------------------------------------------------------------
  // Status
  // -----------------------------------------------------------------------

  async status(): Promise<string> {
    const result = await this.exec(['status']);
    return result.stdout;
  }

  // -----------------------------------------------------------------------
  // Doctor / Diagnostics
  // -----------------------------------------------------------------------

  async doctorCheck(): Promise<string> {
    const result = await this.exec(['doctor', 'check']);
    return result.stdout + (result.stderr ? '\n' + result.stderr : '');
  }

  async doctorLogs(opts?: DoctorLogsOptions): Promise<string> {
    const args = ['doctor', 'logs'];
    if (opts?.name) args.push('--name', opts.name);
    if (opts?.lines !== undefined) args.push('--lines', String(opts.lines));
    if (opts?.tail) args.push('--tail');
    const result = await this.exec(args);
    return result.stdout;
  }

  async doctorLlmTxt(): Promise<string> {
    const result = await this.exec(['doctor', 'llm.txt']);
    return result.stdout;
  }
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/**
 * Parse the output of `openshell sandbox list`.
 *
 * The CLI outputs a table with columns: NAME, STATUS, ID, AGE (or similar).
 * We do a best-effort parse of the tabular output.
 */
function parseSandboxList(stdout: string): SandboxInfo[] {
  const lines = stdout.trim().split('\n');
  if (lines.length < 2) return [];

  // First line is the header — detect column positions
  const header = lines[0];
  const result: SandboxInfo[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Best-effort: split on whitespace clusters
    const parts = line.split(/\s{2,}/).map(s => s.trim());
    result.push({
      name: parts[0] ?? '',
      status: parts[1] ?? '',
      id: parts[2] ?? '',
      age: parts[3] ?? '',
      raw: line,
    });
  }
  return result;
}

/**
 * Parse the output of `openshell provider list`.
 */
function parseProviderList(stdout: string): ProviderInfo[] {
  const lines = stdout.trim().split('\n');
  if (lines.length < 2) return [];

  const result: ProviderInfo[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parts = line.split(/\s{2,}/).map(s => s.trim());
    result.push({
      name: parts[0] ?? '',
      type: parts[1] ?? '',
      raw: line,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Binary detection
// ---------------------------------------------------------------------------

/**
 * Attempt to locate the openshell binary and return its path and version.
 * Tries: 1) user-configured path, 2) PATH lookup via `which`.
 */
export async function detectOpenShellBinary(
  configuredPath?: string,
): Promise<{ path: string; version: string } | undefined> {
  const candidates: string[] = [];

  if (configuredPath) {
    candidates.push(configuredPath);
  }

  // Try common install locations
  candidates.push('openshell');

  for (const candidate of candidates) {
    try {
      const result = await extensionApi.process.exec(candidate, ['--version']);
      const parts = result.stdout.trim().split(/\s+/);
      const version = parts.length > 1 ? parts[1] : parts[0];
      // Resolve full path via `which` / `where`
      let fullPath = candidate;
      try {
        const whichCmd = process.platform === 'win32' ? 'where' : 'which';
        const whichResult = await extensionApi.process.exec(whichCmd, [candidate]);
        fullPath = whichResult.stdout.trim().split('\n')[0];
      } catch {
        // which/where failed — use candidate as-is
      }
      return { path: fullPath, version };
    } catch {
      continue;
    }
  }

  return undefined;
}
