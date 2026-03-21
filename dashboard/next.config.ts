import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export", // 정적 빌드
  trailingSlash: true, // 정적 파일 경로 호환
  allowedDevOrigins: ["100.113.11.90"],
};

export default nextConfig;
