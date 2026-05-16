// WebviewManager：主调试面板（单例）+ CFG 窗口（多 Tab）

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { DaemonClient } from './daemon';

export class WebviewManager {
  private context: vscode.ExtensionContext;
  private daemon: DaemonClient;
  private mainPanel: vscode.WebviewPanel | undefined;
  private cfgPanels: vscode.WebviewPanel[] = [];

  constructor(context: vscode.ExtensionContext, daemon: DaemonClient) {
    this.context = context;
    this.daemon = daemon;

    // daemon push 事件广播到所有 panel
    daemon.on('event', (event: string, data: unknown) => {
      this.broadcast({ type: 'daemon_event', event, data });
    });
  }

  openMainPanel() {
    if (this.mainPanel) {
      this.mainPanel.reveal(vscode.ViewColumn.One);
      return;
    }

    this.mainPanel = vscode.window.createWebviewPanel(
      'optrace-main',
      'OpTrace Debugger',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true, // 保留状态，切 tab 不销毁
        localResourceRoots: [
          vscode.Uri.file(path.join(this.context.extensionPath, 'webview-dist')),
        ],
      }
    );

    this.mainPanel.webview.html = this.getWebviewHtml(this.mainPanel.webview);

    this.mainPanel.webview.onDidReceiveMessage(
      (msg) => this.handleWebviewMessage(msg, this.mainPanel!),
      undefined,
      this.context.subscriptions
    );

    this.mainPanel.onDidDispose(() => {
      this.mainPanel = undefined;
    });
  }

  openCfgPanel(args?: { sessionId?: string; frameId?: number; contractName?: string }) {
    const title = `CFG: ${args?.contractName ?? 'frame ' + (args?.frameId ?? '?')}`;

    const panel = vscode.window.createWebviewPanel(
      'optrace-cfg',
      title,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(this.context.extensionPath, 'webview-dist')),
        ],
      }
    );

    panel.webview.html = this.getWebviewHtml(panel.webview, { mode: 'cfg', ...args });

    this.cfgPanels.push(panel);
    panel.onDidDispose(() => {
      this.cfgPanels = this.cfgPanels.filter(p => p !== panel);
    });

    panel.webview.onDidReceiveMessage(
      (msg) => this.handleWebviewMessage(msg, panel),
      undefined,
      this.context.subscriptions
    );
  }

  private async handleWebviewMessage(
    msg: { type: string; id?: number; method?: string; params?: Record<string, unknown> },
    panel: vscode.WebviewPanel
  ) {
    if (msg.type !== 'invoke') return;

    const { id, method, params = {} } = msg;
    if (!method || id === undefined) return;

    try {
      // 流式命令：立即 ack，结果通过 daemon_event 推送
      if (method === 'op_trace') {
        this.daemon.sendOpTrace(params);
        panel.webview.postMessage({ type: 'invoke_result', id, result: null });
        return;
      }

      if (method === 'start_foundry_debug') {
        this.daemon.sendStreaming('start_foundry_debug', params);
        panel.webview.postMessage({ type: 'invoke_result', id, result: null });
        return;
      }

      if (method === 'open_cfg_window') {
        vscode.commands.executeCommand('optrace.openCfg', params);
        panel.webview.postMessage({ type: 'invoke_result', id, result: null });
        return;
      }

      if (method === 'cfg_broadcast') {
        const { event, data } = params as { event: string; data: unknown };
        this.broadcastToCfgPanels({ type: 'daemon_event', event, data });
        panel.webview.postMessage({ type: 'invoke_result', id, result: null });
        return;
      }

      if (method === 'cfg_request_snapshot') {
        this.mainPanel?.webview.postMessage({ type: 'daemon_event', event: 'cfg_request_snapshot', data: params });
        panel.webview.postMessage({ type: 'invoke_result', id, result: null });
        return;
      }

      if (method === 'open_folder_dialog') {
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
          title: typeof params.title === 'string' ? params.title : 'Select Folder',
        });
        const folderPath = uris?.[0]?.fsPath ?? null;
        panel.webview.postMessage({ type: 'invoke_result', id, result: folderPath });
        return;
      }

      if (method === 'open_app_data_dir') {
        const dataDir = path.join(this.context.globalStorageUri.fsPath, 'data');
        vscode.env.openExternal(vscode.Uri.file(dataDir));
        panel.webview.postMessage({ type: 'invoke_result', id, result: null });
        return;
      }

      const result = await this.daemon.invoke(method, params);
      panel.webview.postMessage({ type: 'invoke_result', id, result });
    } catch (err) {
      panel.webview.postMessage({ type: 'invoke_error', id, error: String(err) });
    }
  }

  private broadcast(msg: unknown) {
    this.mainPanel?.webview.postMessage(msg);
  }

  private broadcastToCfgPanels(msg: unknown) {
    for (const p of this.cfgPanels) {
      try { p.webview.postMessage(msg); } catch { /* panel may have been disposed */ }
    }
  }

  private getWebviewHtml(webview: vscode.Webview, initData?: Record<string, unknown>): string {
    const distPath = path.join(this.context.extensionPath, 'webview-dist');
    // webview-dist 未构建时提示
    if (!fs.existsSync(distPath)) {
      return `<!DOCTYPE html><html><body>
        <h2>OpTrace</h2>
        <p>Please build the frontend first: <code>pnpm build</code></p>
        <p>Then copy <code>dist/</code> to <code>vscode-extension/webview-dist/</code></p>
      </body></html>`;
    }

    let html = fs.readFileSync(path.join(distPath, 'index.html'), 'utf-8');
    // 将资源路径替换为 vscode-resource URI
    const assetUri = webview.asWebviewUri(vscode.Uri.file(path.join(distPath)));
    html = html
      .replace(/src="\/([^"]+)"/g, `src="${assetUri}/$1"`)
      .replace(/href="\/([^"]+)"/g, `href="${assetUri}/$1"`)
      .replace(/(src|href)="(\.\/[^"]+)"/g, `$1="${assetUri}/$2"`);
    html = html.replace(/ crossorigin(?:="[^"]*")?/g, ''); // VSCode webview 不支持 CORS
    const bridgeScript = `
<script>
  // VSCode bridge：替换 Tauri invoke
  (function() {
    const vscode = acquireVsCodeApi();
    let pendingId = 1;
    const pending = new Map();

    window.__optrace_vscode_invoke__ = function(method, params) {
      return new Promise((resolve, reject) => {
        const id = pendingId++;
        pending.set(id, { resolve, reject });
        vscode.postMessage({ type: 'invoke', id, method, params: params || {} });
      });
    };

    const eventListeners = new Map();
    window.__optrace_on_event__ = function(event, handler) {
      if (!eventListeners.has(event)) eventListeners.set(event, []);
      eventListeners.get(event).push(handler);
    };

    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (!msg || !msg.type) return;

      if (msg.type === 'invoke_result') {
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); p.resolve(msg.result); }
      } else if (msg.type === 'invoke_error') {
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); p.reject(msg.error); }
      } else if (msg.type === 'daemon_event') {
        const handlers = eventListeners.get(msg.event) || [];
        handlers.forEach(h => h(msg.data));
        const allHandlers = eventListeners.get('*') || [];
        allHandlers.forEach(h => h(msg.event, msg.data));
      }
    });

    window.__optrace_init__ = ${JSON.stringify(initData ?? {})};

    console.log('[OpTrace Bridge] Initializing webview bridge...');
    
    function appendError(msg) {
      console.error('[OpTrace] ' + msg);
      var div = document.getElementById('__optrace_err__');
      if (!div) {
        div = document.createElement('div');
        div.id = '__optrace_err__';
        div.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;padding:20px;background:#8B0000;color:#FFD700;z-index:99999;font:12px monospace;white-space:pre-wrap;overflow:auto';
        document.documentElement.appendChild(div);
      }
      div.textContent += msg + '\\n\\n';
    }
    
    window.addEventListener('error', function(e) {
      var msg = 'JS ERROR: ' + (e.message || e) + '\\n  at ' + e.filename + ':' + e.lineno + ':' + e.colno + '\\n  Stack: ' + (e.error && e.error.stack ? e.error.stack : '(no stack)');
      appendError(msg);
    });
    
    window.addEventListener('unhandledrejection', function(e) {
      var msg = 'UNHANDLED REJECTION: ' + (e.reason ? (e.reason.message || e.reason) : e);
      appendError(msg);
    });
    
  })();
</script>`;

    html = html.replace('</head>', bridgeScript + '\n</head>');

    const csp = `<meta http-equiv="Content-Security-Policy" content="
      default-src 'none';
      script-src ${webview.cspSource} 'unsafe-inline' 'unsafe-eval';
      worker-src blob:;
      style-src ${webview.cspSource} 'unsafe-inline';
      img-src ${webview.cspSource} data:;
      font-src ${webview.cspSource};
      connect-src https: http:;
    ">`;
    html = html.replace('<head>', '<head>\n' + csp);

    return html;
  }
}
