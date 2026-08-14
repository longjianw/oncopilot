import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://oncopilot.rtflowai.top"),
  title: "OncoPilot V0.12.1 · 肿瘤入院记录草稿助手",
  description: "先建立临床事件账本，再分阶段生成病史、诊断与下一步参考，并用独立测评实验室持续比较质量。",
  openGraph: {
    title: "OncoPilot V0.12.1 · 肿瘤入院记录草稿助手",
    description: "临床事件账本、分阶段模型生成、盲化测评与内部产品评审，让长病程肿瘤入院记录持续迭代。",
    images: ["/og-choice-fill-chat.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
