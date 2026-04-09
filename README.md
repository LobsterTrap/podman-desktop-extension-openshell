# OpenShell Extension for Podman Desktop

A [Podman Desktop](https://podman-desktop.io/) extension that provides point-and-click management of [OpenShell](https://github.com/LobsterTrap/OpenShell) (LobsterTrap midstream fork) — the safe, private runtime for autonomous AI agents.

## Features

### 🏗️ Gateway Management
Start, stop, destroy, select, and configure OpenShell gateways directly from Podman Desktop. The gateway is the control-plane container that coordinates sandbox lifecycle and acts as the auth boundary.

- **Start Gateway** — Interactive form for name, port, GPU passthrough, and remote deployment
- **Stop Gateway** — Gracefully stop a running gateway (preserves state)
- **Destroy Gateway** — Permanently delete a gateway and all its state
- **Select Gateway** — Switch between multiple configured gateways
- **Add Gateway** — Register an existing gateway (local, remote mTLS, or edge-authenticated)
- **Gateway Info** — View detailed gateway configuration and status

### 📦 Sandbox Management
Create, delete, connect to, and inspect sandboxes — isolated container environments for AI agents with policy-enforced security.

- **Create Sandbox** — Guided wizard: select agent (Claude, Codex, Copilot, OpenCode), choose image source (default, community, custom, local Dockerfile), attach providers, configure GPU/policy
- **Delete Sandbox** — Multi-select deletion with confirmation
- **Connect to Sandbox** — Open a terminal session to a running sandbox
- **List Sandboxes** — Interactive webview table with status, ID, age, and action buttons
- **Sandbox Details** — Inspect sandbox configuration and metadata
- **Execute in Sandbox** — Run commands inside a running sandbox

### 🔑 Provider Management
Create, update, delete, and inspect credential providers — named credential bundles (API keys, tokens) injected into sandboxes at runtime.

- **Create Provider** — Select type (Claude, OpenAI, Anthropic, GitHub, NVIDIA, etc.), choose credential source (auto-discover from environment or manual entry)
- **Update Provider** — Re-discover credentials or manually update key-value pairs
- **Delete Provider** — Multi-select deletion
- **List Providers** — Interactive webview table with type and action buttons
- **Provider Details** — Inspect provider configuration (credentials are never displayed)

### 🖥️ Terminal UI
Access the OpenShell TUI — a real-time terminal dashboard for monitoring gateways, sandboxes, and providers, inspired by [k9s](https://k9scli.io/).

- **Native Terminal** — Launch `openshell term` in your system terminal emulator (recommended for full interactivity)
- **Embedded Viewer** — Simplified status viewer inside Podman Desktop with keyboard shortcut reference

### 📋 Log Viewer
View and stream sandbox logs with filtering and search.

- **Snapshot mode** — Fetch the last N log lines
- **Tail mode** — Stream live logs in real-time
- **Filters** — By source (gateway/sandbox), level (error/warn/debug), and time range
- **Search** — Full-text search with highlighting
- **Color coding** — Error (red), warn (yellow), debug (blue), trace (gray)

### 🔍 Diagnostics
Comprehensive diagnostics viewer aggregating output from multiple OpenShell diagnostic commands.

- **System Check** (`openshell doctor check`) — Validate prerequisites: container runtime installed, running, and reachable
- **Gateway Status** (`openshell status`) — Current gateway health and configuration
- **Gateway Logs** (`openshell doctor logs`) — Recent gateway container logs
- **Quick Check** — One-click doctor check from the command palette
- **Collapsible sections** — Each diagnostic section can be expanded/collapsed independently
- **Re-run button** — Refresh all diagnostics with one click

### 📊 Status Bar
A persistent status bar indicator showing the current gateway state:
- `● running` — Gateway is active and healthy
- `○ stopped` — No gateway detected
- Click to open the full status view

## Screenshots

*(TODO: Add screenshots once the extension is built and running)*

## Installation

### Prerequisites

- [Podman Desktop](https://podman-desktop.io/) v0.0.1+
- [Podman](https://podman.io/) or Docker installed and running
- [OpenShell CLI](https://github.com/LobsterTrap/OpenShell) installed (or the extension will offer to install it)

### Install the Extension

#### From the Extension Catalog
*(Coming soon — once published to the Podman Desktop extension registry)*

#### Manual Installation
1. Clone this repository:
   ```bash
   git clone https://github.com/LobsterTrap/podman-desktop-extension-openshell.git
   cd podman-desktop-extension-openshell
   ```

2. Install dependencies and build:
   ```bash
   npm install
   npm run build
   ```

3. Install in Podman Desktop:
   - Open Podman Desktop → Settings → Extensions
   - Click "Install a new extension from OCI Image" or drag the `.cdix` file

### Install OpenShell CLI

If you don't have `openshell` installed, the extension will prompt you to install it. You can also install it manually:

**Binary (recommended):**
```bash
curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh
```

**From PyPI (requires [uv](https://docs.astral.sh/uv/)):**
```bash
uv tool install -U openshell
```

**Fedora/RHEL via COPR:**
```bash
sudo dnf copr enable maxamillion/openshell
sudo dnf install openshell
```

## Usage

### Quick Start

1. **Start a gateway**: Open the command palette (`Ctrl+Shift+P`) → `OpenShell: Start Gateway`
2. **Create a sandbox**: `OpenShell: Create Sandbox` → Select an agent (Claude, Codex, etc.)
3. **Monitor**: `OpenShell: Diagnostics` or `OpenShell: Open Terminal UI`

### Command Palette

All commands are available from the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

| Command | Description |
|---------|-------------|
| `OpenShell: Start Gateway` | Deploy a new gateway |
| `OpenShell: Stop Gateway` | Stop the active gateway |
| `OpenShell: Destroy Gateway` | Permanently destroy a gateway |
| `OpenShell: Select Gateway` | Switch between gateways |
| `OpenShell: Gateway Info` | View gateway details |
| `OpenShell: Add Gateway` | Register an existing gateway |
| `OpenShell: Create Sandbox` | Create a new sandbox |
| `OpenShell: Delete Sandbox` | Delete sandbox(es) |
| `OpenShell: Connect to Sandbox` | Open a terminal to a sandbox |
| `OpenShell: List Sandboxes` | View all sandboxes |
| `OpenShell: Sandbox Details` | Inspect a sandbox |
| `OpenShell: Execute in Sandbox` | Run a command in a sandbox |
| `OpenShell: Create Provider` | Create a credential provider |
| `OpenShell: Delete Provider` | Delete provider(s) |
| `OpenShell: List Providers` | View all providers |
| `OpenShell: Provider Details` | Inspect a provider |
| `OpenShell: Update Provider` | Update provider credentials |
| `OpenShell: View Logs` | Open the log viewer |
| `OpenShell: Open Terminal UI` | Launch the TUI |
| `OpenShell: Diagnostics` | Open diagnostics panel |
| `OpenShell: Doctor Check` | Quick system check |
| `OpenShell: Show Status` | Full status overview |

### Configuration

Settings are available in Podman Desktop → Settings → Preferences → OpenShell:

| Setting | Default | Description |
|---------|---------|-------------|
| `openshell.binary.path` | *(auto-detect)* | Custom path to the `openshell` binary |
| `openshell.gateway.name` | `openshell` | Default gateway name |
| `openshell.gateway.port` | `8080` | Default gateway port |
| `openshell.gateway.gpu` | `false` | Enable NVIDIA GPU passthrough by default |
| `openshell.sandbox.defaultAgent` | *(none)* | Default agent for sandbox creation |
| `openshell.logs.defaultLines` | `200` | Default number of log lines to fetch |
| `openshell.diagnostics.autoRun` | `false` | Auto-run doctor check on activation |
| `openshell.tui.theme` | `auto` | TUI color theme (auto/dark/light) |

## Architecture

The extension is a thin GUI layer over the `openshell` CLI. All operations call `extensionApi.process.exec()` to invoke the binary, parse its output, and present results through Podman Desktop's UI primitives:

```
Extension                          OpenShell CLI
┌─────────────────────┐           ┌─────────────┐
│ GatewayManager      │──exec──→  │ gateway     │
│ SandboxManager      │──exec──→  │ sandbox     │
│ ProviderManager     │──exec──→  │ provider    │
│ LogViewer           │──exec──→  │ logs        │
│ DiagnosticsViewer   │──exec──→  │ doctor      │
│ TuiTerminal         │──spawn──→ │ term        │
│ StatusBar           │──exec──→  │ status      │
│ SandboxTerminal     │──ssh2───→ │ ssh-proxy   │
└─────────────────────┘           └─────────────┘
         │                               │
         ▼                               ▼
  Podman Desktop APIs             SSH tunnel to
  (provider, commands,            sandbox container
   webviews, process,             (via HTTP CONNECT
   context, statusbar,            through gateway)
   progress, dialogs)
```

The sandbox terminal uses a custom architecture for full interactive SSH
sessions: `openshell ssh-proxy` is spawned as a child process, its stdio
is wrapped as a Node.js `Duplex` stream, and the `ssh2` library speaks
SSH protocol over that stream — no system SSH binary or `node-pty` needed.
See [DESIGN.md](DESIGN.md) §5.4 for the full connection flow.

See [DESIGN.md](DESIGN.md) for the full architecture documentation.

## Development

### Prerequisites

- Node.js 18+
- npm or pnpm

### Build

```bash
npm install
npm run build          # Build for production
npm run watch          # Build with watch mode for development
```

### Test

```bash
npm test               # Run tests
npm run test:watch     # Watch mode
```

### Project Structure

```
src/
├── extension.ts         # Activation entry point — wires everything together
├── openshell-cli.ts     # Typed wrapper around the openshell binary
├── gateway-manager.ts   # Gateway CRUD + lifecycle UI
├── sandbox-manager.ts   # Sandbox CRUD + lifecycle UI
├── sandbox-terminal.ts  # Interactive SSH terminal (ssh2 + xterm.js)
├── provider-manager.ts  # Provider CRUD UI
├── log-viewer.ts        # Log streaming webview with auto-refresh
├── diagnostics.ts       # Diagnostics aggregation webview
├── tui-terminal.ts      # TUI native terminal launcher
├── status-bar.ts        # Status bar indicator with polling
└── util.ts              # Shared utilities (error handling, HTML escaping)
```

## Contributing

Contributions are welcome! Please see the [OpenShell CONTRIBUTING.md](https://github.com/LobsterTrap/OpenShell/blob/midstream/CONTRIBUTING.md) for guidelines.

## License

[Apache License 2.0](LICENSE)
