import JSZip from "jszip";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";

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

function runDemucs(inputPath: string, outputDir: string): Promise<void> {
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

export async function POST(request: Request) {
  let tempDirPath = "";

  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Please upload an audio file." }, { status: 400 });
    }

    tempDirPath = await mkdtemp(path.join(tmpdir(), "audio-stems-"));

    const safeInputBase = sanitizeFileStem(file.name || "input");
    const inputFileName = `${randomUUID()}-${safeInputBase}${path.extname(file.name || "") || ".wav"}`;
    const inputPath = path.join(tempDirPath, inputFileName);
    const outputDir = path.join(tempDirPath, "demucs-output");

    await writeFile(inputPath, Buffer.from(await file.arrayBuffer()));
    await runDemucs(inputPath, outputDir);

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
      return NextResponse.json(
        { error: "Stem extraction finished, but no requested stems were found." },
        { status: 500 },
      );
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

    const zipBytes = new Uint8Array(zipBuffer);
    const outputBaseName = sanitizeFileStem(file.name || "audio");
    const zipFileName = `${outputBaseName}-stems.zip`;

    return new NextResponse(zipBytes, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${zipFileName}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown error";
    const payload: { error: string; detail?: string } = {
      error: "Stem separation failed. Make sure Demucs is installed and the file is valid audio.",
    };

    if (process.env.NODE_ENV !== "production") {
      payload.detail = detail;
    }

    return NextResponse.json(payload, { status: 500 });
  } finally {
    if (tempDirPath) {
      try {
        await rm(tempDirPath, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors.
      }
    }
  }
}
