// DaemonClient：管理 optrace-daemon 子进程，JSON-RPC 通信（换行分隔）

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { EventEmitter } from 'events';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: string) => void;
  timer: NodeJS.Timeout;
}

export class DaemonClient extends EventEmitter {
  private proc: cp.ChildProcess | undefined;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private buffer = '';
  private outputChannel: vscode.OutputChannel;
  private context: vscode.ExtensionContext;
  private _ready = false;
  private readyResolvers: Array<() => void> = [];

  constructor(context: vscode.ExtensionContext) {
    super();
    this.context = context;
    this.outputChannel = vscode.window.createOutputChannel('OpTrace Daemon');
    this.start();
  }



  private start() {
    const binaryPath = this.findBinary();
    if (!binaryPath) {
      vscode.window.showErrorMessage(
        'OpTrace: optrace-daemon binary not found. Please build the Rust backend first.'
      );
      return;
    }

    this.outputChannel.appendLine(`[OpTrace] Starting daemon: ${binaryPath}`);

    const dataDir = path.join(this.context.globalStorageUri.fsPath, 'data');
    fs.mkdirSync(dataDir, { recursive: true });

    this.proc = cp.spawn(binaryPath, [], {
      env: { ...process.env, OPTRACE_DATA_DIR: dataDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    this.proc.stderr?.on('data', (chunk: Buffer) => {
      this.outputChannel.appendLine('[daemon] ' + chunk.toString().trimEnd());
    });

    this.proc.on('exit', (code) => {
      this.outputChannel.appendLine(`[OpTrace] Daemon exited with code ${code}`);
      this._ready = false;
      setTimeout(() => this.start(), 5000); // 5秒后重启
    });

    this.proc.on('error', (err) => {
      this.outputChannel.appendLine(`[OpTrace] Daemon error: ${err.message}`);
    });
  }

  stop() {
    this.proc?.kill();
    this.proc = undefined;
  }

  private findBinary(): string | undefined {
    const bundled = path.join(this.context.extensionPath, 'bin', 'optrace-daemon');
    if (fs.existsSync(bundled)) return bundled;

    // 开发模式：从 Rust 编译目录找
    const devPaths = [
      path.join(this.context.extensionPath, '..', 'src-tauri', 'target', 'release', 'optrace-daemon'),
      path.join(this.context.extensionPath, '..', 'src-tauri', 'target', 'debug', 'optrace-daemon'),
    ];
    for (const p of devPaths) {
      if (fs.existsSync(p)) return p;
    }
    return undefined;
  }



  private processBuffer() {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        this.handleMessage(JSON.parse(trimmed));
      } catch (e) {
        this.outputChannel.appendLine(`[OpTrace] Parse error: ${e} | line: ${trimmed}`);
      }
    }
  }

  private handleMessage(msg: Record<string, unknown>) {
    // push 事件（id 为 null）
    if (msg.id === null || msg.id === undefined) {
      const event = msg.event as string;
      if (event === 'ready') {
        this._ready = true;
        this.readyResolvers.forEach(r => r());
        this.readyResolvers = [];
        this.outputChannel.appendLine('[OpTrace] Daemon ready');
      }
      this.emit('event', event, msg.data);
      return;
    }


    const id = msg.id as number;
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);

    if (msg.error) {
      pending.reject(msg.error as string);
    } else {
      pending.resolve(msg.result);
    }
  }



  waitReady(): Promise<void> {
    if (this._ready) return Promise.resolve();
    return new Promise(resolve => this.readyResolvers.push(resolve));
  }

  invoke<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.proc) {
        reject('Daemon not running');
        return;
      }

      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(`Timeout: ${method} (#${id})`);
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });

      const msg = JSON.stringify({ id, method, params }, (_k, v) => typeof v === 'bigint' ? v.toString() : v) + '\n';
      this.proc.stdin?.write(msg);
    });
  }

  sendOpTrace(params: Record<string, unknown>): number {
    return this.sendStreaming('op_trace', params);
  }

  // 流式命令：不等返回，结果通过 event 推送
  sendStreaming(method: string, params: Record<string, unknown>): number {
    if (!this.proc) return -1;
    const id = this.nextId++;


    const timer = setTimeout(() => {
      this.pending.delete(id);
    }, 5 * 60_000); // 5分钟超时

    this.pending.set(id, {
      resolve: () => {},
      reject: () => {},
      timer,
    });

    const msg = JSON.stringify({ id, method, params }, (_k, v) => typeof v === 'bigint' ? v.toString() : v) + '\n';
    this.proc.stdin?.write(msg);
    return id;
  }

  isReady(): boolean {
    return this._ready;
  }
}
