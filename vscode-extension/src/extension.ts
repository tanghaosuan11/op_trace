import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { DaemonClient } from './daemon';
import { WebviewManager } from './webview';

let daemonClient: DaemonClient | undefined;
let webviewManager: WebviewManager | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log('[OpTrace] Extension activated');

  daemonClient = new DaemonClient(context);
  webviewManager = new WebviewManager(context, daemonClient);

  context.subscriptions.push(
    vscode.commands.registerCommand('optrace.open', () => {
      webviewManager!.openMainPanel();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('optrace.openCfg', (args?: { sessionId: string; frameId: number; contractName?: string }) => {
      webviewManager!.openCfgPanel(args);
    })
  );

  context.subscriptions.push({
    dispose: () => {
      daemonClient?.stop();
    }
  });
}

export function deactivate() {
  daemonClient?.stop();
}
