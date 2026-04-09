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

import type { OpenShellCli, LogsOptions } from './openshell-cli';
import { showCliError, stripAnsi, escapeHtml } from './util';

/**
 * Provides a webview-based log viewer for OpenShell sandbox logs.
 *
 * Wraps `openshell logs [name]` with filtering by source, level, and
 * time range. Supports both snapshot and tail (streaming) modes.
 */
export class LogViewer {
  constructor(private readonly cli: OpenShellCli) {}

  /**
   * Open the log viewer. Prompts the user for sandbox name and options,
   * then creates a webview panel showing the log output.
   */
  async open(): Promise<void> {
    // Step 1: Select sandbox
    let sandboxName: string | undefined;
    try {
      const names = await this.cli.sandboxListNames();
      if (names.length > 0) {
        const pick = await extensionApi.window.showQuickPick(
          [
            { label: '(last used)', description: 'Use the last-used sandbox' },
            ...names.map(n => ({ label: n, description: '' })),
          ],
          { title: 'Select Sandbox for Logs' },
        );
        if (pick === undefined) return;
        sandboxName = pick.label === '(last used)' ? undefined : pick.label;
      }
    } catch {
      // If sandbox listing fails, proceed without a name (uses last-used)
    }

    // Step 2: Log options
    const defaultLines = extensionApi.configuration
      .getConfiguration('openshell')
      .get<number>('logs.defaultLines') ?? 200;

    const optionPicks = await extensionApi.window.showQuickPick(
      [
        { label: 'Tail (live)', description: 'Stream live log output', picked: false },
        { label: 'Source: gateway', description: 'Show only gateway logs', picked: false },
        { label: 'Source: sandbox', description: 'Show only sandbox logs', picked: false },
        { label: 'Level: error', description: 'Show only error-level logs', picked: false },
        { label: 'Level: warn', description: 'Show warn and above', picked: false },
        { label: 'Level: debug', description: 'Show debug and above', picked: false },
      ],
      { title: 'Log Options', canPickMany: true },
    );
    // undefined means cancelled; empty array means no options selected (fine)
    if (optionPicks === undefined) return;

    const tail = optionPicks.some(o => o.label === 'Tail (live)');
    const sources: string[] = [];
    if (optionPicks.some(o => o.label === 'Source: gateway')) sources.push('gateway');
    if (optionPicks.some(o => o.label === 'Source: sandbox')) sources.push('sandbox');

    let level = '';
    if (optionPicks.some(o => o.label === 'Level: error')) level = 'error';
    else if (optionPicks.some(o => o.label === 'Level: warn')) level = 'warn';
    else if (optionPicks.some(o => o.label === 'Level: debug')) level = 'debug';

    const opts: LogsOptions = {
      name: sandboxName,
      n: defaultLines,
      tail,
      source: sources.length > 0 ? sources : undefined,
      level: level || undefined,
    };

    // Ask for time filter
    const sincePick = await extensionApi.window.showQuickPick(
      [
        { label: 'All time', description: 'No time filter' },
        { label: 'Last 5 minutes', description: '--since 5m' },
        { label: 'Last 30 minutes', description: '--since 30m' },
        { label: 'Last 1 hour', description: '--since 1h' },
        { label: 'Last 24 hours', description: '--since 24h' },
        { label: 'Custom', description: 'Enter a custom duration' },
      ],
      { title: 'Time Range' },
    );
    if (sincePick === undefined) return;

    if (sincePick.label === 'Last 5 minutes') opts.since = '5m';
    else if (sincePick.label === 'Last 30 minutes') opts.since = '30m';
    else if (sincePick.label === 'Last 1 hour') opts.since = '1h';
    else if (sincePick.label === 'Last 24 hours') opts.since = '24h';
    else if (sincePick.label === 'Custom') {
      const custom = await extensionApi.window.showInputBox({
        title: 'Since',
        prompt: 'Duration (e.g. 5m, 1h, 30s)',
      });
      if (custom) opts.since = custom;
    }

    // Create the webview
    const title = `Logs: ${sandboxName || 'last used'}`;
    const panel = extensionApi.window.createWebviewPanel('openshell-logs', title);

    if (tail) {
      // Streaming mode: show initial loading state and update via postMessage
      panel.webview.html = this.renderLogHtml(title, 'Streaming logs… (waiting for data)\n', true);
      this.streamLogs(panel, opts);
    } else {
      // Snapshot mode: fetch all logs then render
      panel.webview.html = this.renderLogHtml(title, 'Loading logs…', false);
      try {
        const output = await this.cli.logs(opts);
        panel.webview.html = this.renderLogHtml(title, stripAnsi(output), false);
      } catch (err: unknown) {
        showCliError(err, 'Failed to fetch logs');
        panel.webview.html = this.renderLogHtml(title, 'Failed to fetch logs. Check the gateway is running.', false);
      }
    }

    // Handle messages from webview
    panel.webview.onDidReceiveMessage(async (msg: unknown) => {
      const message = msg as { command: string };
      if (message.command === 'refresh') {
        try {
          const output = await this.cli.logs({ ...opts, tail: false });
          panel.webview.html = this.renderLogHtml(title, stripAnsi(output), false);
        } catch (err: unknown) {
          showCliError(err, 'Failed to refresh logs');
        }
      }
    });
  }

  /**
   * Stream logs using `openshell logs --tail` and forward output to the
   * webview panel in real-time via postMessage.
   */
  private streamLogs(panel: extensionApi.WebviewPanel, opts: LogsOptions): void {
    // Build the args for a tail command
    // Since process.exec waits for completion, for tail mode we run it and
    // rely on the logger callback to stream output. This is a simplification;
    // a production implementation might use a raw child_process for true streaming.
    const args = ['logs'];
    if (opts.name) args.push(opts.name);
    if (opts.n !== undefined) args.push('-n', String(opts.n));
    args.push('--tail');
    if (opts.since) args.push('--since', opts.since);
    if (opts.source) {
      for (const s of opts.source) {
        args.push('--source', s);
      }
    }
    if (opts.level) args.push('--level', opts.level);

    // Use process.exec with a logger that streams to the webview.
    // The tail process runs until cancelled or the panel is closed.
    const logger: extensionApi.Logger = {
      log: (message: string) => {
        panel.webview.postMessage({ command: 'append', data: stripAnsi(message) }).catch(() => {});
      },
      error: (message: string) => {
        panel.webview.postMessage({ command: 'append', data: `[ERROR] ${stripAnsi(message)}` }).catch(() => {});
      },
      warn: (message: string) => {
        panel.webview.postMessage({ command: 'append', data: `[WARN] ${stripAnsi(message)}` }).catch(() => {});
      },
    };

    extensionApi.process.exec(this.cli.getPath(), args, { logger }).catch(() => {
      // Process ended (e.g. cancelled or error) — that's expected for tail
    });
  }

  // -----------------------------------------------------------------------
  // HTML renderer
  // -----------------------------------------------------------------------

  private renderLogHtml(title: string, content: string, isTailing: boolean): string {
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
      line-height: 1.5;
      margin: 0;
    }
    .toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.5rem;
      position: sticky;
      top: 0;
      background: var(--pd-details-bg, #1e1e1e);
      padding: 0.5rem 0;
      z-index: 10;
    }
    h2 { margin: 0; font-size: 16px; }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 500;
      margin-left: 8px;
    }
    .badge.live { background: #1e4620; color: #4caf50; animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
    button {
      background: var(--pd-button-primary-bg, #0078d4);
      color: #fff;
      border: none;
      padding: 4px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }
    button:hover { opacity: 0.85; }
    select {
      padding: 4px 8px;
      border: 1px solid var(--pd-content-divider, #444);
      border-radius: 4px;
      background: var(--pd-content-bg, #292929);
      color: var(--pd-details-body-text, #e7e7e7);
      font-size: 12px;
      margin-right: 8px;
    }
    #search {
      padding: 4px 8px;
      border: 1px solid var(--pd-content-divider, #444);
      border-radius: 4px;
      background: var(--pd-content-bg, #292929);
      color: var(--pd-details-body-text, #e7e7e7);
      font-size: 13px;
      margin-right: 8px;
      width: 200px;
    }
    #log-output {
      background: var(--pd-content-bg, #292929);
      border: 1px solid var(--pd-content-divider, #444);
      border-radius: 6px;
      padding: 0.75rem 1rem;
      overflow-x: auto;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: 'Courier New', 'Fira Code', monospace;
      font-size: 12px;
      line-height: 1.4;
      max-height: calc(100vh - 100px);
    }
    .line-error { color: #e57373; }
    .line-warn { color: #ffc107; }
    .line-debug { color: #81d4fa; }
    .line-trace { color: #888; }
    .highlight { background: #5a4800; }
  </style>
</head>
<body>
  <div class="toolbar">
    <div>
      <h2 style="display:inline">${escapeHtml(title)}</h2>
      ${isTailing ? '<span class="badge live">● LIVE</span>' : ''}
    </div>
    <div>
      <input type="text" id="search" placeholder="Search logs…" oninput="filterLogs()" />
      <select id="auto-refresh" onchange="setAutoRefresh(this.value)" title="Auto-refresh interval">
        <option value="0">Auto-refresh: off</option>
        <option value="5">Every 5s</option>
        <option value="10">Every 10s</option>
        <option value="30">Every 30s</option>
        <option value="60">Every 60s</option>
      </select>
      <button onclick="send('refresh')">↻ Refresh</button>
    </div>
  </div>
  <pre id="log-output">${escapeHtml(content)}</pre>
  <script>
    const vscode = acquireVsCodeApi();
    function send(command) { vscode.postMessage({ command }); }

    const output = document.getElementById('log-output');

    // Handle streaming updates
    window.addEventListener('message', e => {
      if (e.data?.command === 'append') {
        output.textContent += e.data.data;
        output.scrollTop = output.scrollHeight;
        colorizeLines();
      }
    });

    function filterLogs() {
      const query = document.getElementById('search').value.toLowerCase();
      const lines = output.innerHTML.split('\\n');
      // Simple highlight approach
      if (!query) {
        output.innerHTML = output.textContent || '';
        colorizeLines();
        return;
      }
      const escaped = output.textContent || '';
      const highlighted = escaped.split('\\n').map(line => {
        if (line.toLowerCase().includes(query)) {
          return '<span class="highlight">' + line + '</span>';
        }
        return line;
      }).join('\\n');
      output.innerHTML = highlighted;
    }

    function colorizeLines() {
      const text = output.textContent || '';
      const html = text.split('\\n').map(line => {
        const lower = line.toLowerCase();
        if (lower.includes('error') || lower.includes('err]'))
          return '<span class="line-error">' + escapeHtml(line) + '</span>';
        if (lower.includes('warn'))
          return '<span class="line-warn">' + escapeHtml(line) + '</span>';
        if (lower.includes('debug'))
          return '<span class="line-debug">' + escapeHtml(line) + '</span>';
        if (lower.includes('trace'))
          return '<span class="line-trace">' + escapeHtml(line) + '</span>';
        return escapeHtml(line);
      }).join('\\n');
      output.innerHTML = html;
    }

    function escapeHtml(t) {
      return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    let autoRefreshTimer = null;
    function setAutoRefresh(seconds) {
      if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
      const secs = parseInt(seconds, 10);
      if (secs > 0) {
        autoRefreshTimer = setInterval(() => send('refresh'), secs * 1000);
      }
    }

    colorizeLines();
  </script>
</body>
</html>`;
  }
}
