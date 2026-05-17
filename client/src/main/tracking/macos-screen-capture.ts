import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GrayFrame } from '../ocr/screenCapture.js';
import type { TrackingCaptureLoopOptions, TrackingFrameLoop } from './capture-loop.js';

const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
const DEFAULT_TARGET_HEIGHT = 540;
const FALLBACK_MAX_FPS = 30;

const SWIFT_SOURCE = String.raw`
import CoreMedia
import CoreVideo
import Darwin
import Foundation
import ScreenCaptureKit

func writeStderr(_ text: String) {
  FileHandle.standardError.write(Data((text + "\n").utf8))
}

func parseIntArg(_ index: Int, _ fallback: Int) -> Int {
  let args = CommandLine.arguments
  if args.count <= index { return fallback }
  return Int(args[index]) ?? fallback
}

final class StreamOutput: NSObject, SCStreamOutput, SCStreamDelegate {
  private var frameId: UInt64 = 0
  private let includeRgb: Bool
  private let writeQueue = DispatchQueue(label: "pyng.screencapture.write")
  private let stateLock = NSLock()
  private var writePending = false

  init(includeRgb: Bool) {
    self.includeRgb = includeRgb
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen else { return }
    guard CMSampleBufferDataIsReady(sampleBuffer) else { return }
    guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

    CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

    let width = CVPixelBufferGetWidth(pixelBuffer)
    let height = CVPixelBufferGetHeight(pixelBuffer)
    let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
    guard width > 0, height > 0, let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else { return }

    stateLock.lock()
    if writePending {
      stateLock.unlock()
      return
    }
    writePending = true
    stateLock.unlock()

    let source = baseAddress.assumingMemoryBound(to: UInt8.self)
    var gray = [UInt8](repeating: 0, count: width * height)
    var rgb = includeRgb ? [UInt8](repeating: 0, count: width * height * 3) : []
    let pixelFormat = CVPixelBufferGetPixelFormatType(pixelBuffer)

    if pixelFormat == kCVPixelFormatType_32BGRA || pixelFormat == kCVPixelFormatType_32ARGB {
      for y in 0..<height {
        let row = source.advanced(by: y * bytesPerRow)
        let outOffset = y * width
        for x in 0..<width {
          let px = row.advanced(by: x * 4)
          let b = UInt16(px[0])
          let g = UInt16(px[1])
          let r = UInt16(px[2])
          gray[outOffset + x] = UInt8((r * 77 + g * 150 + b * 29) >> 8)
          if includeRgb {
            let rgbOffset = (outOffset + x) * 3
            rgb[rgbOffset] = UInt8(r)
            rgb[rgbOffset + 1] = UInt8(g)
            rgb[rgbOffset + 2] = UInt8(b)
          }
        }
      }
    } else {
      for y in 0..<height {
        let row = source.advanced(by: y * bytesPerRow)
        let outOffset = y * width
        for x in 0..<width {
          let value = row[x]
          gray[outOffset + x] = value
          if includeRgb {
            let rgbOffset = (outOffset + x) * 3
            rgb[rgbOffset] = value
            rgb[rgbOffset + 1] = value
            rgb[rgbOffset + 2] = value
          }
        }
      }
    }

    let timestampNs = DispatchTime.now().uptimeNanoseconds
    frameId += 1
    let currentFrameId = frameId
    writeQueue.async {
      defer {
        self.stateLock.lock()
        self.writePending = false
        self.stateLock.unlock()
      }
      let header = "PYNG_FRAME \(timestampNs) \(width) \(height) \(currentFrameId) 0 \(rgb.count)\n"
      FileHandle.standardOutput.write(Data(header.utf8))
      FileHandle.standardOutput.write(Data(gray))
      if !rgb.isEmpty {
        FileHandle.standardOutput.write(Data(rgb))
      }
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    writeStderr("stream-stopped: \(error.localizedDescription)")
    exit(4)
  }
}

@main
struct PyngScreenCaptureMain {
  static func main() async {
    let targetHeight = max(120, min(720, parseIntArg(1, 540)))
    let fps = max(1, min(60, parseIntArg(2, 60)))
    let includeRgb = parseIntArg(3, 0) == 1

    if #available(macOS 12.3, *) {
      do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first else {
          writeStderr("no-display")
          exit(2)
        }

        let targetWidth = max(1, Int((Double(display.width) / Double(display.height)) * Double(targetHeight)))
        let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        let configuration = SCStreamConfiguration()
        configuration.width = targetWidth
        configuration.height = targetHeight
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        configuration.queueDepth = 3
        configuration.showsCursor = false

        let output = StreamOutput(includeRgb: includeRgb)
        let stream = SCStream(filter: filter, configuration: configuration, delegate: output)
        try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "pyng.screencapture.frames"))
        try await stream.startCapture()
        writeStderr("ready fps=\(fps) size=\(targetWidth)x\(targetHeight) rgb=\(includeRgb ? 1 : 0)")
        dispatchMain()
      } catch {
        writeStderr("start-failed: \(error.localizedDescription)")
        exit(3)
      }
    } else {
      writeStderr("unsupported-macos")
      exit(1)
    }
  }
}
`;

type HelperPaths = {
  cacheDir: string;
  sourcePath: string;
  executablePath: string;
};

export type MacScreenCaptureLoopOptions = TrackingCaptureLoopOptions & {
  fallbackFactory: () => TrackingFrameLoop;
  targetHeight?: number;
  log?: (message: string) => void;
};

export class MacScreenCaptureLoop implements TrackingFrameLoop {
  private proc: ChildProcess | null = null;
  private compiler: ChildProcess | null = null;
  private fallback: TrackingFrameLoop | null = null;
  private stdoutBuffer = Buffer.alloc(0);
  private running = false;
  private stopping = false;
  private emittedFrames = false;
  private fps: number;
  private lastDeliveredAtNs = 0;

  constructor(private readonly options: MacScreenCaptureLoopOptions) {
    this.fps = clampFps(options.fps ?? 60);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.stdoutBuffer = Buffer.alloc(0);
    this.emittedFrames = false;
    this.lastDeliveredAtNs = 0;
    this.startNative();
  }

  stop(): void {
    this.running = false;
    this.stopping = true;
    this.stdoutBuffer = Buffer.alloc(0);
    this.lastDeliveredAtNs = 0;

    const compiler = this.compiler;
    this.compiler = null;
    if (compiler !== null && !compiler.killed) compiler.kill('SIGTERM');

    const proc = this.proc;
    this.proc = null;
    if (proc !== null && !proc.killed) proc.kill('SIGTERM');

    this.fallback?.stop();
    this.fallback = null;
  }

  setFps(fps: number): void {
    this.fps = clampFps(fps);
    this.lastDeliveredAtNs = 0;
    if (this.fallback !== null) {
      this.fallback.setFps(Math.min(this.fps, FALLBACK_MAX_FPS));
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  private startNative(): void {
    if (process.env.PYNG_DISABLE_NATIVE_CAPTURE === '1') {
      this.startFallback('disabled-by-env');
      return;
    }

    const paths = this.getHelperPaths();
    if (fs.existsSync(paths.executablePath)) {
      this.spawnHelper(paths.executablePath);
      return;
    }

    try {
      fs.mkdirSync(paths.cacheDir, { recursive: true });
      fs.writeFileSync(paths.sourcePath, SWIFT_SOURCE, 'utf8');
    } catch (err) {
      this.startFallback(`prepare-failed: ${String(err)}`);
      return;
    }

    const compiler = spawn('/usr/bin/xcrun', [
      'swiftc',
      '-parse-as-library',
      paths.sourcePath,
      '-O',
      '-framework',
      'ScreenCaptureKit',
      '-framework',
      'CoreMedia',
      '-framework',
      'CoreVideo',
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
      this.startFallback(`compile-spawn-failed: ${err.message}`);
    });

    compiler.on('exit', (code, signal) => {
      this.compiler = null;
      if (!this.running || this.stopping) return;
      if (code !== 0) {
        const detail = stderr.trim() || `code=${code ?? 'null'} signal=${signal ?? 'null'}`;
        this.startFallback(`compile-failed: ${detail}`);
        return;
      }
      try {
        fs.chmodSync(paths.executablePath, 0o755);
      } catch {
        // swiftc normally creates an executable file; chmod is only a backup.
      }
      this.spawnHelper(paths.executablePath);
    });
  }

  private spawnHelper(executablePath: string): void {
    if (!this.running || this.stopping) return;
    try {
      const proc = spawn(
        executablePath,
        [
          String(this.options.targetHeight ?? DEFAULT_TARGET_HEIGHT),
          String(this.fps),
          this.options.includeRgbBuffer ? '1' : '0',
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      this.proc = proc;

      proc.stdout?.on('data', (chunk: Buffer) => {
        this.handleStdout(chunk);
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8').trim();
        if (text.length > 0) this.log(`[capture] native ${text}`);
      });

      proc.on('error', (err) => {
        this.proc = null;
        this.startFallback(`spawn-failed: ${err.message}`);
      });

      proc.on('exit', (code, signal) => {
        this.proc = null;
        if (!this.running || this.stopping) return;
        const detail = `exited code=${code ?? 'null'} signal=${signal ?? 'null'}`;
        if (!this.emittedFrames) {
          this.startFallback(detail);
        } else {
          this.options.onError?.(new Error(`native capture ${detail}; falling back`));
          this.startFallback(detail);
        }
      });
    } catch (err) {
      this.startFallback(`spawn-threw: ${String(err)}`);
    }
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    if (this.stdoutBuffer.length > MAX_BUFFERED_BYTES) {
      this.stdoutBuffer = Buffer.alloc(0);
      this.startFallback('native stdout buffer overflow');
      return;
    }

    while (this.stdoutBuffer.length > 0) {
      const newline = this.stdoutBuffer.indexOf(10);
      if (newline < 0) return;

      const header = this.stdoutBuffer.subarray(0, newline).toString('utf8').trim();
      if (!header.startsWith('PYNG_FRAME ')) {
        this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
        continue;
      }

      const parsed = parseHeader(header);
      if (parsed === null) {
        this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
        continue;
      }

      const frameBytes = parsed.width * parsed.height;
      const payloadStart = newline + 1;
      const rgbBytes = parsed.rgbBytes ?? 0;
      const payloadEnd = payloadStart + frameBytes + rgbBytes;
      if (this.stdoutBuffer.length < payloadEnd) return;

      const payload = this.stdoutBuffer.subarray(payloadStart, payloadStart + frameBytes);
      const rgbPayload =
        rgbBytes > 0 ? this.stdoutBuffer.subarray(payloadStart + frameBytes, payloadEnd) : null;
      this.stdoutBuffer = this.stdoutBuffer.subarray(payloadEnd);
      if (!this.shouldDeliverFrame(parsed.capturedAtNs)) continue;

      const frameBuffer = Buffer.from(payload);
      const rgbBuffer = rgbPayload === null ? undefined : Buffer.from(rgbPayload);
      this.emittedFrames = true;

      const frame: GrayFrame = {
        buffer: frameBuffer,
        rgbBuffer,
        width: parsed.width,
        height: parsed.height,
        capturedAtNs: parsed.capturedAtNs,
        frameId: parsed.frameId,
        source: 'screencapturekit',
        droppedFrames: parsed.droppedFrames,
      };
      void Promise.resolve(this.options.onFrame(frame)).catch((err: unknown) => {
        this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
      });
    }
  }

  private shouldDeliverFrame(capturedAtNs: number): boolean {
    const intervalNs = 1_000_000_000 / Math.max(1, this.fps);
    if (this.lastDeliveredAtNs > 0 && capturedAtNs - this.lastDeliveredAtNs < intervalNs * 0.9) {
      return false;
    }
    this.lastDeliveredAtNs = capturedAtNs;
    return true;
  }

  private startFallback(reason: string): void {
    if (!this.running || this.stopping || this.fallback !== null) return;
    this.log(`[capture] native unavailable (${reason}); using Electron fallback`);
    const proc = this.proc;
    this.proc = null;
    if (proc !== null && !proc.killed) proc.kill('SIGTERM');
    this.fallback = this.options.fallbackFactory();
    this.fallback.setFps(Math.min(this.fps, FALLBACK_MAX_FPS));
    this.fallback.start();
  }

  private getHelperPaths(): HelperPaths {
    const hash = createHash('sha256').update(SWIFT_SOURCE).digest('hex').slice(0, 16);
    const cacheDir = path.join(os.tmpdir(), 'pyng-screen-capture');
    return {
      cacheDir,
      sourcePath: path.join(cacheDir, `screen-capture-${hash}.swift`),
      executablePath: path.join(cacheDir, `screen-capture-${hash}`),
    };
  }

  private log(message: string): void {
    (this.options.log ?? defaultLog)(message);
  }
}

function parseHeader(header: string): {
  capturedAtNs: number;
  width: number;
  height: number;
  frameId: number;
  droppedFrames: number;
  rgbBytes?: number;
} | null {
  const parts = header.split(/\s+/);
  if (parts.length !== 6 && parts.length !== 7) return null;
  const capturedAtNs = Number(parts[1]);
  const width = Number(parts[2]);
  const height = Number(parts[3]);
  const frameId = Number(parts[4]);
  const droppedFrames = Number(parts[5]);
  const rgbBytes = parts.length === 7 ? Number(parts[6]) : undefined;
  if (
    !Number.isFinite(capturedAtNs) ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    !Number.isFinite(frameId) ||
    !Number.isFinite(droppedFrames) ||
    (rgbBytes !== undefined && !Number.isInteger(rgbBytes))
  ) {
    return null;
  }
  if (width <= 0 || height <= 0 || width * height > MAX_BUFFERED_BYTES) return null;
  if (rgbBytes !== undefined && rgbBytes !== width * height * 3) return null;
  if (width * height + (rgbBytes ?? 0) > MAX_BUFFERED_BYTES) return null;
  return { capturedAtNs, width, height, frameId, droppedFrames, rgbBytes };
}

function clampFps(fps: number): number {
  if (!Number.isFinite(fps)) return 60;
  return Math.max(1, Math.min(60, Math.round(fps)));
}

function defaultLog(message: string): void {
  process.stderr.write(`${message}\n`);
}
