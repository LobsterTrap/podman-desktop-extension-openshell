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
import { stripAnsi, escapeHtml } from './util';

/**
 * Diagnostics viewer that aggregates output from multiple OpenShell
 * diagnostic commands into a single webview panel.
 *
 * Sections:
 *   1. System Check (`openshell doctor check`)
 *   2. Gateway Status (`openshell status`)
 *   3. Gateway Logs (`openshell doctor logs`)
 *
 * Each section is fetched independently so partial failures don't block
 * the entire view — a failed section shows its error inline.
 */
export class DiagnosticsViewer {
  constructor(private readonly cli: OpenShellCli) {}

  /**
   * Open the diagnostics webview. Optionally auto-runs doctor check
   * if the user has the preference enabled.
   */
  async open(): Promise<void> {
    // Ask which sections the user wants to see
    const sectionPicks = await extensionApi.window.showQuickPick(
      [
        { label: 'System Check', description: 'openshell doctor check — validate prerequisites', picked: true },
        { label: 'Gateway Status', description: 'openshell status — show gateway info', picked: true },
        { label: 'Gateway Logs', description: 'openshell doctor logs — gateway container logs', picked: false },
      ],
      { title: 'Diagnostics Sections', canPickMany: true },
    );
    if (sectionPicks === undefined) return;

    const showCheck = sectionPicks.some(s => s.label === 'System Check');
    const showStatus = sectionPicks.some(s => s.label === 'Gateway Status');
    const showLogs = sectionPicks.some(s => s.label === 'Gateway Logs');

    const panel = extensionApi.window.createWebviewPanel('openshell-diagnostics', 'OpenShell Diagnostics');
    panel.webview.html = this.renderLoadingHtml();

    // Fetch all sections in parallel
    const [checkResult, statusResult, logsResult] = await Promise.all([
      showCheck ? this.safeExec(() => this.cli.doctorCheck()) : Promise.resolve(null),
      showStatus ? this.safeExec(() => this.cli.status()) : Promise.resolve(null),
      showLogs ? this.safeExec(() => this.cli.doctorLogs({ lines: 100 })) : Promise.resolve(null),
    ]);

    const sections: DiagnosticSection[] = [];
    if (showCheck) {
      sections.push({
        title: 'System Check',
        subtitle: 'openshell doctor check',
        icon: this.statusIcon(checkResult),
        content: checkResult?.output ?? checkResult?.error ?? 'Skipped',
        isError: !!checkResult?.error,
      });
    }
    if (showStatus) {
      sections.push({
        title: 'Gateway Status',
        subtitle: 'openshell status',
        icon: this.statusIcon(statusResult),
        content: statusResult?.output ?? statusResult?.error ?? 'Skipped',
        isError: !!statusResult?.error,
      });
    }
    if (showLogs) {
      sections.push({
        title: 'Gateway Logs',
        subtitle: 'openshell doctor logs --lines 100',
        icon: '📋',
        content: logsResult?.output ?? logsResult?.error ?? 'Skipped',
        isError: !!logsResult?.error,
      });
    }

    panel.webview.html = this.renderDiagnosticsHtml(sections);

    // Handle refresh
    panel.webview.onDidReceiveMessage(async (msg: unknown) => {
      const message = msg as { command: string };
      if (message.command === 'refresh') {
        // Re-run with same sections
        panel.webview.html = this.renderLoadingHtml();
        const [c, s, l] = await Promise.all([
          showCheck ? this.safeExec(() => this.cli.doctorCheck()) : Promise.resolve(null),
          showStatus ? this.safeExec(() => this.cli.status()) : Promise.resolve(null),
          showLogs ? this.safeExec(() => this.cli.doctorLogs({ lines: 100 })) : Promise.resolve(null),
        ]);
        const refreshed: DiagnosticSection[] = [];
        if (showCheck) {
          refreshed.push({
            title: 'System Check',
            subtitle: 'openshell doctor check',
            icon: this.statusIcon(c),
            content: c?.output ?? c?.error ?? 'Skipped',
            isError: !!c?.error,
          });
        }
        if (showStatus) {
          refreshed.push({
            title: 'Gateway Status',
            subtitle: 'openshell status',
            icon: this.statusIcon(s),
            content: s?.output ?? s?.error ?? 'Skipped',
            isError: !!s?.error,
          });
        }
        if (showLogs) {
          refreshed.push({
            title: 'Gateway Logs',
            subtitle: 'openshell doctor logs --lines 100',
            icon: '📋',
            content: l?.output ?? l?.error ?? 'Skipped',
            isError: !!l?.error,
          });
        }
        panel.webview.html = this.renderDiagnosticsHtml(refreshed);
      }
    });
  }

  /**
   * Quick doctor check — runs `openshell doctor check` and shows the
   * result in an information message. Suitable for one-click status checks.
   */
  async quickCheck(): Promise<void> {
    await extensionApi.window.withProgress(
      { location: extensionApi.ProgressLocation.TASK_WIDGET, title: 'Running OpenShell doctor check...' },
      async progress => {
        try {
          const output = await this.cli.doctorCheck();
          progress.report({ increment: -1 });
          const cleaned = stripAnsi(output);
          // Determine pass/fail from output
          const passed = cleaned.toLowerCase().includes('pass') || !cleaned.toLowerCase().includes('fail');
          if (passed) {
            await extensionApi.window.showInformationMessage(`OpenShell Doctor Check: All checks passed.\n\n${cleaned}`);
          } else {
            await extensionApi.window.showWarningMessage(`OpenShell Doctor Check: Issues detected.\n\n${cleaned}`);
          }
        } catch (err: unknown) {
          progress.report({ increment: -1 });
          const msg =
            err && typeof err === 'object' && 'stderr' in err
              ? (err as { stderr: string }).stderr
              : String(err);
          await extensionApi.window.showErrorMessage(`Doctor check failed: ${msg}`);
        }
      },
    );
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private async safeExec(fn: () => Promise<string>): Promise<ExecResult> {
    try {
      const output = stripAnsi(await fn());
      return { output };
    } catch (err: unknown) {
      const msg =
        err && typeof err === 'object' && 'stderr' in err
          ? (err as { stderr: string }).stderr
          : String(err);
      return { error: stripAnsi(msg) };
    }
  }

  private statusIcon(result: ExecResult | null): string {
    if (!result) return '⏭️';
    if (result.error) return '❌';
    const text = (result.output ?? '').toLowerCase();
    if (text.includes('fail') || text.includes('error')) return '⚠️';
    return '✅';
  }

  // -----------------------------------------------------------------------
  // HTML renderers
  // -----------------------------------------------------------------------

  private renderLoadingHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: var(--pd-details-body-font-family, 'IBM Plex Sans', system-ui, sans-serif);
      color: var(--pd-details-body-text, #e7e7e7);
      background: var(--pd-details-bg, #1e1e1e);
      padding: 2rem;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 200px;
    }
    .spinner {
      border: 3px solid var(--pd-content-divider, #444);
      border-top: 3px solid var(--pd-button-primary-bg, #0078d4);
      border-radius: 50%;
      width: 32px;
      height: 32px;
      animation: spin 1s linear infinite;
      margin-right: 12px;
    }
    @keyframes spin { 100% { transform: rotate(360deg); } }
    .loading { display: flex; align-items: center; font-size: 14px; }
  </style>
</head>
<body>
  <div class="loading">
    <div class="spinner"></div>
    Running diagnostics…
  </div>
</body>
</html>`;
  }

  private renderDiagnosticsHtml(sections: DiagnosticSection[]): string {
    const sectionHtml = sections
      .map(
        s => `
      <div class="section">
        <div class="section-header" onclick="toggleSection(this)">
          <span class="icon">${s.icon}</span>
          <div class="section-titles">
            <span class="section-title">${escapeHtml(s.title)}</span>
            <span class="section-subtitle">${escapeHtml(s.subtitle)}</span>
          </div>
          <span class="chevron">▼</span>
        </div>
        <div class="section-body${s.isError ? ' error' : ''}">
          <pre>${escapeHtml(s.content)}</pre>
        </div>
      </div>`,
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
      margin: 0;
    }
    .toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
    }
    h2 { margin: 0; }
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
    .section {
      margin-bottom: 0.75rem;
      border: 1px solid var(--pd-content-divider, #444);
      border-radius: 8px;
      overflow: hidden;
    }
    .section-header {
      display: flex;
      align-items: center;
      padding: 0.75rem 1rem;
      background: var(--pd-content-bg, #292929);
      cursor: pointer;
      user-select: none;
    }
    .section-header:hover { background: #333; }
    .icon { font-size: 18px; margin-right: 10px; }
    .section-titles { flex: 1; }
    .section-title { font-weight: 600; font-size: 14px; }
    .section-subtitle { display: block; font-size: 11px; color: var(--pd-content-header-text, #aaa); font-family: monospace; }
    .chevron { font-size: 12px; color: var(--pd-content-header-text, #aaa); transition: transform 0.2s; }
    .section-header.collapsed .chevron { transform: rotate(-90deg); }
    .section-body {
      padding: 0.5rem 1rem;
      border-top: 1px solid var(--pd-content-divider, #444);
    }
    .section-body.collapsed { display: none; }
    .section-body.error pre { color: #e57373; }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
      line-height: 1.4;
      font-family: 'Courier New', 'Fira Code', monospace;
      max-height: 400px;
      overflow-y: auto;
    }
    .timestamp {
      text-align: right;
      font-size: 11px;
      color: var(--pd-content-header-text, #aaa);
      margin-top: 0.5rem;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <h2>OpenShell Diagnostics</h2>
    <button onclick="send('refresh')">↻ Re-run</button>
  </div>
  ${sectionHtml}
  <div class="timestamp">Last run: ${new Date().toLocaleString()}</div>
  <script>
    const vscode = acquireVsCodeApi();
    function send(command) { vscode.postMessage({ command }); }

    function toggleSection(header) {
      header.classList.toggle('collapsed');
      const body = header.nextElementSibling;
      body.classList.toggle('collapsed');
    }
  </script>
</body>
</html>`;
  }
}

// -----------------------------------------------------------------------
// Internal types
// -----------------------------------------------------------------------

interface ExecResult {
  output?: string;
  error?: string;
}

interface DiagnosticSection {
  title: string;
  subtitle: string;
  icon: string;
  content: string;
  isError: boolean;
}
