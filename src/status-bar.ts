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
import { stripAnsi } from './util';

/**
 * Manages a status bar item that shows the current OpenShell gateway state.
 *
 * The status bar shows:
 *   - "OpenShell: ● running" when a gateway is active
 *   - "OpenShell: ○ stopped" when no gateway is detected
 *   - "OpenShell: ? unknown" when the state cannot be determined
 *
 * Clicking the status bar opens the gateway status/info view.
 */
export class StatusBar {
  private item: extensionApi.StatusBarItem;
  private pollInterval: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly cli: OpenShellCli,
    private readonly statusCommand: string,
  ) {
    this.item = extensionApi.window.createStatusBarItem(extensionApi.StatusBarAlignLeft, 100);
    this.item.command = statusCommand;
    this.item.tooltip = 'OpenShell Gateway Status — click for details';
    this.setUnknown();
    this.item.show();
  }

  /** Start polling for status updates at the given interval (ms). */
  startPolling(intervalMs: number = 15_000): void {
    this.stopPolling();
    // Do an immediate refresh
    this.refresh().catch(() => {});
    this.pollInterval = setInterval(() => {
      this.refresh().catch(() => {});
    }, intervalMs);
  }

  /** Stop the polling loop. */
  stopPolling(): void {
    if (this.pollInterval !== undefined) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }
  }

  /** Manually refresh the status bar. Returns the detected state. */
  async refresh(): Promise<'running' | 'stopped' | 'unknown'> {
    try {
      const output = await this.cli.status();
      const cleaned = stripAnsi(output).toLowerCase();

      if (cleaned.includes('running') || cleaned.includes('ready') || cleaned.includes('healthy')) {
        this.setRunning();
        return 'running';
      } else if (cleaned.includes('stopped') || cleaned.includes('not found') || cleaned.includes('no gateway')) {
        this.setStopped();
        return 'stopped';
      } else {
        this.setUnknown();
        return 'unknown';
      }
    } catch {
      // status command failed — likely no gateway
      this.setStopped();
      return 'stopped';
    }
  }

  /** Dispose the status bar item and stop polling. */
  dispose(): void {
    this.stopPolling();
    this.item.dispose();
  }

  // -----------------------------------------------------------------------
  // Internal state setters
  // -----------------------------------------------------------------------

  private setRunning(): void {
    this.item.text = 'OpenShell: $(circle-filled) running';
    this.item.tooltip = 'OpenShell gateway is running — click for details';
  }

  private setStopped(): void {
    this.item.text = 'OpenShell: $(circle-outline) stopped';
    this.item.tooltip = 'OpenShell gateway is stopped — click to start';
  }

  private setUnknown(): void {
    this.item.text = 'OpenShell: $(question) unknown';
    this.item.tooltip = 'OpenShell gateway status unknown — click to check';
  }
}
