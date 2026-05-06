import type { NextConfig } from "next";

const nextConfig = {
  output: 'export',   // ← Tauri needs static export, not Next.js server
  images: { unoptimized: true },
}

export default nextConfig;
