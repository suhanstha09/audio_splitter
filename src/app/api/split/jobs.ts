import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";

export type SplitJobState = "queued" | "processing" | "completed" | "failed";

export type SplitJob = {
  id: string;
  status: SplitJobState;
  progress: number;
  message: string;
  originalFileName: string;
  createdAt: number;
  updatedAt: number;
  tempDirPath?: string;
  zipPath?: string;
  zipFileName?: string;
  error?: string;
};

const jobs = new Map<string, SplitJob>();
const JOB_TTL_MS = 30 * 60 * 1000;

function withTimestamp(update: Partial<SplitJob>): Partial<SplitJob> {
  return {
    ...update,
    updatedAt: Date.now(),
  };
}

export function createSplitJob(id: string, originalFileName: string): SplitJob {
  cleanupExpiredJobs();

  const job: SplitJob = {
    id,
    status: "queued",
    progress: 0,
    message: "Queued for separation.",
    originalFileName,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  jobs.set(id, job);
  return job;
}

export function getSplitJob(id: string): SplitJob | undefined {
  cleanupExpiredJobs();
  return jobs.get(id);
}

export function updateSplitJob(id: string, update: Partial<SplitJob>): SplitJob | undefined {
  const current = jobs.get(id);

  if (!current) {
    return undefined;
  }

  const nextJob: SplitJob = {
    ...current,
    ...withTimestamp(update),
  };

  jobs.set(id, nextJob);
  return nextJob;
}

export function setSplitJobProgress(id: string, progress: number, message?: string): SplitJob | undefined {
  return updateSplitJob(id, {
    progress: Math.max(0, Math.min(100, Math.round(progress))),
    ...(message ? { message } : {}),
  });
}

export function markSplitJobCompleted(
  id: string,
  payload: { zipPath: string; zipFileName: string; message?: string },
): SplitJob | undefined {
  return updateSplitJob(id, {
    status: "completed",
    progress: 100,
    zipPath: payload.zipPath,
    zipFileName: payload.zipFileName,
    message: payload.message ?? "Separation complete.",
    error: undefined,
  });
}

export function markSplitJobFailed(id: string, error: string): SplitJob | undefined {
  return updateSplitJob(id, {
    status: "failed",
    error,
    message: error,
  });
}

export async function cleanupExpiredJobs(): Promise<void> {
  const now = Date.now();

  for (const [jobId, job] of jobs.entries()) {
    if (now - job.updatedAt <= JOB_TTL_MS) {
      continue;
    }

    jobs.delete(jobId);

    if (job.tempDirPath && existsSync(job.tempDirPath)) {
      try {
        await rm(job.tempDirPath, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors for expired jobs.
      }
    }
  }
}