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

/**
 * Wraps a CLI error into a user-friendly message and shows it in the UI.
 * Returns false so callers can `return showCliError(err, ...)`.
 */
export function showCliError(err: unknown, context: string): false {
  let message = `${context}: `;
  if (err && typeof err === 'object' && 'stderr' in err) {
    message += (err as { stderr: string }).stderr || (err as { message?: string }).message || 'Unknown error';
  } else if (err instanceof Error) {
    message += err.message;
  } else {
    message += String(err);
  }
  extensionApi.window.showErrorMessage(message).catch(() => {});
  console.error(message);
  return false;
}

/**
 * Strip ANSI escape sequences from a string.
 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

/**
 * Escape HTML special characters for safe rendering in webview.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Generate a nonce for Content Security Policy in webviews.
 */
export function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
