import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type MouseDeltaCallback = (dx: number, dy: number, eventTimeNs: number) => void;
export type MouseUnavailableCallback = (reason: string) => void;

const MAX_RAW_DELTA_PX = 4096;

const SWIFT_SOURCE = String.raw`
import CoreGraphics
import Darwin
import Foundation

func writeStdout(_ text: String) {
  FileHandle.standardOutput.write(Data(text.utf8))
}

func writeStderr(_ text: String) {
  FileHandle.standardError.write(Data((text + "\n").utf8))
}

var eventTap: CFMachPort?

let callback: CGEventTapCallBack = { _, type, event, _ in
  if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
    if let tap = eventTap {
      CGEvent.tapEnable(tap: tap, enable: true)
    }
    return Unmanaged.passUnretained(event)
  }

  let dx = event.getIntegerValueField(.mouseEventDeltaX)
  let dy = event.getIntegerValueField(.mouseEventDeltaY)
  if dx != 0 || dy != 0 {
    let timestampNs = DispatchTime.now().uptimeNanoseconds
    writeStdout("\(timestampNs) \(dx) \(dy)\n")
  }
  return Unmanaged.passUnretained(event)
}

let eventTypes: [CGEventType] = [
  .mouseMoved,
  .leftMouseDragged,
  .rightMouseDragged,
  .otherMouseDragged
]
let eventMask = eventTypes.reduce(CGEventMask(0)) { mask, type in
  mask | (CGEventMask(1) << CGEventMask(type.rawValue))
}

let createdTap = CGEvent.tapCreate(
  tap: .cghidEventTap,
  place: .headInsertEventTap,
  options: .listenOnly,
  eventsOfInterest: eventMask,
  callback: callback,
  userInfo: nil
) ?? CGEvent.tapCreate(
  tap: .cgSessionEventTap,
  place: .headInsertEventTap,
  options: .listenOnly,
  eventsOfInterest: eventMask,
  callback: callback,
  userInfo: nil
)

guard let tap = createdTap else {
  writeStderr("event-tap-create-failed")
  exit(2)
}

eventTap = tap

guard let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
  writeStderr("run-loop-source-create-failed")
  exit(3)
}

CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
writeStderr("ready")

signal(SIGTERM) { _ in exit(0) }
signal(SIGINT) { _ in exit(0) }

CFRunLoopRun()
`;

export class MacRawMouseDeltaSource {
  private proc: ChildProcess | null = null;
  private compiler: ChildProcess | null = null;
  private pendingStart: {
    onDelta: MouseDeltaCallback;
    onUnavailable?: MouseUnavailableCallback;
  } | null = null;
  private stopping = false;
  private stdoutBuffer = '';
  private emitted = false;

  constructor(private readonly log: (message: string) => void = defaultLog) {}

  start(onDelta: MouseDeltaCallback, onUnavailable?: MouseUnavailableCallback): boolean {
    if (process.platform !== 'darwin') {
      onUnavailable?.('unsupported-platform');
      return false;
    }
    if (this.proc !== null || this.compiler !== null) {
      this.pendingStart = { onDelta, onUnavailable };
      return true;
    }

    const paths = this.getHelperPaths();
    this.pendingStart = { onDelta, onUnavailable };
    this.stopping = false;
    this.stdoutBuffer = '';

    if (fs.existsSync(paths.executablePath)) {
      this.spawnHelper(paths.executablePath, onDelta, onUnavailable);
      return true;
    }

    this.prepareExecutable(paths, onDelta, onUnavailable);
    return true;
  }

  stop(): void {
    this.stopping = true;
    this.pendingStart = null;
    this.stdoutBuffer = '';

    const compiler = this.compiler;
    this.compiler = null;
    if (compiler !== null && !compiler.killed) {
      compiler.kill('SIGTERM');
    }

    const proc = this.proc;
    this.proc = null;
    if (proc !== null && !proc.killed) {
      proc.kill('SIGTERM');
    }
  }

  hasEmitted(): boolean {
    return this.emitted;
  }

  private prepareExecutable(
    paths: HelperPaths,
    onDelta: MouseDeltaCallback,
    onUnavailable?: MouseUnavailableCallback,
  ): void {
    try {
      fs.mkdirSync(paths.cacheDir, { recursive: true });
      fs.writeFileSync(paths.sourcePath, SWIFT_SOURCE, 'utf8');

      const compiler = spawn('/usr/bin/xcrun', [
        'swiftc',
        paths.sourcePath,
        '-O',
        '-o',
        paths.executablePath,
      ]);
      this.compiler = compiler;

      let stderr = '';
      compiler.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      compiler.on('error', (err) => {
        this.compiler = null;
        onUnavailable?.(`compile-spawn-failed: ${err.message}`);
      });

      compiler.on('exit', (code, signal) => {
        this.compiler = null;
        if (this.stopping || this.pendingStart === null) return;
        if (code !== 0) {
          const detail = stderr.trim() || `code=${code ?? 'null'} signal=${signal ?? 'null'}`;
          onUnavailable?.(`compile-failed: ${detail}`);
          return;
        }

        try {
          fs.chmodSync(paths.executablePath, 0o755);
        } catch {
          // If chmod fails, try to spawn anyway; the compiler usually creates
          // the executable with the correct mode.
        }

        const pending = this.pendingStart;
        this.spawnHelper(paths.executablePath, pending.onDelta, pending.onUnavailable);
      });
    } catch (err) {
      this.compiler = null;
      onUnavailable?.(`prepare-failed: ${String(err)}`);
    }
  }

  private spawnHelper(
    executable: string,
    onDelta: MouseDeltaCallback,
    onUnavailable?: MouseUnavailableCallback,
  ): void {
    try {
      const proc = spawn(executable, [], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.proc = proc;

      proc.stdout?.on('data', (chunk: Buffer) => {
        this.handleStdout(chunk, onDelta);
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8').trim();
        if (text.length === 0) return;
        if (text === 'ready') {
          this.log('[mouse] macOS raw mouse delta helper active');
        } else {
          this.log(`[mouse] macOS raw mouse delta helper: ${text}`);
        }
      });

      proc.on('error', (err) => {
        this.proc = null;
        onUnavailable?.(`spawn-failed: ${err.message}`);
      });

      proc.on('exit', (code, signal) => {
        this.proc = null;
        if (!this.stopping) {
          onUnavailable?.(`exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
        }
      });
    } catch (err) {
      this.proc = null;
      onUnavailable?.(`spawn-threw: ${String(err)}`);
    }
  }

  private getHelperPaths(): HelperPaths {
    const hash = createHash('sha256').update(SWIFT_SOURCE).digest('hex').slice(0, 16);
    const cacheDir = path.join(os.tmpdir(), 'pyng-raw-mouse');
    return {
      cacheDir,
      sourcePath: path.join(cacheDir, `raw-mouse-${hash}.swift`),
      executablePath: path.join(cacheDir, `raw-mouse-${hash}`),
    };
  }

  private handleStdout(chunk: Buffer, onDelta: MouseDeltaCallback): void {
    this.stdoutBuffer += chunk.toString('utf8');
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      this.handleLine(line, onDelta);
      newline = this.stdoutBuffer.indexOf('\n');
    }
  }

  private handleLine(line: string, onDelta: MouseDeltaCallback): void {
    if (line.length === 0) return;
    const [timeRaw, dxRaw, dyRaw] = line.split(/\s+/, 3);
    const eventTimeNs = Number(timeRaw);
    const dx = Number(dxRaw);
    const dy = Number(dyRaw);
    if (!Number.isFinite(eventTimeNs) || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    if (dx === 0 && dy === 0) return;
    if (Math.abs(dx) > MAX_RAW_DELTA_PX || Math.abs(dy) > MAX_RAW_DELTA_PX) return;

    this.emitted = true;
    onDelta(dx, dy, eventTimeNs);
  }
}

type HelperPaths = {
  cacheDir: string;
  sourcePath: string;
  executablePath: string;
};

function defaultLog(message: string): void {
  process.stderr.write(`${message}\n`);
}
