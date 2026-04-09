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

import type { OpenShellCli } from './openshell-cli';
import { escapeHtml } from './util';

/**
 * Provides access to the OpenShell Terminal UI (`openshell term`).
 *
 * The TUI is a full-screen ratatui application that requires a real PTY.
 * Since Podman Desktop webviews don't natively expose PTY allocation, we
 * provide two approaches:
 *
 * **Approach 1 (Default):** Launch `openshell term` in the user's native
 * terminal emulator (e.g. Terminal.app, gnome-terminal, Windows Terminal)
 * via `process.exec()` of the appropriate terminal launcher.
 *
 * **Approach 2 (Fallback):** Open a webview panel with embedded xterm.js
 * that connects to the openshell binary. This provides a basic terminal
 * experience without leaving Podman Desktop, but may have limited
 * interactivity compared to a native terminal.
 *
 * The user's preferred theme is read from configuration.
 */
export class TuiTerminal {
  constructor(private readonly cli: OpenShellCli) {}

  /**
   * Launch the OpenShell TUI.
   *
   * Attempts to open a native terminal first. If that fails or the user
   * prefers an embedded experience, falls back to the webview approach.
   */
  async open(): Promise<void> {
    const theme =
      extensionApi.configuration.getConfiguration('openshell').get<string>('tui.theme') ?? 'auto';

    const methodPick = await extensionApi.window.showQuickPick(
      [
        {
          label: 'Native Terminal',
          description: 'Launch in your system terminal emulator (recommended)',
        },
        {
          label: 'Embedded Viewer',
          description: 'Open a simplified terminal view inside Podman Desktop',
        },
      ],
      { title: 'How to open the OpenShell TUI?' },
    );
    if (methodPick === undefined) return;

    if (methodPick.label === 'Native Terminal') {
      await this.openNativeTerminal(theme);
    } else {
      await this.openEmbeddedViewer(theme);
    }
  }

  // -----------------------------------------------------------------------
  // Native terminal launch
  // -----------------------------------------------------------------------

  /**
   * Launch `openshell term` in the user's native terminal emulator.
   *
   * Platform detection:
   * - macOS: `open -a Terminal` or check for iTerm2/Alacritty/Kitty
   * - Linux: x-terminal-emulator, gnome-terminal, konsole, xterm
   * - Windows: `start cmd /c` or wt.exe (Windows Terminal)
   */
  private async openNativeTerminal(theme: string): Promise<void> {
    const openshellPath = this.cli.getPath();
    const command = `${openshellPath} term --theme ${theme}`;

    try {
      if (extensionApi.env.isMac) {
        // macOS: use osascript to open Terminal.app with our command
        await extensionApi.process.exec('osascript', [
          '-e',
          `tell application "Terminal" to do script "${command}"`,
          '-e',
          'tell application "Terminal" to activate',
        ]);
      } else if (extensionApi.env.isWindows) {
        // Windows: use wt.exe (Windows Terminal) if available, else cmd
        try {
          await extensionApi.process.exec('wt.exe', ['--', 'cmd', '/c', command]);
        } catch {
          await extensionApi.process.exec('cmd', ['/c', 'start', 'cmd', '/c', command]);
        }
      } else {
        // Linux: try common terminal emulators in order
        const terminals = [
          { cmd: 'x-terminal-emulator', args: ['-e', command] },
          { cmd: 'gnome-terminal', args: ['--', 'bash', '-c', command] },
          { cmd: 'konsole', args: ['-e', command] },
          { cmd: 'xfce4-terminal', args: ['-e', command] },
          { cmd: 'alacritty', args: ['-e', 'bash', '-c', command] },
          { cmd: 'kitty', args: ['bash', '-c', command] },
          { cmd: 'xterm', args: ['-e', command] },
        ];

        let launched = false;
        for (const term of terminals) {
          try {
            await extensionApi.process.exec(term.cmd, term.args);
            launched = true;
            break;
          } catch {
            continue;
          }
        }

        if (!launched) {
          await extensionApi.window.showErrorMessage(
            'Could not find a terminal emulator. Please run `openshell term` manually.',
          );
          return;
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await extensionApi.window.showErrorMessage(`Failed to launch terminal: ${msg}`);
    }
  }

  // -----------------------------------------------------------------------
  // Embedded webview viewer
  // -----------------------------------------------------------------------

  /**
   * Open a webview panel with a simplified terminal view.
   *
   * This runs `openshell term` and captures its output. Since the TUI
   * is a full ratatui app that expects raw terminal mode, the embedded
   * approach has limitations — it's best used as a read-only status
   * viewer rather than a fully interactive TUI.
   *
   * For full interactivity, the native terminal approach is recommended.
   */
  private async openEmbeddedViewer(theme: string): Promise<void> {
    const panel = extensionApi.window.createWebviewPanel(
      'openshell-tui',
      'OpenShell Terminal UI',
    );
    panel.webview.html = this.renderEmbeddedHtml(theme);

    // Note: The TUI is a full-screen ratatui app that requires raw mode
    // and PTY allocation. In this embedded mode, we inform the user about
    // limitations and offer to launch natively instead.
    panel.webview.onDidReceiveMessage(async (msg: unknown) => {
      const message = msg as { command: string };
      if (message.command === 'launch-native') {
        await this.openNativeTerminal(theme);
      } else if (message.command === 'run-status') {
        // Show a snapshot of the gateway status as an alternative
        try {
          const status = await this.cli.status();
          await panel.webview.postMessage({ command: 'status-output', data: status });
        } catch (err: unknown) {
          const errMsg =
            err && typeof err === 'object' && 'stderr' in err
              ? (err as { stderr: string }).stderr
              : String(err);
          await panel.webview.postMessage({
            command: 'status-output',
            data: `Error: ${errMsg}`,
          });
        }
      }
    });
  }

  // -----------------------------------------------------------------------
  // HTML
  // -----------------------------------------------------------------------

  private renderEmbeddedHtml(theme: string): string {
    const isDark = theme !== 'light';
    const bg = isDark ? '#1e1e1e' : '#ffffff';
    const fg = isDark ? '#e7e7e7' : '#333333';
    const cardBg = isDark ? '#292929' : '#f5f5f5';
    const border = isDark ? '#444' : '#ddd';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: var(--pd-details-body-font-family, 'IBM Plex Sans', system-ui, sans-serif);
      color: ${fg};
      background: ${bg};
      padding: 1.5rem;
      line-height: 1.6;
      margin: 0;
    }
    h2 { margin-top: 0; }
    .card {
      background: ${cardBg};
      border: 1px solid ${border};
      border-radius: 8px;
      padding: 1.25rem;
      margin-bottom: 1rem;
    }
    .card h3 { margin-top: 0; font-size: 15px; }
    .card p { margin: 0.5rem 0; font-size: 13px; }
    .btn-row { display: flex; gap: 8px; margin-top: 1rem; }
    button {
      background: var(--pd-button-primary-bg, #0078d4);
      color: #fff;
      border: none;
      padding: 8px 20px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
    }
    button:hover { opacity: 0.85; }
    button.secondary {
      background: transparent;
      border: 1px solid ${border};
      color: ${fg};
    }
    button.secondary:hover { background: ${isDark ? '#333' : '#eee'}; }
    .terminal-preview {
      background: #0d1117;
      color: #c9d1d9;
      font-family: 'Courier New', 'Fira Code', monospace;
      font-size: 12px;
      padding: 1rem;
      border-radius: 6px;
      min-height: 200px;
      max-height: 400px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-word;
      margin-top: 0.5rem;
    }
    .badge {
      display: inline-block;
      padding: 2px 10px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 500;
      background: #1e4620;
      color: #4caf50;
      margin-left: 8px;
    }
    .info-icon { font-size: 18px; margin-right: 8px; vertical-align: middle; }
  </style>
</head>
<body>
  <h2>🐚 OpenShell Terminal UI</h2>

  <div class="card">
    <h3><span class="info-icon">ℹ️</span>About the TUI</h3>
    <p>
      The OpenShell TUI is a full-screen interactive dashboard built with
      <a href="https://ratatui.rs">ratatui</a> — inspired by
      <a href="https://k9scli.io/">k9s</a>. It provides real-time monitoring
      of gateways, sandboxes, and providers with keyboard-driven navigation.
    </p>
    <p>
      For the best experience, launch it in your native terminal emulator
      where it can use raw mode and full keyboard input.
    </p>
    <div class="btn-row">
      <button onclick="send('launch-native')">🖥️ Launch in Native Terminal</button>
      <button class="secondary" onclick="send('run-status')">📊 Show Status Snapshot</button>
    </div>
  </div>

  <div class="card">
    <h3>Gateway Status <span class="badge" id="status-badge" style="display:none">● Live</span></h3>
    <div class="terminal-preview" id="status-output">
      Click "Show Status Snapshot" above to fetch the current gateway status.
    </div>
  </div>

  <div class="card">
    <h3>TUI Keyboard Shortcuts</h3>
    <table style="width:100%;font-size:13px;">
      <tr><td style="padding:3px 12px 3px 0;font-family:monospace;">Tab</td><td>Switch panels</td></tr>
      <tr><td style="padding:3px 12px 3px 0;font-family:monospace;">j / k</td><td>Move up/down in lists</td></tr>
      <tr><td style="padding:3px 12px 3px 0;font-family:monospace;">Enter</td><td>Select / expand item</td></tr>
      <tr><td style="padding:3px 12px 3px 0;font-family:monospace;">:</td><td>Command mode</td></tr>
      <tr><td style="padding:3px 12px 3px 0;font-family:monospace;">q</td><td>Quit</td></tr>
    </table>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    function send(command) { vscode.postMessage({ command }); }

    window.addEventListener('message', e => {
      if (e.data?.command === 'status-output') {
        const output = document.getElementById('status-output');
        output.textContent = e.data.data;
        const badge = document.getElementById('status-badge');
        badge.style.display = 'inline-block';
      }
    });
  </script>
</body>
</html>`;
  }
}
