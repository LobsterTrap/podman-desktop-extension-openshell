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

import type { OpenShellCli, GatewayStartOptions } from './openshell-cli';
import { showCliError, stripAnsi, escapeHtml } from './util';

/**
 * Manages the OpenShell gateway lifecycle through the Podman Desktop UI.
 *
 * All operations are thin wrappers around the `openshell gateway` CLI
 * commands, surfaced as interactive dialogs with progress reporting.
 */
export class GatewayManager {
  constructor(
    private readonly cli: OpenShellCli,
    private readonly onStateChange: () => Promise<void>,
  ) {}

  // -----------------------------------------------------------------------
  // Start
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    // Gather options from user input
    const name = await extensionApi.window.showInputBox({
      title: 'Gateway Name',
      prompt: 'Enter a name for the gateway',
      value: extensionApi.configuration.getConfiguration('openshell').get<string>('gateway.name') ?? 'openshell',
    });
    if (name === undefined) return; // cancelled

    const portStr = await extensionApi.window.showInputBox({
      title: 'Gateway Port',
      prompt: 'Host port to map to the gateway',
      value: String(extensionApi.configuration.getConfiguration('openshell').get<number>('gateway.port') ?? 8080),
    });
    if (portStr === undefined) return;
    const port = parseInt(portStr, 10) || 8080;

    const gpuDefault = extensionApi.configuration.getConfiguration('openshell').get<boolean>('gateway.gpu') ?? false;
    const extras = await extensionApi.window.showQuickPick(
      [
        { label: 'GPU passthrough', description: 'Pass host NVIDIA GPUs into the gateway', picked: gpuDefault },
        { label: 'Recreate', description: 'Destroy and recreate if a gateway already exists', picked: false },
      ],
      { title: 'Gateway Options', canPickMany: true },
    );
    if (extras === undefined) return;
    const gpu = extras.some(e => e.label === 'GPU passthrough');
    const recreate = extras.some(e => e.label === 'Recreate');

    // Optional: remote deployment
    const remoteChoice = await extensionApi.window.showQuickPick(
      [
        { label: 'Local', description: 'Deploy on this machine' },
        { label: 'Remote', description: 'Deploy on a remote host via SSH' },
      ],
      { title: 'Deployment Target' },
    );
    if (remoteChoice === undefined) return;

    let remote: string | undefined;
    let sshKey: string | undefined;
    if (remoteChoice.label === 'Remote') {
      remote = await extensionApi.window.showInputBox({
        title: 'Remote Host',
        prompt: 'SSH destination (e.g. user@hostname)',
      });
      if (remote === undefined) return;

      sshKey = await extensionApi.window.showInputBox({
        title: 'SSH Key',
        prompt: 'Path to SSH private key (leave blank for default)',
        value: '',
      });
    }

    const opts: GatewayStartOptions = { name, port, gpu, recreate, remote, sshKey };

    await extensionApi.window.withProgress(
      { location: extensionApi.ProgressLocation.TASK_WIDGET, title: `Starting OpenShell gateway '${name}'...` },
      async progress => {
        try {
          await this.cli.gatewayStart(opts);
          progress.report({ increment: -1 });
          await this.onStateChange();
        } catch (err: unknown) {
          showCliError(err, 'Failed to start gateway');
        }
      },
    );
  }

  // -----------------------------------------------------------------------
  // Stop
  // -----------------------------------------------------------------------

  async stop(): Promise<void> {
    const name = await this.pickGateway('Select gateway to stop');
    if (name === undefined) return;

    const confirm = await extensionApi.window.showWarningMessage(
      `Stop gateway '${name}'? State will be preserved.`,
      'Cancel',
      'Stop',
    );
    if (confirm !== 'Stop') return;

    await extensionApi.window.withProgress(
      { location: extensionApi.ProgressLocation.TASK_WIDGET, title: `Stopping gateway '${name}'...` },
      async progress => {
        try {
          await this.cli.gatewayStop(name);
          progress.report({ increment: -1 });
          await this.onStateChange();
        } catch (err: unknown) {
          showCliError(err, 'Failed to stop gateway');
        }
      },
    );
  }

  // -----------------------------------------------------------------------
  // Destroy
  // -----------------------------------------------------------------------

  async destroy(): Promise<void> {
    const name = await this.pickGateway('Select gateway to destroy');
    if (name === undefined) return;

    const confirm = await extensionApi.window.showWarningMessage(
      `⚠️ Destroy gateway '${name}'? This will permanently delete all gateway state and sandboxes.`,
      'Cancel',
      'Destroy',
    );
    if (confirm !== 'Destroy') return;

    await extensionApi.window.withProgress(
      { location: extensionApi.ProgressLocation.TASK_WIDGET, title: `Destroying gateway '${name}'...` },
      async progress => {
        try {
          await this.cli.gatewayDestroy(name);
          progress.report({ increment: -1 });
          await this.onStateChange();
        } catch (err: unknown) {
          showCliError(err, 'Failed to destroy gateway');
        }
      },
    );
  }

  // -----------------------------------------------------------------------
  // Select
  // -----------------------------------------------------------------------

  async select(): Promise<void> {
    try {
      // Get list of gateways by running gateway select without a name
      // in non-interactive mode (which lists them)
      const output = await this.cli.gatewaySelect();
      const lines = stripAnsi(output)
        .trim()
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0);

      if (lines.length === 0) {
        const action = await extensionApi.window.showInformationMessage(
          'No gateways found. Would you like to start one?',
          'Cancel',
          'Start Gateway',
        );
        if (action === 'Start Gateway') {
          await this.start();
        }
        return;
      }

      const pick = await extensionApi.window.showQuickPick(
        lines.map(l => ({ label: l })),
        { title: 'Select Active Gateway' },
      );
      if (!pick) return;

      // Extract the gateway name (first token on the line)
      const gatewayName = pick.label.split(/\s+/)[0];
      await this.cli.gatewaySelect(gatewayName);
      await this.onStateChange();
    } catch (err: unknown) {
      showCliError(err, 'Failed to list gateways');
    }
  }

  // -----------------------------------------------------------------------
  // Info
  // -----------------------------------------------------------------------

  async info(): Promise<void> {
    try {
      const output = await this.cli.gatewayInfo();
      const cleaned = stripAnsi(output);

      const panel = extensionApi.window.createWebviewPanel('openshell-gateway-info', 'OpenShell Gateway Info');
      panel.webview.html = this.renderInfoHtml(cleaned);
    } catch (err: unknown) {
      showCliError(err, 'Failed to get gateway info');
    }
  }

  // -----------------------------------------------------------------------
  // Add
  // -----------------------------------------------------------------------

  async add(): Promise<void> {
    const endpoint = await extensionApi.window.showInputBox({
      title: 'Gateway Endpoint',
      prompt: 'Gateway endpoint URL (e.g. https://10.0.0.5:8080 or ssh://user@host:8080)',
    });
    if (endpoint === undefined) return;

    const name = await extensionApi.window.showInputBox({
      title: 'Gateway Name',
      prompt: 'Name for this gateway (leave blank to auto-derive from endpoint)',
      value: '',
    });
    if (name === undefined) return;

    const modeChoice = await extensionApi.window.showQuickPick(
      [
        { label: 'Edge (cloud)', description: 'Edge-authenticated gateway — opens browser for login' },
        { label: 'Local mTLS', description: 'Local gateway running in Docker/Podman on this machine' },
        { label: 'Remote mTLS', description: 'Remote gateway accessible via SSH' },
      ],
      { title: 'Authentication Mode' },
    );
    if (!modeChoice) return;

    const opts: { name?: string; remote?: string; sshKey?: string; local?: boolean } = {};
    if (name) opts.name = name;

    if (modeChoice.label === 'Local mTLS') {
      opts.local = true;
    } else if (modeChoice.label === 'Remote mTLS') {
      opts.remote = await extensionApi.window.showInputBox({
        title: 'Remote Host',
        prompt: 'SSH destination (e.g. user@hostname)',
      });
      if (opts.remote === undefined) return;
    }

    try {
      await this.cli.gatewayAdd(endpoint, opts);
      await extensionApi.window.showInformationMessage(`Gateway added: ${name || endpoint}`);
      await this.onStateChange();
    } catch (err: unknown) {
      showCliError(err, 'Failed to add gateway');
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /**
   * Show a QuickPick to let the user choose a gateway.
   * Falls back to a text input if listing fails.
   */
  private async pickGateway(title: string): Promise<string | undefined> {
    try {
      const output = await this.cli.gatewaySelect();
      const lines = stripAnsi(output)
        .trim()
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0);

      if (lines.length === 0) {
        return extensionApi.window.showInputBox({ title, prompt: 'Enter gateway name' });
      }

      const pick = await extensionApi.window.showQuickPick(
        lines.map(l => ({ label: l.split(/\s+/)[0], description: l })),
        { title },
      );
      return pick?.label;
    } catch {
      return extensionApi.window.showInputBox({ title, prompt: 'Enter gateway name' });
    }
  }

  private renderInfoHtml(text: string): string {
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
    pre {
      background: var(--pd-content-bg, #292929);
      border: 1px solid var(--pd-content-divider, #444);
      border-radius: 6px;
      padding: 1rem;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 13px;
    }
    h2 { margin-top: 0; }
  </style>
</head>
<body>
  <h2>Gateway Info</h2>
  <pre>${escapeHtml(text)}</pre>
</body>
</html>`;
  }
}
