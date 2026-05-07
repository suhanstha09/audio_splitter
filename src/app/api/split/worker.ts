const SPLIT_WORKER_URL = process.env.SPLIT_WORKER_URL?.trim() || "";

export const SPLIT_RUNTIME_BLOCK_MESSAGE =
  "Server-side stem separation cannot run directly on Vercel serverless functions (requires Python Demucs + long-running process + persistent job state). Configure SPLIT_WORKER_URL to a dedicated Node/Python worker service.";

export function hasSplitWorker(): boolean {
  return SPLIT_WORKER_URL.length > 0;
}

export function getWorkerEndpoint(relativePath: string): string {
  return `${SPLIT_WORKER_URL.replace(/\/+$/, "")}${relativePath}`;
}

export function getServerlessRuntimeBlocker(
  message: string = SPLIT_RUNTIME_BLOCK_MESSAGE,
): string | null {
  if (hasSplitWorker()) {
    return null;
  }

  const isVercel = process.env.VERCEL === "1" || process.env.VERCEL === "true";
  if (!isVercel) {
    return null;
  }

  return message;
}
