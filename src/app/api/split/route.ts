import JSZip from "jszip";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
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

const REQUIRED_STEMS = ["bass", "drums", "guitar", "vocals"] as const;
const DEMUCS_MODEL = "htdemucs_6s";

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

async function processSplitJob(jobId: string, file: File): Promise<void> {
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

    for (const stem of REQUIRED_STEMS) {
      const stemFileName = `${stem}.mp3`;
      const stemPath = path.join(stemDir, stemFileName);

      if (!existsSync(stemPath)) {
        continue;
      }

      availableStems.push(stem);
      zip.file(stemFileName, await readFile(stemPath));
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

    const outputBaseName = sanitizeFileStem(file.name || "audio");
    const zipFileName = `${outputBaseName}-stems.zip`;
    const zipPath = path.join(tempDirPath, zipFileName);

    await writeFile(zipPath, zipBuffer);
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
  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Please upload an audio file." }, { status: 400 });
  }

  const job = createSplitJob(randomUUID(), file.name || "audio");
  void processSplitJob(job.id, file);

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
