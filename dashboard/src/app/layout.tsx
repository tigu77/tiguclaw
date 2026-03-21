import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "tiguclaw 대시보드",
  description: "tiguclaw 에이전트 군단 실시간 모니터링",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body
        className={`${geistMono.variable} font-mono antialiased`}
        style={{ background: "#0a0a0a", color: "#ededed", minHeight: "100vh" }}
      >
        {children}
      </body>
    </html>
  );
}
