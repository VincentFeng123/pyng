import { parentPort, workerData } from 'node:worker_threads';
import { createWorker, PSM } from 'tesseract.js';

if (!parentPort) {
  throw new Error('worker.ts must be run as a worker_threads Worker, not a regular module');
}

const port = parentPort;

const CHAR_WHITELIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_';

const tesseract = await createWorker('eng', 1, { langPath: workerData.langPath });
await tesseract.setParameters({
  tessedit_pageseg_mode: PSM.SPARSE_TEXT,
  tessedit_char_whitelist: CHAR_WHITELIST,
});

port.postMessage({ type: 'ready' });

port.on('message', async ({ id, buffer }: { id: string; buffer: Buffer }) => {
  try {
    const result = await tesseract.recognize(buffer);
    port.postMessage({ id, text: result.data.text, confidence: result.data.confidence });
  } catch (err) {
    port.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
});
