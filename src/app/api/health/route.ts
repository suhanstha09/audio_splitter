import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    runtime: "nodejs",
    timestamp: new Date().toISOString(),
  });
}