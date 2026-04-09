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

import type { OpenShellCli, SandboxCreateOptions, SandboxInfo } from './openshell-cli';
import { AGENT_TYPES } from './openshell-cli';
import { createTerminalPanel } from './sandbox-terminal';
import { showCliError, stripAnsi, escapeHtml } from './util';

/**
 * Manages the OpenShell sandbox lifecycle through interactive Podman Desktop dialogs.
 */
export class SandboxManager {
  constructor(
    private readonly cli: OpenShellCli,
    private readonly onStateChange: () => Promise<void>,
  ) {}

  // -----------------------------------------------------------------------
  // Create
  // -----------------------------------------------------------------------

  async create(): Promise<void> {
    // Step 1: Agent selection
    const agentItems = [
      ...AGENT_TYPES.map(a => ({ label: a, description: `Launch ${a} agent` })),
      { label: '(none)', description: 'Interactive shell — no agent' },
    ];
    const agentPick = await extensionApi.window.showQuickPick(agentItems, {
      title: 'Select Agent',
    });
    if (agentPick === undefined) return;

    // Step 2: Sandbox name
    const name = await extensionApi.window.showInputBox({
      title: 'Sandbox Name',
      prompt: 'Enter a name (leave blank for auto-generated)',
      value: '',
    });
    if (name === undefined) return;

    // Step 3: Image source
    const fromPick = await extensionApi.window.showQuickPick(
      [
        { label: 'Default (base)', description: 'Use the default base sandbox image' },
        { label: 'Community', description: 'Specify a community sandbox name (e.g. openclaw, ollama)' },
        { label: 'Custom image', description: 'Specify a container image reference' },
        { label: 'Local Dockerfile', description: 'Build from a local Dockerfile/directory' },
      ],
      { title: 'Sandbox Source' },
    );
    if (fromPick === undefined) return;

    let from: string | undefined;
    if (fromPick.label === 'Community') {
      from = await extensionApi.window.showInputBox({
        title: 'Community Sandbox',
        prompt: 'Enter community sandbox name (e.g. openclaw, ollama)',
      });
      if (from === undefined) return;
    } else if (fromPick.label === 'Custom image') {
      from = await extensionApi.window.showInputBox({
        title: 'Container Image',
        prompt: 'Enter full image reference (e.g. registry.io/org/image:tag)',
      });
      if (from === undefined) return;
    } else if (fromPick.label === 'Local Dockerfile') {
      from = await extensionApi.window.showInputBox({
        title: 'Dockerfile Path',
        prompt: 'Enter path to Dockerfile or directory containing one',
      });
      if (from === undefined) return;
    }

    // Step 4: Attach providers
    let providers: string[] = [];
    try {
      const availableProviders = await this.cli.providerListNames();
      if (availableProviders.length > 0) {
        const providerPicks = await extensionApi.window.showQuickPick(
          availableProviders.map(p => ({ label: p, picked: false })),
          { title: 'Attach Providers (optional)', canPickMany: true },
        );
        if (providerPicks) {
          providers = providerPicks.map(p => p.label);
        }
      }
    } catch {
      // Provider listing failed — proceed without
    }

    // Step 5: Additional options
    const optionItems = [
      { label: 'GPU passthrough', description: 'Request GPU resources', picked: false },
      { label: 'Auto-create providers', description: 'Auto-create missing providers from local credentials', picked: true },
    ];
    const optionPicks = await extensionApi.window.showQuickPick(optionItems, {
      title: 'Sandbox Options',
      canPickMany: true,
    });
    if (optionPicks === undefined) return;
    const gpu = optionPicks.some(o => o.label === 'GPU passthrough');
    const autoProviders = optionPicks.some(o => o.label === 'Auto-create providers');

    // Build the create options
    const opts: SandboxCreateOptions = {
      name: name || undefined,
      from,
      providers: providers.length > 0 ? providers : undefined,
      gpu,
      autoProviders,
      tty: false, // non-interactive from the extension
    };
    if (agentPick.label !== '(none)') {
      opts.command = [agentPick.label];
    }

    await extensionApi.window.withProgress(
      {
        location: extensionApi.ProgressLocation.TASK_WIDGET,
        title: `Creating OpenShell sandbox${name ? ` '${name}'` : ''}...`,
      },
      async progress => {
        try {
          await this.cli.sandboxCreate(opts);
          progress.report({ increment: -1 });
          await this.onStateChange();
          await extensionApi.window.showInformationMessage(
            `Sandbox${name ? ` '${name}'` : ''} created successfully.`,
          );
        } catch (err: unknown) {
          showCliError(err, 'Failed to create sandbox');
        }
      },
    );
  }

  // -----------------------------------------------------------------------
  // Delete
  // -----------------------------------------------------------------------

  async delete(): Promise<void> {
    const names = await this.pickSandboxes('Select sandboxes to delete');
    if (!names || names.length === 0) return;

    const confirm = await extensionApi.window.showWarningMessage(
      `Delete ${names.length} sandbox(es): ${names.join(', ')}?`,
      'Cancel',
      'Delete',
    );
    if (confirm !== 'Delete') return;

    await extensionApi.window.withProgress(
      { location: extensionApi.ProgressLocation.TASK_WIDGET, title: 'Deleting sandboxes...' },
      async progress => {
        try {
          await this.cli.sandboxDelete(names);
          progress.report({ increment: -1 });
          await this.onStateChange();
        } catch (err: unknown) {
          showCliError(err, 'Failed to delete sandbox(es)');
        }
      },
    );
  }

  // -----------------------------------------------------------------------
  // Connect
  // -----------------------------------------------------------------------

  async connect(): Promise<void> {
    const name = await this.pickSandbox('Select sandbox to connect');
    if (!name) return;

    // Create an interactive terminal panel backed by ssh2 + openshell ssh-proxy.
    // The panel manages the full lifecycle: PTY allocation, bidirectional I/O,
    // resize events, and cleanup on close.
    createTerminalPanel(
      this.cli,
      name,
      (viewType, title) => extensionApi.window.createWebviewPanel(viewType, title),
    );
  }

  // -----------------------------------------------------------------------
  // List (webview)
  // -----------------------------------------------------------------------

  async list(): Promise<void> {
    try {
      const sandboxes = await this.cli.sandboxList();
      const panel = extensionApi.window.createWebviewPanel('openshell-sandbox-list', 'OpenShell Sandboxes');
      panel.webview.html = this.renderListHtml(sandboxes);

      // Handle messages from webview (action buttons)
      panel.webview.onDidReceiveMessage(async (msg: unknown) => {
        const message = msg as { command: string; name?: string };
        switch (message.command) {
          case 'refresh':
            try {
              const refreshed = await this.cli.sandboxList();
              await panel.webview.postMessage({ command: 'update', sandboxes: refreshed });
            } catch (err: unknown) {
              showCliError(err, 'Failed to refresh sandbox list');
            }
            break;
          case 'delete':
            if (message.name) {
              const c = await extensionApi.window.showWarningMessage(
                `Delete sandbox '${message.name}'?`,
                'Cancel',
                'Delete',
              );
              if (c === 'Delete') {
                try {
                  await this.cli.sandboxDelete([message.name]);
                  await this.onStateChange();
                  const refreshed = await this.cli.sandboxList();
                  await panel.webview.postMessage({ command: 'update', sandboxes: refreshed });
                } catch (err: unknown) {
                  showCliError(err, 'Failed to delete sandbox');
                }
              }
            }
            break;
          case 'connect':
            if (message.name) {
              await this.connect();
            }
            break;
          case 'details':
            if (message.name) {
              await this.get(message.name);
            }
            break;
        }
      });
    } catch (err: unknown) {
      showCliError(err, 'Failed to list sandboxes');
    }
  }

  // -----------------------------------------------------------------------
  // Get (details)
  // -----------------------------------------------------------------------

  async get(name?: string): Promise<void> {
    const sandboxName = name || (await this.pickSandbox('Select sandbox'));
    if (!sandboxName) return;

    try {
      const output = await this.cli.sandboxGet(sandboxName);
      const panel = extensionApi.window.createWebviewPanel(
        'openshell-sandbox-detail',
        `Sandbox: ${sandboxName}`,
      );
      panel.webview.html = this.renderDetailHtml(sandboxName, stripAnsi(output));
    } catch (err: unknown) {
      showCliError(err, 'Failed to get sandbox details');
    }
  }

  // -----------------------------------------------------------------------
  // Exec
  // -----------------------------------------------------------------------

  async exec(): Promise<void> {
    const name = await this.pickSandbox('Select sandbox for exec');
    if (!name) return;

    const command = await extensionApi.window.showInputBox({
      title: 'Command',
      prompt: 'Enter command to execute in the sandbox',
      value: 'ls -la /workspace',
    });
    if (command === undefined) return;

    const args = command.split(/\s+/);

    try {
      const result = await this.cli.sandboxExec(name, args);
      const panel = extensionApi.window.createWebviewPanel('openshell-exec-output', `Exec: ${name}`);
      panel.webview.html = this.renderExecOutputHtml(name, command, stripAnsi(result.stdout));
    } catch (err: unknown) {
      showCliError(err, 'Failed to execute command in sandbox');
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private async pickSandbox(title: string): Promise<string | undefined> {
    try {
      const names = await this.cli.sandboxListNames();
      if (names.length === 0) {
        await extensionApi.window.showInformationMessage('No sandboxes found.');
        return undefined;
      }
      const pick = await extensionApi.window.showQuickPick(
        names.map(n => ({ label: n })),
        { title },
      );
      return pick?.label;
    } catch {
      return extensionApi.window.showInputBox({ title, prompt: 'Enter sandbox name' });
    }
  }

  private async pickSandboxes(title: string): Promise<string[] | undefined> {
    try {
      const names = await this.cli.sandboxListNames();
      if (names.length === 0) {
        await extensionApi.window.showInformationMessage('No sandboxes found.');
        return undefined;
      }
      const picks = await extensionApi.window.showQuickPick(
        names.map(n => ({ label: n })),
        { title, canPickMany: true },
      );
      return picks?.map(p => p.label);
    } catch {
      const name = await extensionApi.window.showInputBox({ title, prompt: 'Enter sandbox name' });
      return name ? [name] : undefined;
    }
  }

  // -----------------------------------------------------------------------
  // HTML renderers
  // -----------------------------------------------------------------------

  private renderListHtml(sandboxes: SandboxInfo[]): string {
    const rows = sandboxes
      .map(
        s => `
        <tr>
          <td>${escapeHtml(s.name)}</td>
          <td><span class="status status-${s.status.toLowerCase()}">${escapeHtml(s.status)}</span></td>
          <td class="mono">${escapeHtml(s.id)}</td>
          <td>${escapeHtml(s.age)}</td>
          <td class="actions">
            <button onclick="send('details', '${escapeHtml(s.name)}')">Details</button>
            <button onclick="send('delete', '${escapeHtml(s.name)}')" class="danger">Delete</button>
          </td>
        </tr>`,
      )
      .join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    ${this.commonStyles()}
    table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; }
    th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--pd-content-divider, #444); }
    th { font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--pd-content-header-text, #aaa); }
    .mono { font-family: monospace; font-size: 12px; }
    .status { padding: 2px 8px; border-radius: 10px; font-size: 12px; font-weight: 500; }
    .status-running, .status-ready { background: #1e4620; color: #4caf50; }
    .status-stopped, .status-terminated { background: #4a1a1a; color: #e57373; }
    .status-pending, .status-creating { background: #4a3800; color: #ffc107; }
    .actions { white-space: nowrap; }
    .actions button { margin-right: 4px; }
    button { background: var(--pd-button-primary-bg, #0078d4); color: #fff; border: none; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
    button:hover { opacity: 0.85; }
    button.danger { background: #c62828; }
    .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
    .empty { text-align: center; padding: 2rem; color: var(--pd-content-header-text, #aaa); }
  </style>
</head>
<body>
  <div class="toolbar">
    <h2>Sandboxes</h2>
    <button onclick="send('refresh')">↻ Refresh</button>
  </div>
  ${
    sandboxes.length === 0
      ? '<div class="empty">No sandboxes found. Create one with <strong>OpenShell: Create Sandbox</strong>.</div>'
      : `<table>
    <thead><tr><th>Name</th><th>Status</th><th>ID</th><th>Age</th><th>Actions</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`
  }
  <script>
    const vscode = acquireVsCodeApi();
    function send(command, name) {
      vscode.postMessage({ command, name });
    }
    window.addEventListener('message', e => {
      if (e.data?.command === 'update') {
        // Reload to show updated list (simple approach)
        document.body.innerHTML = '<div class="empty">Refreshing...</div>';
      }
    });
  </script>
</body>
</html>`;
  }

  private renderDetailHtml(name: string, text: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    ${this.commonStyles()}
    pre { background: var(--pd-content-bg, #292929); border: 1px solid var(--pd-content-divider, #444); border-radius: 6px; padding: 1rem; overflow-x: auto; white-space: pre-wrap; word-break: break-word; font-size: 13px; }
  </style>
</head>
<body>
  <h2>Sandbox: ${escapeHtml(name)}</h2>
  <pre>${escapeHtml(text)}</pre>
</body>
</html>`;
  }

  private renderExecOutputHtml(name: string, command: string, output: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    ${this.commonStyles()}
    pre { background: var(--pd-content-bg, #292929); border: 1px solid var(--pd-content-divider, #444); border-radius: 6px; padding: 1rem; overflow-x: auto; white-space: pre-wrap; word-break: break-word; font-size: 13px; }
    .cmd { color: var(--pd-content-header-text, #aaa); font-size: 13px; margin-bottom: 0.5rem; }
  </style>
</head>
<body>
  <h2>Exec: ${escapeHtml(name)}</h2>
  <p class="cmd">$ ${escapeHtml(command)}</p>
  <pre>${escapeHtml(output)}</pre>
</body>
</html>`;
  }

  private commonStyles(): string {
    return `
    body {
      font-family: var(--pd-details-body-font-family, 'IBM Plex Sans', system-ui, sans-serif);
      color: var(--pd-details-body-text, #e7e7e7);
      background: var(--pd-details-bg, #1e1e1e);
      padding: 1rem 1.5rem;
      line-height: 1.6;
    }
    h2 { margin-top: 0; }`;
  }
}
