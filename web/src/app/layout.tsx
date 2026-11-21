import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TaskRail Stream | Machine-Executed Per-Test Verification & Micro-Escrow on Monad",
  description:
    "Not manual approval, not LLM scoring. Live isolated sandbox runs 16 real tests per commit: each passing test streams micro-payout on Monad Testnet; any failure halts escrow instantly with 284ms refund.",
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#05080f",
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
      <body className="antialiased selection:bg-cyan-400/25 selection:text-cyan-100">
        {children}
      </body>
    </html>
  );
}
