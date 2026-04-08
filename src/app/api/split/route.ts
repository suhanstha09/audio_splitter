import JSZip from "jszip";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import ffmpegPath from "ffmpeg-static";
import {
  createSplitJob,
  getSplitJob,
  markSplitJobCompleted,
  markSplitJobFailed,
  setSplitJobProgress,
  updateSplitJob,
} from "./jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REQUIRED_STEMS = ["bass", "drums", "guitar", "piano", "vocals", "other"] as const;
const DEMUCS_MODEL = "htdemucs_6s";

const SPLIT_WORKER_URL = process.env.SPLIT_WORKER_URL?.trim() || "";

type SplitOptions = {
  splitGuitar: boolean;
};

function getWorkerEndpoint(relativePath: string): string {
  return `${SPLIT_WORKER_URL.replace(/\/+$/, "")}${relativePath}`;
}

async function proxySplitRequest(request: Request, relativePath: string): Promise<NextResponse> {
  const upstream = await fetch(getWorkerEndpoint(relativePath), {
    method: request.method,
    headers: {
      accept: request.headers.get("accept") ?? "application/json",
    },
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
    cache: "no-store",
  });

  const bodyBytes = new Uint8Array(await upstream.arrayBuffer());
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.set("cache-control", "no-store");

  return new NextResponse(bodyBytes, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

function getServerlessRuntimeBlocker(): string | null {
  if (SPLIT_WORKER_URL) {
    return null;
  }

  const isVercel = process.env.VERCEL === "1" || process.env.VERCEL === "true";
  if (!isVercel) {
    return null;
  }

  return "Server-side stem separation cannot run directly on Vercel serverless functions (requires Python Demucs + long-running process + persistent job state). Configure SPLIT_WORKER_URL to a dedicated Node/Python worker service.";
}

function sanitizeFileStem(fileName: string): string {
  const stem = path.parse(fileName).name.trim();
  const cleaned = stem.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "audio";
}

function resolvePythonBinary(): string {
  const configured = process.env.DEMUCS_PYTHON;
  if (configured && existsSync(configured)) {
    return configured;
  }

  const localVenvPython = path.join(process.cwd(), ".venv", "bin", "python");
  if (existsSync(localVenvPython)) {
    return localVenvPython;
  }

  return "python3";
}

function runDemucs(
  inputPath: string,
  outputDir: string,
  onProgress: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const pythonBinary = resolvePythonBinary();
    const args = [
      "-m",
      "demucs.separate",
      "-n",
      DEMUCS_MODEL,
      "--mp3",
      "--mp3-bitrate",
      "192",
      "-o",
      outputDir,
      inputPath,
    ];

    const proc = spawn(pythonBinary, args);
    let stderr = "";

    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;

      const progressMatches = text.matchAll(/(\d{1,3})%\|/g);
      for (const match of progressMatches) {
        const value = Number(match[1]);
        if (Number.isFinite(value)) {
          onProgress(Math.max(0, Math.min(100, value)));
        }
      }
    });

    proc.on("error", (error) => {
      reject(error);
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Demucs failed with code ${code}: ${stderr || "No stderr output"}`));
    });
  });
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpegBinary = ffmpegPath
      ? ffmpegPath.replace(/^\/ROOT\//, `${process.cwd()}/`)
      : "ffmpeg";
    const proc = spawn(ffmpegBinary, args);
    let stderr = "";

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (error) => {
      reject(error);
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`ffmpeg failed with code ${code}: ${stderr || "No stderr output"}`));
    });
  });
}

async function splitGuitarStemExperimental(stemDir: string): Promise<string[]> {
  const guitarPath = path.join(stemDir, "guitar.mp3");
  if (!existsSync(guitarPath)) {
    return [];
  }

  const rhythmPath = path.join(stemDir, "rhythm_guitar.mp3");
  const leadPath = path.join(stemDir, "lead_guitar.mp3");

  // Experimental heuristic split: low-mid power -> rhythm, mid-high presence -> lead.
  // Rhythm: 80Hz-1400Hz with slight compression to thicken low end
  await runFfmpeg([
    "-y",
    "-i",
    guitarPath,
    "-af",
    "highpass=f=90,lowpass=f=1600,acompressor=threshold=-18dB:ratio=2.2:attack=25:release=220",
    "-codec:a",
    "libmp3lame",
    "-b:a",
    "192k",
    rhythmPath,
  ]);

  // Lead: 1200Hz-12000Hz with mid/high presence boost to brighten and separate
  await runFfmpeg([
    "-y",
    "-i",
    guitarPath,
    "-af",
    "highpass=f=1300,acompressor=threshold=-20dB:ratio=2.6:attack=18:release=180,volume=1.15",
    "-codec:a",
    "libmp3lame",
    "-b:a",
    "192k",
    leadPath,
  ]);

  const generated: string[] = [];
  if (existsSync(rhythmPath)) {
    generated.push("rhythm_guitar");
  }
  if (existsSync(leadPath)) {
    generated.push("lead_guitar");
  }

  return generated;
}

async function resolveStemDirectory(baseOutputDir: string, inputName: string): Promise<string> {
  const expected = path.join(baseOutputDir, DEMUCS_MODEL, inputName);
  if (existsSync(expected)) {
    return expected;
  }

  const modelDir = path.join(baseOutputDir, DEMUCS_MODEL);
  const folders = await readdir(modelDir, { withFileTypes: true });
  const firstTrackDir = folders.find((entry) => entry.isDirectory());

  if (!firstTrackDir) {
    throw new Error("Demucs did not produce any track directory.");
  }

  return path.join(modelDir, firstTrackDir.name);
}

async function processSplitJob(jobId: string, file: File, options: SplitOptions): Promise<void> {
  const tempDirPath = await mkdtemp(path.join(tmpdir(), "audio-stems-"));

  updateSplitJob(jobId, {
    status: "processing",
    tempDirPath,
    progress: 3,
    message: "Preparing audio for separation.",
  });

  try {
    const safeInputBase = sanitizeFileStem(file.name || "input");
    const inputFileName = `${randomUUID()}-${safeInputBase}${path.extname(file.name || "") || ".wav"}`;
    const inputPath = path.join(tempDirPath, inputFileName);
    const outputDir = path.join(tempDirPath, "demucs-output");

    setSplitJobProgress(jobId, 8, "Uploading source audio to the engine.");
    await writeFile(inputPath, Buffer.from(await file.arrayBuffer()));

    setSplitJobProgress(jobId, 12, "Demucs is separating stems.");
    await runDemucs(inputPath, outputDir, (demucsPercent) => {
      const scaledPercent = 12 + demucsPercent * 0.72;
      setSplitJobProgress(jobId, scaledPercent, `Demucs separation ${demucsPercent}% complete.`);
    });

    setSplitJobProgress(jobId, 87, "Collecting generated stems.");

    const stemDir = await resolveStemDirectory(outputDir, path.parse(inputFileName).name);
    const zip = new JSZip();
    const availableStems: string[] = [];
    let generatedGuitarStems: string[] = [];

    if (options.splitGuitar) {
      setSplitJobProgress(jobId, 91, "Experimental guitar split in progress.");
      try {
        generatedGuitarStems = await splitGuitarStemExperimental(stemDir);
      } catch {
        // Keep the main separation successful even if optional guitar sub-split fails.
        generatedGuitarStems = [];
      }
    }

    for (const stem of REQUIRED_STEMS) {
      // Skip "guitar" stem if we're doing experimental guitar split
      if (options.splitGuitar && stem === "guitar") {
        continue;
      }

      const stemFileName = `${stem}.mp3`;
      const stemPath = path.join(stemDir, stemFileName);

      if (!existsSync(stemPath)) {
        continue;
      }

      availableStems.push(stem);
      zip.file(stemFileName, await readFile(stemPath));
    }

    for (const extraStem of generatedGuitarStems) {
      const extraFileName = `${extraStem}.mp3`;
      const extraPath = path.join(stemDir, extraFileName);

      if (!existsSync(extraPath)) {
        continue;
      }

      availableStems.push(extraStem);
      zip.file(extraFileName, await readFile(extraPath));
    }

    if (availableStems.length === 0) {
      throw new Error("Stem extraction finished, but no requested stems were found.");
    }

    zip.file(
      "manifest.json",
      JSON.stringify(
        {
          originalFileName: file.name,
          model: DEMUCS_MODEL,
          stemsRequested: [...REQUIRED_STEMS],
          experimentalGuitarSplit: options.splitGuitar,
          stemsIncluded: availableStems,
        },
        null,
        2,
      ),
    );

    const zipBuffer = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });

    if (!zipBuffer || zipBuffer.length === 0) {
      throw new Error("ZIP generation produced an empty buffer.");
    }

    const outputBaseName = sanitizeFileStem(file.name || "audio");
    const zipFileName = `${outputBaseName}-stems.zip`;
    const zipPath = path.join(tempDirPath, zipFileName);

    await writeFile(zipPath, zipBuffer);

    // Verify the file was written correctly
    if (!existsSync(zipPath)) {
      throw new Error("ZIP file was not written to disk successfully.");
    }

    markSplitJobCompleted(jobId, {
      zipPath,
      zipFileName,
      message: `Separation complete: ${availableStems.join(", ")} stems ready for download.`,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown error";
    markSplitJobFailed(
      jobId,
      `Stem separation failed. Make sure Demucs is installed and the file is valid audio. ${detail}`,
    );
  }
}

export async function POST(request: Request) {
  if (SPLIT_WORKER_URL) {
    return proxySplitRequest(request, "/api/split");
  }

  const blocker = getServerlessRuntimeBlocker();
  if (blocker) {
    return NextResponse.json(
      {
        error: blocker,
        detail:
          "Deploy the split worker on a VM/container platform (Railway, Render, Fly.io, ECS, etc.), then set SPLIT_WORKER_URL in Vercel to that worker base URL.",
      },
      { status: 503 },
    );
  }

  const formData = await request.formData();
  const file = formData.get("file");
  const splitGuitar = formData.get("splitGuitar") === "true";

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Please upload an audio file." }, { status: 400 });
  }

  const job = createSplitJob(randomUUID(), file.name || "audio");
  void processSplitJob(job.id, file, { splitGuitar });

  return NextResponse.json(
    {
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      message: job.message,
    },
    { status: 202 },
  );
}

export async function GET(request: Request) {
  if (SPLIT_WORKER_URL) {
    const { search } = new URL(request.url);
    return proxySplitRequest(request, `/api/split${search}`);
  }

  const { searchParams } = new URL(request.url);
  const jobId = searchParams.get("jobId")?.trim();

  if (!jobId) {
    return NextResponse.json({ error: "Missing required query parameter: jobId" }, { status: 400 });
  }

  const job = getSplitJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "Split job was not found or has expired." }, { status: 404 });
  }

  return NextResponse.json({
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    error: job.error,
    fileName: job.zipFileName,
    downloadUrl: job.status === "completed" ? `/api/split/${job.id}/download` : null,
  });
}
