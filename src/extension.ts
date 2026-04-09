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

import { OpenShellCli, detectOpenShellBinary } from './openshell-cli';
import { GatewayManager } from './gateway-manager';
import { SandboxManager } from './sandbox-manager';
import { ProviderManager } from './provider-manager';
import { LogViewer } from './log-viewer';
import { DiagnosticsViewer } from './diagnostics';
import { TuiTerminal } from './tui-terminal';
import { StatusBar } from './status-bar';
import { showCliError, stripAnsi, escapeHtml } from './util';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXTENSION_ID = 'openshell';
const CLI_NAME = 'openshell';
const CLI_DISPLAY_NAME = 'OpenShell';
const CLI_MARKDOWN = `OpenShell is the safe, private runtime for autonomous AI agents. It provides sandboxed execution environments that protect your data, credentials, and infrastructure — governed by declarative YAML policies.\n\nMore information: [OpenShell on GitHub](https://github.com/LobsterTrap/OpenShell)`;

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let cli: OpenShellCli;
let cliTool: extensionApi.CliTool | undefined;
let provider: extensionApi.Provider;
let statusBar: StatusBar;
let gatewayManager: GatewayManager;
let sandboxManager: SandboxManager;
let providerManager: ProviderManager;
let logViewer: LogViewer;
let diagnosticsViewer: DiagnosticsViewer;
let tuiTerminal: TuiTerminal;
let openshellPath: string | undefined;

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

/**
 * Extension activation entry point.
 *
 * Called by Podman Desktop when the extension is loaded. Performs:
 * 1. Binary detection and CLI tool registration
 * 2. Provider registration (OpenShell appears in the Dashboard)
 * 3. Command registration for all CRUD and observability operations
 * 4. Status bar setup with polling
 * 5. State context initialization for when-clauses
 */
export async function activate(extensionContext: extensionApi.ExtensionContext): Promise<void> {
  const telemetryLogger = extensionApi.env.createTelemetryLogger();

  // -----------------------------------------------------------------------
  // 1. Detect the openshell binary
  // -----------------------------------------------------------------------

  const configuredPath = extensionApi.configuration
    .getConfiguration('openshell')
    .get<string>('binary.path');

  const binaryInfo = await detectOpenShellBinary(configuredPath || undefined);

  if (binaryInfo) {
    openshellPath = binaryInfo.path;
    extensionApi.context.setValue('openshell.cliInstalled', true);
  } else {
    openshellPath = 'openshell'; // optimistic — will fail at runtime if not installed
    extensionApi.context.setValue('openshell.cliInstalled', false);
  }

  cli = new OpenShellCli(openshellPath);

  // -----------------------------------------------------------------------
  // 2. Register the CLI tool
  // -----------------------------------------------------------------------

  cliTool = extensionApi.cli.createCliTool({
    name: CLI_NAME,
    displayName: CLI_DISPLAY_NAME,
    markdownDescription: CLI_MARKDOWN,
    images: { icon: './icon.png' },
    version: binaryInfo?.version,
    path: binaryInfo?.path,
    installationSource: binaryInfo ? 'external' : undefined,
  });
  extensionContext.subscriptions.push(cliTool);

  // Register installer for the CLI tool
  cliTool.registerInstaller({
    selectVersion: async (): Promise<string> => {
      return 'latest';
    },
    doInstall: async (_logger: extensionApi.Logger): Promise<void> => {
      await installOpenShell();
    },
    doUninstall: async (_logger: extensionApi.Logger): Promise<void> => {
      await extensionApi.window.showInformationMessage(
        'To uninstall OpenShell, run: uv tool uninstall openshell',
      );
    },
  });

  // -----------------------------------------------------------------------
  // 3. Create the OpenShell provider
  // -----------------------------------------------------------------------

  provider = extensionApi.provider.createProvider({
    name: 'OpenShell',
    id: EXTENSION_ID,
    status: 'unknown',
    images: {
      icon: './icon.png',
    },
    emptyConnectionMarkdownDescription: `
OpenShell provides sandboxed execution environments for autonomous AI agents with policy-enforced security.

**Getting started:**
1. Start a gateway: run **OpenShell: Start Gateway** from the command palette
2. Create a sandbox: run **OpenShell: Create Sandbox** to launch an AI agent
3. Monitor: use **OpenShell: Diagnostics** or **OpenShell: Open Terminal UI**

More information: [OpenShell Documentation](https://docs.nvidia.com/openshell/latest/index.html)`,
  });
  extensionContext.subscriptions.push(provider);

  // -----------------------------------------------------------------------
  // 4. Create manager instances
  // -----------------------------------------------------------------------

  const refreshState = async (): Promise<void> => {
    await updateGlobalState();
  };

  gatewayManager = new GatewayManager(cli, refreshState);
  sandboxManager = new SandboxManager(cli, refreshState);
  providerManager = new ProviderManager(cli, refreshState);
  logViewer = new LogViewer(cli);
  diagnosticsViewer = new DiagnosticsViewer(cli);
  tuiTerminal = new TuiTerminal(cli);

  // -----------------------------------------------------------------------
  // 5. Register all commands
  // -----------------------------------------------------------------------

  const commands: [string, (...args: unknown[]) => Promise<void>][] = [
    // Gateway commands
    ['openshell.gateway.start', () => gatewayManager.start()],
    ['openshell.gateway.stop', () => gatewayManager.stop()],
    ['openshell.gateway.destroy', () => gatewayManager.destroy()],
    ['openshell.gateway.select', () => gatewayManager.select()],
    ['openshell.gateway.info', () => gatewayManager.info()],
    ['openshell.gateway.add', () => gatewayManager.add()],

    // Sandbox commands
    ['openshell.sandbox.create', () => sandboxManager.create()],
    ['openshell.sandbox.delete', () => sandboxManager.delete()],
    ['openshell.sandbox.connect', () => sandboxManager.connect()],
    ['openshell.sandbox.list', () => sandboxManager.list()],
    ['openshell.sandbox.get', () => sandboxManager.get()],
    ['openshell.sandbox.exec', () => sandboxManager.exec()],

    // Provider commands
    ['openshell.provider.create', () => providerManager.create()],
    ['openshell.provider.delete', () => providerManager.delete()],
    ['openshell.provider.list', () => providerManager.list()],
    ['openshell.provider.get', () => providerManager.get()],
    ['openshell.provider.update', () => providerManager.update()],

    // Observability commands
    ['openshell.logs', () => logViewer.open()],
    ['openshell.term', () => tuiTerminal.open()],
    ['openshell.diagnostics', () => diagnosticsViewer.open()],
    ['openshell.doctor.check', () => diagnosticsViewer.quickCheck()],
    ['openshell.status', () => showStatus()],

    // Installation
    ['openshell.install', () => installOpenShell()],

    // Onboarding
    ['openshell.onboarding.checkInstalled', () => checkInstalled()],
  ];

  for (const [id, handler] of commands) {
    extensionContext.subscriptions.push(
      extensionApi.commands.registerCommand(id, async (...args: unknown[]) => {
        telemetryLogger.logUsage(id);
        try {
          await handler(...args);
        } catch (err: unknown) {
          showCliError(err, `Command ${id} failed`);
        }
      }),
    );
  }

  // -----------------------------------------------------------------------
  // 6. Status bar
  // -----------------------------------------------------------------------

  statusBar = new StatusBar(cli, 'openshell.status');
  extensionContext.subscriptions.push({ dispose: () => statusBar.dispose() });
  statusBar.startPolling(15_000);

  // -----------------------------------------------------------------------
  // 7. React to container engine events
  // -----------------------------------------------------------------------

  // When containers change, refresh state (the gateway runs as a container)
  extensionContext.subscriptions.push(
    extensionApi.containerEngine.onEvent(async event => {
      if (event.Type === 'container') {
        await updateGlobalState();
      }
    }),
  );

  // When container connections change, update factory registration
  extensionContext.subscriptions.push(
    extensionApi.provider.onDidUpdateContainerConnection(async () => {
      await updateGlobalState();
    }),
  );
  extensionContext.subscriptions.push(
    extensionApi.provider.onDidRegisterContainerConnection(async () => {
      await updateGlobalState();
    }),
  );
  extensionContext.subscriptions.push(
    extensionApi.provider.onDidUnregisterContainerConnection(async () => {
      await updateGlobalState();
    }),
  );

  // -----------------------------------------------------------------------
  // 8. Configuration change listener
  // -----------------------------------------------------------------------

  extensionContext.subscriptions.push(
    extensionApi.configuration.onDidChangeConfiguration(async event => {
      if (event.key === 'openshell.binary.path') {
        const newPath = extensionApi.configuration
          .getConfiguration('openshell')
          .get<string>('binary.path');
        if (newPath) {
          cli.setPath(newPath);
          openshellPath = newPath;
          // Re-detect version
          try {
            const version = await cli.getVersion();
            cliTool?.updateVersion({ version, path: newPath, installationSource: 'external' });
          } catch {
            // binary path is invalid
          }
        }
      }
    }),
  );

  // -----------------------------------------------------------------------
  // 9. Initial state sync
  // -----------------------------------------------------------------------

  await updateGlobalState();

  // Auto-run diagnostics if preference is enabled
  const autoRunDiag = extensionApi.configuration
    .getConfiguration('openshell')
    .get<boolean>('diagnostics.autoRun');
  if (autoRunDiag) {
    diagnosticsViewer.quickCheck().catch(() => {});
  }

  console.log('OpenShell extension is active');
}

// ---------------------------------------------------------------------------
// Deactivation
// ---------------------------------------------------------------------------

export function deactivate(): void {
  console.log('Stopping OpenShell extension');
  statusBar?.dispose();
  openshellPath = undefined;
  cliTool = undefined;
}

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

/**
 * Refresh the global extension state by querying the CLI.
 *
 * Updates:
 *   - context values for when-clause conditions
 *   - provider status
 *   - status bar
 */
async function updateGlobalState(): Promise<void> {
  // Check gateway status
  let gatewayRunning = false;
  let activeGateway = '';
  try {
    const statusOutput = await cli.status();
    const cleaned = stripAnsi(statusOutput).toLowerCase();
    gatewayRunning =
      cleaned.includes('running') ||
      cleaned.includes('ready') ||
      cleaned.includes('healthy');

    // Try to extract gateway name from status output
    const nameMatch = statusOutput.match(/(?:gateway|name)[\s:]+(\S+)/i);
    if (nameMatch) {
      activeGateway = nameMatch[1];
    }
  } catch {
    gatewayRunning = false;
  }

  // Check sandbox count
  let sandboxCount = 0;
  try {
    const names = await cli.sandboxListNames();
    sandboxCount = names.length;
  } catch {
    // No sandboxes or gateway not running
  }

  // Update context values
  extensionApi.context.setValue('openshell.gatewayRunning', gatewayRunning);
  extensionApi.context.setValue('openshell.activeSandboxes', sandboxCount);
  extensionApi.context.setValue('openshell.activeGateway', activeGateway);

  // Update provider status
  if (gatewayRunning) {
    provider.updateStatus('ready');
  } else {
    provider.updateStatus('installed');
  }

  // Refresh status bar
  await statusBar?.refresh();
}

// ---------------------------------------------------------------------------
// Show status
// ---------------------------------------------------------------------------

async function showStatus(): Promise<void> {
  try {
    const output = await cli.status();
    const cleaned = stripAnsi(output);

    // Also get sandbox list and provider list for a complete picture
    let sandboxOutput = '';
    let providerOutput = '';
    try {
      const sandboxResult = await extensionApi.process.exec(cli.getPath(), ['sandbox', 'list']);
      sandboxOutput = stripAnsi(sandboxResult.stdout);
    } catch {
      sandboxOutput = '(no sandboxes or gateway not running)';
    }
    try {
      const providerResult = await extensionApi.process.exec(cli.getPath(), ['provider', 'list']);
      providerOutput = stripAnsi(providerResult.stdout);
    } catch {
      providerOutput = '(no providers or gateway not running)';
    }

    const panel = extensionApi.window.createWebviewPanel('openshell-status', 'OpenShell Status');
    panel.webview.html = renderStatusHtml(cleaned, sandboxOutput, providerOutput);
  } catch (err: unknown) {
    // If status fails, show a simpler message
    const errMsg =
      err && typeof err === 'object' && 'stderr' in err
        ? (err as { stderr: string }).stderr
        : String(err);

    const action = await extensionApi.window.showWarningMessage(
      `OpenShell gateway is not running. ${stripAnsi(errMsg)}`,
      'Start Gateway',
      'Run Diagnostics',
    );
    if (action === 'Start Gateway') {
      await gatewayManager.start();
    } else if (action === 'Run Diagnostics') {
      await diagnosticsViewer.open();
    }
  }
}

function renderStatusHtml(
  statusText: string,
  sandboxText: string,
  providerText: string,
): string {
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
      margin: 0;
    }
    h2 { margin-top: 0; }
    h3 { margin-top: 1.25rem; margin-bottom: 0.25rem; font-size: 14px; color: var(--pd-content-header-text, #aaa); text-transform: uppercase; letter-spacing: 0.05em; }
    pre {
      background: var(--pd-content-bg, #292929);
      border: 1px solid var(--pd-content-divider, #444);
      border-radius: 6px;
      padding: 0.75rem 1rem;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
      font-family: 'Courier New', 'Fira Code', monospace;
    }
    .btn-row { display: flex; gap: 8px; margin-top: 1rem; }
    button {
      background: var(--pd-button-primary-bg, #0078d4);
      color: #fff;
      border: none;
      padding: 6px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
    }
    button:hover { opacity: 0.85; }
  </style>
</head>
<body>
  <h2>OpenShell Status</h2>

  <h3>Gateway</h3>
  <pre>${escapeHtml(statusText)}</pre>

  <h3>Sandboxes</h3>
  <pre>${escapeHtml(sandboxText)}</pre>

  <h3>Providers</h3>
  <pre>${escapeHtml(providerText)}</pre>

  <div class="btn-row">
    <button onclick="vscode.postMessage({command:'refresh'})">↻ Refresh</button>
  </div>
  <script>const vscode = acquireVsCodeApi();</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

async function installOpenShell(): Promise<void> {
  const methodPick = await extensionApi.window.showQuickPick(
    [
      {
        label: 'Binary installer (recommended)',
        description: 'curl -LsSf ... | sh',
      },
      {
        label: 'PyPI via uv',
        description: 'uv tool install -U openshell',
      },
      {
        label: 'Fedora/RHEL COPR',
        description: 'sudo dnf copr enable maxamillion/openshell && sudo dnf install openshell',
      },
    ],
    { title: 'Install OpenShell' },
  );
  if (!methodPick) return;

  await extensionApi.window.withProgress(
    { location: extensionApi.ProgressLocation.TASK_WIDGET, title: 'Installing OpenShell...' },
    async progress => {
      try {
        if (methodPick.label.startsWith('Binary')) {
          await extensionApi.process.exec('sh', [
            '-c',
            'curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh',
          ]);
        } else if (methodPick.label.startsWith('PyPI')) {
          await extensionApi.process.exec('uv', ['tool', 'install', '-U', 'openshell']);
        } else {
          await extensionApi.process.exec('sudo', [
            'sh',
            '-c',
            'dnf copr enable -y maxamillion/openshell && dnf install -y openshell',
          ]);
        }

        progress.report({ increment: -1 });

        // Re-detect the binary
        const binary = await detectOpenShellBinary();
        if (binary) {
          openshellPath = binary.path;
          cli.setPath(binary.path);
          extensionApi.context.setValue('openshell.cliInstalled', true);
          cliTool?.updateVersion({
            version: binary.version,
            path: binary.path,
            installationSource: 'extension',
          });
          await extensionApi.window.showInformationMessage(
            `OpenShell ${binary.version} installed successfully at ${binary.path}`,
          );
        } else {
          await extensionApi.window.showWarningMessage(
            'Installation completed but openshell binary was not found in PATH. You may need to restart your shell.',
          );
        }
      } catch (err: unknown) {
        progress.report({ increment: -1 });
        showCliError(err, 'Failed to install OpenShell');
      }
    },
  );
}

async function checkInstalled(): Promise<void> {
  const binary = await detectOpenShellBinary(
    extensionApi.configuration.getConfiguration('openshell').get<string>('binary.path') || undefined,
  );
  if (binary) {
    extensionApi.context.setValue('openshell.cliInstalled', true);
    cli.setPath(binary.path);
    openshellPath = binary.path;
  } else {
    extensionApi.context.setValue('openshell.cliInstalled', false);
  }
}
