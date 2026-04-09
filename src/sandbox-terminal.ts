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

/**
 * Interactive terminal for OpenShell sandbox connections.
 *
 * Architecture:
 *
 * OpenShell sandboxes are accessed via SSH through a ProxyCommand that
 * tunnels traffic over HTTP CONNECT to the gateway. The connection chain:
 *
 *   xterm.js (webview)
 *     ↕ postMessage
 *   SandboxTerminal (extension backend)
 *     ↕ ssh2 Client (pure-JS SSH with PTY allocation)
 *       ↕ Duplex stream over child_process stdio
 *     openshell ssh-proxy (child process — HTTP CONNECT tunnel to gateway)
 *       ↕ TCP/TLS
 *     Gateway → Sandbox SSH server
 *
 * The `openshell sandbox ssh-config <name>` command provides the SSH
 * config block including the ProxyCommand. We parse it, spawn the proxy
 * as a child process, wrap its stdio as a Duplex stream, then hand it to
 * ssh2 as a custom socket. ssh2 handles SSH protocol negotiation and PTY
 * allocation entirely in JavaScript — no system SSH binary needed.
 */

import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';

import type {
  Disposable,
  Event,
  WebviewPanel,
} from '@podman-desktop/api';
import { EventEmitter } from '@podman-desktop/api';
import { Client } from 'ssh2';

import type { OpenShellCli } from './openshell-cli';
import { escapeHtml } from './util';

// ---------------------------------------------------------------------------
// SSH config parser
// ---------------------------------------------------------------------------

interface SshConfig {
  user: string;
  proxyCommand: string;
}

/**
 * Parse the output of `openshell sandbox ssh-config <name>` into structured
 * SSH connection parameters.
 *
 * Example output:
 *   Host openshell-dev
 *       User sandbox
 *       StrictHostKeyChecking no
 *       ...
 *       ProxyCommand /path/to/openshell ssh-proxy --gateway-name gw --name dev
 */
function parseSshConfig(output: string): SshConfig {
  let user = 'sandbox';
  let proxyCommand = '';

  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase().startsWith('user ')) {
      user = trimmed.slice(5).trim();
    } else if (trimmed.toLowerCase().startsWith('proxycommand ')) {
      proxyCommand = trimmed.slice(13).trim();
    }
  }

  if (!proxyCommand) {
    throw new Error('No ProxyCommand found in SSH config output');
  }

  return { user, proxyCommand };
}

/**
 * Split a ProxyCommand string into the executable and its arguments,
 * handling basic shell quoting (single and double quotes).
 */
function splitCommand(cmd: string): { exe: string; args: string[] } {
  const parts: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === ' ' && !inSingle && !inDouble) {
      if (current) {
        parts.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);

  return { exe: parts[0], args: parts.slice(1) };
}

// ---------------------------------------------------------------------------
// Child-process-backed Duplex stream
// ---------------------------------------------------------------------------

/**
 * Create a Duplex stream that bridges a child process's stdin/stdout.
 *
 * ssh2 expects a socket-like Duplex stream for its transport. By wrapping
 * the ssh-proxy child process's stdio in a Duplex, we let ssh2 speak SSH
 * protocol directly over the proxy's HTTP CONNECT tunnel.
 */
function childProcessDuplex(
  exe: string,
  args: string[],
): { stream: Duplex; kill: () => void } {
  const child = spawn(exe, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stream = new Duplex({
    read(): void {
      // Data comes from child.stdout events, not from pull-based reads
    },
    write(chunk: Buffer, _encoding: string, callback: (err?: Error | null) => void): void {
      if (child.stdin.writable) {
        child.stdin.write(chunk, callback);
      } else {
        callback(new Error('child stdin closed'));
      }
    },
    final(callback: (err?: Error | null) => void): void {
      child.stdin.end(callback);
    },
  });

  child.stdout.on('data', (data: Buffer) => {
    stream.push(data);
  });

  child.stdout.on('end', () => {
    stream.push(null);
  });

  child.stderr.on('data', (data: Buffer) => {
    // Log stderr but don't break the stream — ssh-proxy may emit
    // diagnostic messages (e.g. retrying on 412) that are informational.
    console.log(`[openshell ssh-proxy stderr] ${data.toString()}`);
  });

  child.on('error', (err: Error) => {
    stream.destroy(err);
  });

  child.on('close', () => {
    stream.push(null);
  });

  return {
    stream,
    kill: () => {
      child.kill();
    },
  };
}

// ---------------------------------------------------------------------------
// SandboxTerminal
// ---------------------------------------------------------------------------

/**
 * Manages a single interactive terminal session to an OpenShell sandbox.
 *
 * Lifecycle:
 *   1. `open()` — get SSH config, spawn proxy, connect ssh2, open shell
 *   2. `write()` — forward user keystrokes to the remote shell
 *   3. `resize()` — update remote PTY dimensions
 *   4. `close()` — tear down ssh2, kill proxy child process
 *
 * Events:
 *   - `onData` — data received from the remote shell (terminal output)
 *   - `onError` — connection or protocol errors
 *   - `onEnd` — session ended (remote closed or disconnect)
 */
export class SandboxTerminal implements Disposable {
  private client: Client | undefined;
  private proxyKill: (() => void) | undefined;
  private channel: ReturnType<Client['shell']> extends Promise<infer R> ? R : never;

  private readonly onDataEmitter = new EventEmitter<string>();
  readonly onData: Event<string> = this.onDataEmitter.event;

  private readonly onErrorEmitter = new EventEmitter<string>();
  readonly onError: Event<string> = this.onErrorEmitter.event;

  private readonly onEndEmitter = new EventEmitter<void>();
  readonly onEnd: Event<void> = this.onEndEmitter.event;

  constructor(private readonly cli: OpenShellCli) {}

  /**
   * Open an interactive SSH session to the named sandbox.
   *
   * 1. Runs `openshell sandbox ssh-config <name>` to get the ProxyCommand
   * 2. Spawns the proxy as a child process
   * 3. Connects ssh2 over the proxy's stdio
   * 4. Opens a PTY-backed shell channel
   */
  async open(sandboxName: string): Promise<void> {
    // Step 1: Get SSH config
    const configResult = await this.cli.sandboxSshConfig(sandboxName);
    const config = parseSshConfig(configResult);
    const { exe, args } = splitCommand(config.proxyCommand);

    // Step 2: Spawn the proxy child process
    const proxy = childProcessDuplex(exe, args);
    this.proxyKill = proxy.kill;

    // Step 3: Connect ssh2 over the proxy stream
    return new Promise<void>((resolve, reject) => {
      this.client = new Client();

      this.client
        .on('ready', () => {
          // Step 4: Open interactive shell with PTY
          this.client!.shell(
            {
              term: 'xterm-256color',
              cols: 80,
              rows: 24,
            },
            (err, stream) => {
              if (err) {
                this.onErrorEmitter.fire(`Shell allocation failed: ${err.message}`);
                reject(err);
                return;
              }

              this.channel = stream;

              stream.on('data', (data: Buffer) => {
                this.onDataEmitter.fire(data.toString('utf-8'));
              });

              stream.on('close', () => {
                this.onEndEmitter.fire();
                this.cleanup();
              });

              stream.stderr.on('data', (data: Buffer) => {
                this.onDataEmitter.fire(data.toString('utf-8'));
              });

              resolve();
            },
          );
        })
        .on('error', (err: Error) => {
          this.onErrorEmitter.fire(`SSH connection error: ${err.message}`);
          reject(err);
        })
        .connect({
          sock: proxy.stream as any,
          username: config.user,
          // OpenShell sandboxes use the ProxyCommand for authentication
          // (token-based via the SSH proxy tunnel). No password or key needed
          // at the ssh2 level — the proxy handles auth. We use "none" auth
          // which the sandbox SSH server accepts for ProxyCommand connections.
          authHandler: [
            { type: 'none', username: config.user },
          ],
        });
    });
  }

  /** Write data (user keystrokes) to the remote shell. */
  write(data: string): void {
    this.channel?.write(data);
  }

  /** Resize the remote PTY. */
  resize(cols: number, rows: number): void {
    this.channel?.setWindow(rows, cols, 0, 0);
  }

  /** Close the terminal session and clean up resources. */
  close(): void {
    this.cleanup();
  }

  dispose(): void {
    this.close();
    this.onDataEmitter.dispose();
    this.onErrorEmitter.dispose();
    this.onEndEmitter.dispose();
  }

  private cleanup(): void {
    try { this.channel?.close(); } catch { /* ignore */ }
    try { this.client?.end(); } catch { /* ignore */ }
    try { this.client?.destroy(); } catch { /* ignore */ }
    try { this.proxyKill?.(); } catch { /* ignore */ }
    this.channel = undefined as any;
    this.client = undefined;
    this.proxyKill = undefined;
  }
}

// ---------------------------------------------------------------------------
// Webview terminal panel
// ---------------------------------------------------------------------------

/**
 * Create a webview panel with an xterm.js terminal connected to a sandbox.
 *
 * The webview loads xterm.js from a CDN and communicates with the extension
 * backend via postMessage:
 *   - webview → extension: { command: 'input', data: string }
 *   - webview → extension: { command: 'resize', cols: number, rows: number }
 *   - extension → webview: { command: 'output', data: string }
 *   - extension → webview: { command: 'connected' }
 *   - extension → webview: { command: 'error', message: string }
 *   - extension → webview: { command: 'disconnected' }
 */
export function createTerminalPanel(
  cli: OpenShellCli,
  sandboxName: string,
  createPanel: (viewType: string, title: string) => WebviewPanel,
): { panel: WebviewPanel; terminal: SandboxTerminal } {
  const panel = createPanel('openshell-sandbox-terminal', `OpenShell: ${sandboxName}`);
  const terminal = new SandboxTerminal(cli);

  panel.webview.html = renderTerminalHtml(sandboxName);

  // Wire up events: terminal → webview
  terminal.onData(data => {
    panel.webview.postMessage({ command: 'output', data }).catch(() => {});
  });

  terminal.onError(message => {
    panel.webview.postMessage({ command: 'error', message }).catch(() => {});
  });

  terminal.onEnd(() => {
    panel.webview.postMessage({ command: 'disconnected' }).catch(() => {});
  });

  // Wire up events: webview → terminal
  panel.webview.onDidReceiveMessage((msg: unknown) => {
    const message = msg as { command: string; data?: string; cols?: number; rows?: number };
    switch (message.command) {
      case 'input':
        if (message.data) terminal.write(message.data);
        break;
      case 'resize':
        if (message.cols && message.rows) terminal.resize(message.cols, message.rows);
        break;
      case 'ready':
        // Webview is loaded — start the connection
        terminal.open(sandboxName).then(
          () => {
            panel.webview.postMessage({ command: 'connected' }).catch(() => {});
          },
          (err: Error) => {
            panel.webview.postMessage({ command: 'error', message: err.message }).catch(() => {});
          },
        );
        break;
    }
  });

  // Clean up when panel is closed
  panel.onDidChangeViewState(e => {
    if (!e.webviewPanel.visible) {
      // Panel was hidden/closed — optional: could keep alive for reconnect
    }
  });

  // Dispose terminal when panel is disposed
  panel.onDidDispose(() => {
    terminal.dispose();
  });

  return { panel, terminal };
}

// ---------------------------------------------------------------------------
// Terminal HTML with xterm.js
// ---------------------------------------------------------------------------

function renderTerminalHtml(sandboxName: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: #1e1e1e; }
    #status-bar {
      height: 28px;
      display: flex;
      align-items: center;
      padding: 0 12px;
      font-family: 'IBM Plex Sans', system-ui, sans-serif;
      font-size: 12px;
      color: #aaa;
      background: #252526;
      border-bottom: 1px solid #333;
    }
    #status-bar .name { color: #e7e7e7; font-weight: 500; margin-right: 8px; }
    #status-bar .indicator {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 6px;
    }
    .indicator.connecting { background: #ffc107; animation: pulse 1.5s infinite; }
    .indicator.connected { background: #4caf50; }
    .indicator.disconnected { background: #e57373; }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
    #terminal-container {
      width: 100%;
      height: calc(100% - 28px);
    }
    /* Make xterm fit the container */
    .xterm { height: 100%; }
  </style>
</head>
<body>
  <div id="status-bar">
    <span class="indicator connecting" id="indicator"></span>
    <span class="name">${escapeHtml(sandboxName)}</span>
    <span id="status-text">Connecting…</span>
  </div>
  <div id="terminal-container"></div>

  <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0.11.0/lib/addon-web-links.min.js"></script>
  <script>
    const vscode = acquireVsCodeApi();

    // Initialize xterm.js
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'Fira Code', 'Cascadia Code', 'JetBrains Mono', 'Courier New', monospace",
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
        selectionBackground: '#264f78',
        black: '#1e1e1e',
        red: '#f44747',
        green: '#6a9955',
        yellow: '#d7ba7d',
        blue: '#569cd6',
        magenta: '#c586c0',
        cyan: '#4ec9b0',
        white: '#d4d4d4',
        brightBlack: '#808080',
        brightRed: '#f44747',
        brightGreen: '#6a9955',
        brightYellow: '#d7ba7d',
        brightBlue: '#569cd6',
        brightMagenta: '#c586c0',
        brightCyan: '#4ec9b0',
        brightWhite: '#e7e7e7',
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);

    const webLinksAddon = new WebLinksAddon.WebLinksAddon();
    term.loadAddon(webLinksAddon);

    const container = document.getElementById('terminal-container');
    term.open(container);
    fitAddon.fit();

    // Forward user input to the extension backend
    term.onData(data => {
      vscode.postMessage({ command: 'input', data });
    });

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      vscode.postMessage({ command: 'resize', cols: term.cols, rows: term.rows });
    });
    resizeObserver.observe(container);

    // Handle messages from extension backend
    const indicator = document.getElementById('indicator');
    const statusText = document.getElementById('status-text');

    window.addEventListener('message', e => {
      const msg = e.data;
      switch (msg.command) {
        case 'output':
          term.write(msg.data);
          break;
        case 'connected':
          indicator.className = 'indicator connected';
          statusText.textContent = 'Connected';
          term.focus();
          // Send initial resize so remote PTY matches our dimensions
          vscode.postMessage({ command: 'resize', cols: term.cols, rows: term.rows });
          break;
        case 'error':
          indicator.className = 'indicator disconnected';
          statusText.textContent = 'Error: ' + msg.message;
          term.write('\\r\\n\\x1b[31m[Error] ' + msg.message + '\\x1b[0m\\r\\n');
          break;
        case 'disconnected':
          indicator.className = 'indicator disconnected';
          statusText.textContent = 'Disconnected';
          term.write('\\r\\n\\x1b[33m[Disconnected]\\x1b[0m\\r\\n');
          break;
      }
    });

    // Signal the extension that the webview is ready
    term.write('\\x1b[36mConnecting to sandbox \\x1b[1m${escapeHtml(sandboxName)}\\x1b[0m\\x1b[36m…\\x1b[0m\\r\\n');
    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
}
