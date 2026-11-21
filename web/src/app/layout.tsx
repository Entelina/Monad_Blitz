import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TaskRail Stream | Live Per-Test Verification & Micro-Escrow on Monad",
  description:
    "Streaming per-test-case code verification, atomic micro-payouts, instant circuit breaker refunds, and same-runHash dispute checks on Monad Testnet.",
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#0b0b12",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <head>
        <meta name="color-scheme" content="dark" />
      </head>
      <body className="antialiased selection:bg-violet-500/30 selection:text-violet-100">
        {children}
      </body>
    </html>
  );
}
