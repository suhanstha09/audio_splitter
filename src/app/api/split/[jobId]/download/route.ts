import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { NextResponse } from "next/server";
import { getSplitJob } from "../../jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SPLIT_WORKER_URL = process.env.SPLIT_WORKER_URL?.trim() || "";

function getWorkerEndpoint(relativePath: string): string {
  return `${SPLIT_WORKER_URL.replace(/\/+$/, "")}${relativePath}`;
}

function getServerlessRuntimeBlocker(): string | null {
  if (SPLIT_WORKER_URL) {
    return null;
  }

  const isVercel = process.env.VERCEL === "1" || process.env.VERCEL === "true";
  if (!isVercel) {
    return null;
  }

  return "Server-side stem separation cannot run directly on Vercel serverless functions. Configure SPLIT_WORKER_URL to a dedicated worker service.";
}

export async function GET(
  _request: Request,
  context: {
    params: Promise<{ jobId: string }>;
  },
) {
  const { jobId } = await context.params;

  if (SPLIT_WORKER_URL) {
    const upstream = await fetch(getWorkerEndpoint(`/api/split/${encodeURIComponent(jobId)}/download`), {
      method: "GET",
      cache: "no-store",
      headers: {
        accept: "application/zip,application/json",
      },
    });

    const bodyBytes = new Uint8Array(await upstream.arrayBuffer());
    const headers = new Headers(upstream.headers);
    headers.set("cache-control", "no-store");

    return new NextResponse(bodyBytes, {
      status: upstream.status,
      headers,
    });
  }

  const blocker = getServerlessRuntimeBlocker();
  if (blocker) {
    return NextResponse.json({ error: blocker }, { status: 503 });
  }

  const job = getSplitJob(jobId);

  if (!job) {
    return NextResponse.json({ error: "Split job was not found or has expired." }, { status: 404 });
  }

  if (job.status !== "completed") {
    return NextResponse.json({ error: "Split job is not completed yet." }, { status: 409 });
  }

  if (!job.zipPath) {
    return NextResponse.json({ error: "Split job has no zip file associated." }, { status: 409 });
  }

  if (!existsSync(job.zipPath)) {
    return NextResponse.json(
      { error: "ZIP file not found on disk. It may have been cleaned up." },
      { status: 410 },
    );
  }

  try {
    // Verify the file is readable and get its size
    const stats = await stat(job.zipPath);
    if (stats.size === 0) {
      return NextResponse.json({ error: "ZIP file is empty." }, { status: 409 });
    }

    const zipBytes = new Uint8Array(await readFile(job.zipPath));

    return new NextResponse(zipBytes, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${job.zipFileName ?? "stems.zip"}"`,
        "Cache-Control": "no-store",
        "Content-Length": zipBytes.length.toString(),
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to read ZIP file: ${detail}` },
      { status: 500 },
    );
  }
}