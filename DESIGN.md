# Podman Desktop Extension for OpenShell — Design Document

## 1. Overview

This document describes the architecture, integration strategy, and implementation plan for a
**Podman Desktop extension** that provides point-and-click management of
[OpenShell](https://github.com/LobsterTrap/OpenShell) (LobsterTrap midstream fork).

OpenShell is a sandboxed execution runtime for autonomous AI agents. It provides three core
primitives — **Gateways**, **Sandboxes**, and **Providers** — coordinated through a CLI
(`openshell`) that manages a K3s Kubernetes cluster inside a single container.

The extension wraps the `openshell` CLI and surfaces its full lifecycle in the Podman Desktop GUI,
giving users a visual, point-and-click workflow for everything they would otherwise do on the
command line.

---

## 2. OpenShell Concepts

| Primitive    | Purpose | CLI Namespace |
|-------------|---------|---------------|
| **Gateway** | Control-plane container running a K3s cluster. Manages sandbox lifecycle and acts as the auth boundary. One gateway per environment (local or remote). | `openshell gateway` |
| **Sandbox** | Isolated container with policy-enforced egress routing. Runs an AI agent (Claude, Codex, Copilot, etc.) inside a supervised environment. | `openshell sandbox` |
| **Provider** | Named credential bundle (API keys, tokens) injected into sandboxes at creation time. Auto-discovered from the host environment or created explicitly. | `openshell provider` |

Additional CLI surfaces exposed by the extension:

| Feature | CLI Command | Description |
|---------|-------------|-------------|
| **Terminal UI** | `openshell term` | Full-screen ratatui TUI for live monitoring |
| **Logs** | `openshell logs [name]` | Sandbox log viewer with tail, level, and source filters |
| **Diagnostics** | `openshell doctor check` | System prerequisite validation |
| **Doctor Logs** | `openshell doctor logs` | Gateway container log viewer |
| **Doctor Exec** | `openshell doctor exec` | Run commands inside the gateway container |

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────┐
│                   Podman Desktop                      │
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │          OpenShell Extension (this project)      │ │
│  │                                                   │ │
│  │  ┌──────────┐  ┌──────────┐  ┌───────────────┐ │ │
│  │  │ Gateway  │  │ Sandbox  │  │   Provider    │ │ │
│  │  │ Manager  │  │ Manager  │  │   Manager     │ │ │
│  │  └────┬─────┘  └────┬─────┘  └──────┬────────┘ │ │
│  │       │              │               │           │ │
│  │  ┌────┴──────────────┴───────────────┴────────┐ │ │
│  │  │            OpenShell CLI Wrapper            │ │ │
│  │  │         (openshell-cli.ts)                  │ │ │
│  │  └────────────────┬───────────────────────────┘ │ │
│  │                   │                              │ │
│  │  ┌────────────────┴───────────────────────────┐ │ │
│  │  │     extensionApi.process.exec(...)          │ │ │
│  │  │     (shells out to `openshell` binary)      │ │ │
│  │  └────────────────────────────────────────────┘ │ │
│  │                                                   │ │
│  │  ┌─────────────┐ ┌─────────────┐ ┌────────────┐ │ │
│  │  │  Log Viewer │ │ Diagnostics │ │ TUI Term   │ │ │
│  │  │  (Webview)  │ │  (Webview)  │ │ (Webview)  │ │ │
│  │  └─────────────┘ └─────────────┘ └────────────┘ │ │
│  └─────────────────────────────────────────────────┘ │
│                                                       │
│  Podman Desktop APIs used:                            │
│  • provider.createProvider() — OpenShell provider     │
│  • cli.createCliTool() — register openshell binary    │
│  • commands.registerCommand() — all CRUD commands     │
│  • window.createWebviewPanel() — logs, diagnostics    │
│  • window.showQuickPick/showInputBox — interactive    │
│  • process.exec() — invoke openshell CLI              │
│  • context.setValue() — state for when-clauses        │
│  • navigation.register() — custom routes              │
│  • window.withProgress() — long-running operations    │
│  • window.createStatusBarItem() — gateway status      │
└──────────────────────────────────────────────────────┘
```

---

## 4. Extension Manifest (package.json contributes)

### 4.1 Provider

The extension registers an **OpenShell provider** (`id: "openshell"`) with:

- Provider status reflecting the active gateway state (started/stopped/unknown)
- Logo/icon branding
- Empty-connection markdown explaining how to get started
- Warning when no container engine is running

### 4.2 CLI Tool

Registers `openshell` as a CLI tool so it appears in Settings → CLI Tools with:

- Version detection (`openshell --version`)
- Binary path display
- Install/update/uninstall lifecycle (via PyPI `uv tool install` or binary installer)

### 4.3 Commands

All user-facing actions are registered as commands:

**Gateway commands:**
| Command ID | Title |
|------------|-------|
| `openshell.gateway.start` | OpenShell: Start Gateway |
| `openshell.gateway.stop` | OpenShell: Stop Gateway |
| `openshell.gateway.destroy` | OpenShell: Destroy Gateway |
| `openshell.gateway.select` | OpenShell: Select Gateway |
| `openshell.gateway.info` | OpenShell: Gateway Info |
| `openshell.gateway.add` | OpenShell: Add Gateway |

**Sandbox commands:**
| Command ID | Title |
|------------|-------|
| `openshell.sandbox.create` | OpenShell: Create Sandbox |
| `openshell.sandbox.delete` | OpenShell: Delete Sandbox |
| `openshell.sandbox.connect` | OpenShell: Connect to Sandbox |
| `openshell.sandbox.list` | OpenShell: List Sandboxes |
| `openshell.sandbox.get` | OpenShell: Sandbox Details |
| `openshell.sandbox.upload` | OpenShell: Upload to Sandbox |
| `openshell.sandbox.download` | OpenShell: Download from Sandbox |
| `openshell.sandbox.exec` | OpenShell: Execute in Sandbox |

**Provider commands:**
| Command ID | Title |
|------------|-------|
| `openshell.provider.create` | OpenShell: Create Provider |
| `openshell.provider.delete` | OpenShell: Delete Provider |
| `openshell.provider.list` | OpenShell: List Providers |
| `openshell.provider.get` | OpenShell: Provider Details |
| `openshell.provider.update` | OpenShell: Update Provider |

**Observability commands:**
| Command ID | Title |
|------------|-------|
| `openshell.logs` | OpenShell: View Logs |
| `openshell.term` | OpenShell: Open Terminal UI |
| `openshell.diagnostics` | OpenShell: Run Diagnostics |
| `openshell.doctor.check` | OpenShell: Doctor Check |
| `openshell.doctor.logs` | OpenShell: Doctor Logs |
| `openshell.status` | OpenShell: Show Status |

### 4.4 Configuration Properties

```jsonc
{
  "openshell.binary.path": {
    "type": "string",
    "format": "file",
    "default": "",
    "description": "Custom path to openshell binary (auto-detected when blank)"
  },
  "openshell.gateway.name": {
    "type": "string",
    "default": "openshell",
    "description": "Default gateway name"
  },
  "openshell.gateway.port": {
    "type": "number",
    "default": 8080,
    "description": "Default gateway port"
  },
  "openshell.gateway.gpu": {
    "type": "boolean",
    "default": false,
    "description": "Enable NVIDIA GPU passthrough for gateways"
  },
  "openshell.sandbox.defaultAgent": {
    "type": "string",
    "default": "",
    "enum": ["claude", "opencode", "codex", "copilot", ""],
    "description": "Default agent to launch with sandbox create"
  },
  "openshell.logs.defaultLines": {
    "type": "number",
    "default": 200,
    "description": "Default number of log lines to fetch"
  },
  "openshell.diagnostics.autoRun": {
    "type": "boolean",
    "default": false,
    "description": "Automatically run doctor check on gateway start"
  },
  "openshell.tui.theme": {
    "type": "string",
    "default": "auto",
    "enum": ["auto", "dark", "light"],
    "description": "Color theme for the TUI"
  }
}
```

### 4.5 Menus

```jsonc
{
  "menus": {
    "dashboard/container": [
      {
        "command": "openshell.sandbox.connect",
        "title": "Connect to OpenShell Sandbox",
        "when": "containerImageName =~ /openshell/"
      }
    ]
  }
}
```

### 4.6 Container Detection

OpenShell containers (gateway and registry) are detected by matching on the
container image name: `containerImageName =~ /openshell/`. This matches
images like `localhost/openshell/cluster:dev`.

**Note:** OpenShell containers do not carry custom labels. Detection relies on
the deterministic naming convention (`openshell-cluster-{name}` for gateways,
`openshell-local-registry` for the local image registry) and the image reference
containing `openshell`.

**Future enhancement:** A custom icon font (woff2) could be contributed to
decorate OpenShell containers in the container list with a distinctive badge.

### 4.7 Onboarding

A guided setup flow for first-time users:
1. Check if `openshell` binary is installed
2. Offer to install it
3. Check for running container engine
4. Start a gateway
5. Create first sandbox

---

## 5. Detailed Workflow Design

### 5.1 Gateway Management

**Start Gateway** (`openshell.gateway.start`):
1. User clicks "Start Gateway" from the provider card or command palette
2. Extension shows a form (via `showInputBox`/`showQuickPick` sequence):
   - Gateway name (default: "openshell")
   - Port (default: 8080)
   - GPU passthrough? (checkbox via quickpick)
   - Remote host? (optional SSH destination)
3. Runs `openshell gateway start --name <name> --port <port> [--gpu] [--remote <dest>]`
4. Shows progress via `window.withProgress(ProgressLocation.TASK_WIDGET)`
5. Updates provider status to "started"
6. Refreshes gateway info

**Stop Gateway** (`openshell.gateway.stop`):
1. Resolves active gateway (or prompts user to select)
2. Confirmation dialog
3. Runs `openshell gateway stop --name <name>`
4. Updates provider status to "stopped"

**Destroy Gateway** (`openshell.gateway.destroy`):
1. Resolves active gateway
2. Warning dialog ("This will destroy all state")
3. Runs `openshell gateway destroy --name <name>`
4. Clears provider connections

**Select Gateway** (`openshell.gateway.select`):
1. Runs `openshell gateway select` to list available gateways
2. Shows QuickPick with gateway names
3. Activates selected gateway
4. Refreshes provider status

**Gateway Info** (`openshell.gateway.info`):
1. Runs `openshell gateway info`
2. Shows result in a webview panel or information message

### 5.2 Sandbox Management

**Create Sandbox** (`openshell.sandbox.create`):
1. Multi-step form:
   - Name (optional, auto-generated if blank)
   - Agent command (quickpick: claude/opencode/codex/copilot/custom)
   - Source image (--from): community name, local path, or image ref
   - Provider attachments (multi-select from existing providers)
   - GPU? (boolean)
   - Policy file? (file picker)
   - Port forward? (optional)
2. Ensures gateway is running (auto-bootstrap prompt if not)
3. Runs `openshell sandbox create [--name <n>] [--from <src>] [--provider <p>...] [--gpu] [--policy <f>] [--forward <port>] -- <agent>`
4. Shows progress
5. Optionally connects to sandbox terminal after creation

**Delete Sandbox** (`openshell.sandbox.delete`):
1. QuickPick of running sandboxes (from `openshell sandbox list --names`)
2. Multi-select for bulk delete
3. Confirmation dialog
4. Runs `openshell sandbox delete <names...>` or `--all`

**Connect to Sandbox** (`openshell.sandbox.connect`):
1. QuickPick of running sandboxes
2. Opens a webview terminal panel that runs `openshell sandbox connect <name>`

**List Sandboxes** (`openshell.sandbox.list`):
1. Runs `openshell sandbox list`
2. Displays in a webview table with status, name, age, actions

**Sandbox Details** (`openshell.sandbox.get`):
1. Runs `openshell sandbox get <name>`
2. Shows detailed info in a webview panel

### 5.3 Provider Management

**Create Provider** (`openshell.provider.create`):
1. Form:
   - Provider name (text input)
   - Provider type (quickpick: claude/opencode/codex/copilot/openai/anthropic/nvidia/generic/...)
   - Credential source: "From existing environment" or "Manual entry"
   - If manual: key-value credential pairs
2. Runs `openshell provider create --name <n> --type <t> --from-existing` or `--credential K=V`

**List Providers** (`openshell.provider.list`):
1. Runs `openshell provider list`
2. Shows in a webview table

**Delete Provider** (`openshell.provider.delete`):
1. QuickPick multi-select
2. Confirmation
3. Runs `openshell provider delete <names...>`

**Update Provider** (`openshell.provider.update`):
1. QuickPick to select provider
2. Choose: re-discover from environment or manual credential update
3. Runs `openshell provider update <name> --from-existing` or `--credential K=V`

### 5.4 Sandbox Connect Terminal

The sandbox connect terminal provides a **full interactive SSH session** to a running
sandbox, embedded directly in a Podman Desktop webview panel.

**Architecture:**

```
xterm.js (webview)
  ↕ postMessage
SandboxTerminal (extension backend — sandbox-terminal.ts)
  ↕ ssh2 Client (pure-JS SSH with PTY allocation)
    ↕ Duplex stream wrapping child_process stdio
  openshell ssh-proxy (child process — HTTP CONNECT tunnel)
    ↕ TCP/TLS
  Gateway → Sandbox SSH server
```

**Connection flow:**

1. Run `openshell sandbox ssh-config <name>` to get SSH config (User, ProxyCommand)
2. Parse the ProxyCommand to extract the `openshell ssh-proxy` invocation
3. Spawn the proxy as a child process with `stdio: 'pipe'`
4. Wrap the child's stdin/stdout as a Node.js `Duplex` stream
5. Pass the Duplex as the `sock` option to `ssh2.Client.connect()` — ssh2 speaks
   SSH protocol directly over the proxy's HTTP CONNECT tunnel
6. Call `client.shell()` with `term: 'xterm-256color'` to allocate a remote PTY
7. Relay bidirectionally between the ssh2 shell stream and the webview's xterm.js
   instance via `postMessage`

**Why this approach:**

- OpenShell sandboxes are accessed through a `ProxyCommand`-based SSH tunnel
  (`openshell ssh-proxy`), not a standard SSH port. Direct `ssh2.connect()` with
  host/port/key won't work.
- The `ssh2` library (already used by Podman Desktop's podman extension) supports
  a `sock` option that accepts any Duplex stream as the transport layer.
- By spawning the ssh-proxy as a child process and wrapping its stdio, we get a
  transparent tunnel that ssh2 treats as a regular TCP socket.
- ssh2 handles PTY allocation on the remote side — no `node-pty` or system `script`
  command needed.

### 5.5 Terminal UI (openshell term)

The TUI is a full-screen ratatui application that expects a real PTY. Since
Podman Desktop webviews cannot provide raw terminal mode, the extension offers
two approaches:

**Approach 1 (Default — Native Terminal):** Launch `openshell term` in the user's
native terminal emulator via platform-specific detection:
- macOS: `osascript` → Terminal.app
- Windows: `wt.exe` (Windows Terminal) or `cmd /c start`
- Linux: tries `x-terminal-emulator`, `gnome-terminal`, `konsole`, `xfce4-terminal`,
  `alacritty`, `kitty`, `xterm` in order

**Approach 2 (Fallback — Embedded Viewer):** A webview panel with a gateway status
snapshot, keyboard shortcut reference, and a button to launch natively. This serves
as an informational fallback when the user prefers to stay inside Podman Desktop.

### 5.5 Log Viewer

**View Logs** (`openshell.logs`):
1. QuickPick to select sandbox (or use last-used)
2. Options:
   - Number of lines (input box, default 200)
   - Tail mode? (boolean)
   - Source filter: gateway / sandbox / all
   - Level filter: error / warn / info / debug / trace
3. Creates a WebviewPanel with formatted log output
4. For tail mode: streams logs via a long-running `openshell logs <name> --tail` process
5. Logs are parsed and displayed with color-coded severity levels
6. Search/filter controls in the webview

### 5.6 Diagnostics Viewer

**Run Diagnostics** (`openshell.diagnostics`):
1. Creates a WebviewPanel "OpenShell Diagnostics"
2. Three sections, each populated on-demand:

   **System Check** (`openshell doctor check`):
   - Container runtime status
   - Version info
   - Socket path accessibility

   **Gateway Status** (`openshell status`):
   - Gateway health
   - Connected sandboxes
   - Provider configuration

   **Gateway Logs** (`openshell doctor logs`):
   - Last N lines from the gateway container
   - Filterable and searchable

3. Refresh button to re-run checks
4. "Auto-run on gateway start" preference

---

## 6. File Structure

```
podman-desktop-extension-openshell/
├── DESIGN.md               ← This document
├── README.md               ← User-facing documentation
├── LICENSE                 ← Apache 2.0
├── package.json            ← Extension manifest
├── tsconfig.json           ← TypeScript configuration
├── vite.config.js          ← Build configuration
├── icon.png                ← Extension icon (OpenShell logo)
├── icon.svg                ← SVG source for icon
├── .gitignore
├── .npmignore
├── scripts/
│   └── build.js            ← Post-build .cdix packaging script
└── src/
    ├── extension.ts         ← Activation entry point
    ├── openshell-cli.ts     ← Typed CLI wrapper (process.exec)
    ├── gateway-manager.ts   ← Gateway lifecycle management
    ├── sandbox-manager.ts   ← Sandbox lifecycle management
    ├── sandbox-terminal.ts  ← Interactive SSH terminal (ssh2 + xterm.js)
    ├── provider-manager.ts  ← Provider CRUD management
    ├── log-viewer.ts        ← Log webview panel with auto-refresh
    ├── diagnostics.ts       ← Diagnostics webview panel
    ├── tui-terminal.ts      ← TUI native terminal launcher
    ├── status-bar.ts        ← Status bar item with polling
    └── util.ts              ← Shared utilities
```

---

## 7. State Management

The extension maintains state via:

- **`context.setValue()`** for when-clause conditions:
  - `openshell.gatewayRunning` — boolean
  - `openshell.activeSandboxes` — count
  - `openshell.activeGateway` — name string
  - `openshell.cliInstalled` — boolean

- **Polling loop** (every 10 seconds when active):
  - Runs `openshell status` to update gateway state
  - Runs `openshell sandbox list` to track sandbox count
  - Updates provider status and status bar

- **Event-driven updates**:
  - After any CRUD command completes, immediately refresh state
  - Container engine events trigger gateway re-detection

---

## 8. Error Handling

- All CLI executions are wrapped in try/catch
- `RunError` (non-zero exit code) is caught and shown via `window.showErrorMessage()`
- Specific error patterns are detected:
  - "No active gateway" → prompt to start one
  - "openshell: command not found" → prompt to install
  - Connection refused → check container engine status
- Timeout handling for long-running operations (gateway start can take 60s+)

---

## 9. Security Considerations

- The extension never stores credentials itself; it delegates to `openshell provider`
- API keys are passed via `--credential KEY=VALUE` or `--from-existing` (env discovery)
- No credentials are logged or displayed in webview UIs
- All process.exec calls use the Podman Desktop sandboxed exec API
- The extension respects the user's container runtime preference (docker/podman)

---

## 10. Future Enhancements

- **Policy editor**: Visual YAML editor for sandbox policies
- **Inference configuration**: GUI for `openshell inference set/get/update`
- **Port forwarding manager**: Visual management of `openshell forward` commands
- **Remote gateway support**: SSH key management and remote deployment wizard
- **Community sandbox browser**: Browse and deploy from the OpenShell Community catalog
- **Settings editor**: Visual management of `openshell settings` (gateway + sandbox scopes)
