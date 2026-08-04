import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OncoPilot · 肿瘤病史整理助手",
  description: "粘贴患者资料，生成可核实的现病史初稿，并提示还需要向患者补问什么。",
  openGraph: {
    title: "OncoPilot · 肿瘤病史整理助手",
    description: "一条简单的医疗AI主线：整理现病史，并提醒还要问什么。",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
