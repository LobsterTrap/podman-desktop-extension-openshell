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

import type { OpenShellCli, ProviderCreateOptions, ProviderInfo, ProviderType } from './openshell-cli';
import { PROVIDER_TYPES } from './openshell-cli';
import { showCliError, stripAnsi, escapeHtml } from './util';

/**
 * Manages OpenShell credential providers through the Podman Desktop UI.
 *
 * Providers are named credential bundles (API keys, tokens) that are injected
 * into sandboxes at creation time. The CLI auto-discovers credentials from the
 * host environment, or providers can be created explicitly with key-value pairs.
 */
export class ProviderManager {
  constructor(
    private readonly cli: OpenShellCli,
    private readonly onStateChange: () => Promise<void>,
  ) {}

  // -----------------------------------------------------------------------
  // Create
  // -----------------------------------------------------------------------

  async create(): Promise<void> {
    // Step 1: Provider name
    const name = await extensionApi.window.showInputBox({
      title: 'Provider Name',
      prompt: 'Enter a name for the provider (e.g. openai, anthropic)',
    });
    if (name === undefined || name.trim() === '') return;

    // Step 2: Provider type
    const typePick = await extensionApi.window.showQuickPick(
      PROVIDER_TYPES.map(t => ({
        label: t,
        description: this.describeProviderType(t),
      })),
      { title: 'Provider Type' },
    );
    if (typePick === undefined) return;
    const providerType = typePick.label as ProviderType;

    // Step 3: Credential source
    const sourcePick = await extensionApi.window.showQuickPick(
      [
        {
          label: 'From existing environment',
          description: 'Auto-discover credentials from env vars and local config files',
        },
        {
          label: 'Manual entry',
          description: 'Enter credential key=value pairs manually',
        },
      ],
      { title: 'Credential Source' },
    );
    if (sourcePick === undefined) return;

    const opts: ProviderCreateOptions = {
      name: name.trim(),
      type: providerType,
    };

    if (sourcePick.label === 'From existing environment') {
      opts.fromExisting = true;
    } else {
      // Collect credential pairs
      const credentials: string[] = [];
      let addMore = true;
      while (addMore) {
        const keyHint = this.getCredentialHint(providerType, credentials.length);
        const credential = await extensionApi.window.showInputBox({
          title: `Credential ${credentials.length + 1}`,
          prompt: `Enter credential as KEY=VALUE or just KEY to read from environment${keyHint}`,
          value: keyHint.replace(' (e.g. ', '').replace(')', ''),
        });
        if (credential === undefined) {
          if (credentials.length === 0) return; // cancelled with no creds
          break;
        }
        if (credential.trim()) {
          credentials.push(credential.trim());
        }

        const morePick = await extensionApi.window.showQuickPick(
          [
            { label: 'Add another credential', picked: false },
            { label: 'Done', picked: true },
          ],
          { title: 'More credentials?' },
        );
        addMore = morePick?.label === 'Add another credential';
      }
      opts.credentials = credentials;
    }

    await extensionApi.window.withProgress(
      { location: extensionApi.ProgressLocation.TASK_WIDGET, title: `Creating provider '${name}'...` },
      async progress => {
        try {
          await this.cli.providerCreate(opts);
          progress.report({ increment: -1 });
          await this.onStateChange();
          await extensionApi.window.showInformationMessage(`Provider '${name}' created successfully.`);
        } catch (err: unknown) {
          showCliError(err, 'Failed to create provider');
        }
      },
    );
  }

  // -----------------------------------------------------------------------
  // Delete
  // -----------------------------------------------------------------------

  async delete(): Promise<void> {
    const names = await this.pickProviders('Select providers to delete');
    if (!names || names.length === 0) return;

    const confirm = await extensionApi.window.showWarningMessage(
      `Delete ${names.length} provider(s): ${names.join(', ')}?`,
      'Cancel',
      'Delete',
    );
    if (confirm !== 'Delete') return;

    try {
      await this.cli.providerDelete(names);
      await this.onStateChange();
    } catch (err: unknown) {
      showCliError(err, 'Failed to delete provider(s)');
    }
  }

  // -----------------------------------------------------------------------
  // List (webview)
  // -----------------------------------------------------------------------

  async list(): Promise<void> {
    try {
      const providers = await this.cli.providerList();
      const panel = extensionApi.window.createWebviewPanel('openshell-provider-list', 'OpenShell Providers');
      panel.webview.html = this.renderListHtml(providers);

      panel.webview.onDidReceiveMessage(async (msg: unknown) => {
        const message = msg as { command: string; name?: string };
        switch (message.command) {
          case 'refresh':
            try {
              const refreshed = await this.cli.providerList();
              panel.webview.html = this.renderListHtml(refreshed);
            } catch (err: unknown) {
              showCliError(err, 'Failed to refresh provider list');
            }
            break;
          case 'delete':
            if (message.name) {
              const c = await extensionApi.window.showWarningMessage(
                `Delete provider '${message.name}'?`,
                'Cancel',
                'Delete',
              );
              if (c === 'Delete') {
                try {
                  await this.cli.providerDelete([message.name]);
                  await this.onStateChange();
                  const refreshed = await this.cli.providerList();
                  panel.webview.html = this.renderListHtml(refreshed);
                } catch (err: unknown) {
                  showCliError(err, 'Failed to delete provider');
                }
              }
            }
            break;
          case 'details':
            if (message.name) {
              await this.get(message.name);
            }
            break;
          case 'update':
            if (message.name) {
              await this.update(message.name);
            }
            break;
        }
      });
    } catch (err: unknown) {
      showCliError(err, 'Failed to list providers');
    }
  }

  // -----------------------------------------------------------------------
  // Get (details)
  // -----------------------------------------------------------------------

  async get(name?: string): Promise<void> {
    const providerName = name || (await this.pickProvider('Select provider'));
    if (!providerName) return;

    try {
      const output = await this.cli.providerGet(providerName);
      const panel = extensionApi.window.createWebviewPanel(
        'openshell-provider-detail',
        `Provider: ${providerName}`,
      );
      panel.webview.html = this.renderDetailHtml(providerName, stripAnsi(output));
    } catch (err: unknown) {
      showCliError(err, 'Failed to get provider details');
    }
  }

  // -----------------------------------------------------------------------
  // Update
  // -----------------------------------------------------------------------

  async update(name?: string): Promise<void> {
    const providerName = name || (await this.pickProvider('Select provider to update'));
    if (!providerName) return;

    const sourcePick = await extensionApi.window.showQuickPick(
      [
        { label: 'Re-discover from environment', description: 'Auto-discover credentials from env vars' },
        { label: 'Manual update', description: 'Enter new credential key=value pairs' },
      ],
      { title: 'Update Method' },
    );
    if (!sourcePick) return;

    const opts: { fromExisting?: boolean; credentials?: string[] } = {};

    if (sourcePick.label === 'Re-discover from environment') {
      opts.fromExisting = true;
    } else {
      const credentials: string[] = [];
      let addMore = true;
      while (addMore) {
        const credential = await extensionApi.window.showInputBox({
          title: `Credential ${credentials.length + 1}`,
          prompt: 'Enter credential as KEY=VALUE or just KEY to read from environment',
        });
        if (credential === undefined) break;
        if (credential.trim()) {
          credentials.push(credential.trim());
        }
        const morePick = await extensionApi.window.showQuickPick(
          [
            { label: 'Add another credential' },
            { label: 'Done' },
          ],
          { title: 'More credentials?' },
        );
        addMore = morePick?.label === 'Add another credential';
      }
      if (credentials.length > 0) {
        opts.credentials = credentials;
      }
    }

    try {
      await this.cli.providerUpdate(providerName, opts);
      await this.onStateChange();
      await extensionApi.window.showInformationMessage(`Provider '${providerName}' updated.`);
    } catch (err: unknown) {
      showCliError(err, 'Failed to update provider');
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private async pickProvider(title: string): Promise<string | undefined> {
    try {
      const names = await this.cli.providerListNames();
      if (names.length === 0) {
        await extensionApi.window.showInformationMessage('No providers found.');
        return undefined;
      }
      const pick = await extensionApi.window.showQuickPick(
        names.map(n => ({ label: n })),
        { title },
      );
      return pick?.label;
    } catch {
      return extensionApi.window.showInputBox({ title, prompt: 'Enter provider name' });
    }
  }

  private async pickProviders(title: string): Promise<string[] | undefined> {
    try {
      const names = await this.cli.providerListNames();
      if (names.length === 0) {
        await extensionApi.window.showInformationMessage('No providers found.');
        return undefined;
      }
      const picks = await extensionApi.window.showQuickPick(
        names.map(n => ({ label: n })),
        { title, canPickMany: true },
      );
      return picks?.map(p => p.label);
    } catch {
      const name = await extensionApi.window.showInputBox({ title, prompt: 'Enter provider name' });
      return name ? [name] : undefined;
    }
  }

  /** Return a hint for the most common credential key for a given provider type. */
  private getCredentialHint(type: ProviderType, index: number): string {
    if (index > 0) return '';
    const hints: Record<string, string> = {
      claude: ' (e.g. ANTHROPIC_API_KEY)',
      anthropic: ' (e.g. ANTHROPIC_API_KEY)',
      openai: ' (e.g. OPENAI_API_KEY)',
      codex: ' (e.g. OPENAI_API_KEY)',
      opencode: ' (e.g. OPENAI_API_KEY)',
      copilot: ' (e.g. GITHUB_TOKEN)',
      github: ' (e.g. GITHUB_TOKEN)',
      nvidia: ' (e.g. NVIDIA_API_KEY)',
      gitlab: ' (e.g. GITLAB_TOKEN)',
    };
    return hints[type] ?? '';
  }

  /** Provide a human-readable description for each provider type. */
  private describeProviderType(type: ProviderType): string {
    const descriptions: Record<string, string> = {
      claude: 'Anthropic Claude Code — uses ANTHROPIC_API_KEY',
      opencode: 'OpenCode — uses OPENAI_API_KEY or OPENROUTER_API_KEY',
      codex: 'OpenAI Codex — uses OPENAI_API_KEY',
      copilot: 'GitHub Copilot — uses GITHUB_TOKEN or COPILOT_GITHUB_TOKEN',
      generic: 'Generic provider — custom credentials',
      openai: 'OpenAI API — uses OPENAI_API_KEY',
      anthropic: 'Anthropic API — uses ANTHROPIC_API_KEY',
      nvidia: 'NVIDIA API — uses NVIDIA_API_KEY',
      gitlab: 'GitLab — uses GITLAB_TOKEN',
      github: 'GitHub — uses GITHUB_TOKEN',
      outlook: 'Outlook — uses Outlook credentials',
    };
    return descriptions[type] ?? '';
  }

  // -----------------------------------------------------------------------
  // HTML renderers
  // -----------------------------------------------------------------------

  private renderListHtml(providers: ProviderInfo[]): string {
    const rows = providers
      .map(
        p => `
        <tr>
          <td>${escapeHtml(p.name)}</td>
          <td>${escapeHtml(p.type)}</td>
          <td class="actions">
            <button onclick="send('details', '${escapeHtml(p.name)}')">Details</button>
            <button onclick="send('update', '${escapeHtml(p.name)}')">Update</button>
            <button onclick="send('delete', '${escapeHtml(p.name)}')" class="danger">Delete</button>
          </td>
        </tr>`,
      )
      .join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: var(--pd-details-body-font-family, 'IBM Plex Sans', system-ui, sans-serif);
      color: var(--pd-details-body-text, #e7e7e7);
      background: var(--pd-details-bg, #1e1e1e);
      padding: 1rem 1.5rem;
      line-height: 1.6;
    }
    h2 { margin-top: 0; }
    table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; }
    th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--pd-content-divider, #444); }
    th { font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--pd-content-header-text, #aaa); }
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
    <h2>Providers</h2>
    <button onclick="send('refresh')">↻ Refresh</button>
  </div>
  ${
    providers.length === 0
      ? '<div class="empty">No providers found. Create one with <strong>OpenShell: Create Provider</strong>.</div>'
      : `<table>
    <thead><tr><th>Name</th><th>Type</th><th>Actions</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`
  }
  <script>
    const vscode = acquireVsCodeApi();
    function send(command, name) {
      vscode.postMessage({ command, name });
    }
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
    body {
      font-family: var(--pd-details-body-font-family, 'IBM Plex Sans', system-ui, sans-serif);
      color: var(--pd-details-body-text, #e7e7e7);
      background: var(--pd-details-bg, #1e1e1e);
      padding: 1rem 1.5rem;
      line-height: 1.6;
    }
    h2 { margin-top: 0; }
    pre { background: var(--pd-content-bg, #292929); border: 1px solid var(--pd-content-divider, #444); border-radius: 6px; padding: 1rem; overflow-x: auto; white-space: pre-wrap; word-break: break-word; font-size: 13px; }
    .note { font-size: 12px; color: var(--pd-content-header-text, #aaa); margin-top: 0.5rem; }
  </style>
</head>
<body>
  <h2>Provider: ${escapeHtml(name)}</h2>
  <pre>${escapeHtml(text)}</pre>
  <p class="note">Credential values are never displayed. Use <strong>OpenShell: Update Provider</strong> to change credentials.</p>
</body>
</html>`;
  }
}
