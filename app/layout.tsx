import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://oncopilot-safety-workbench.lisao.chatgpt.site"),
  title: "OncoPilot · 肿瘤入院记录草稿助手",
  description: "先抽取带来源的结构化事实，再生成可编辑、待医生核对的肿瘤入院记录草稿包。",
  openGraph: {
    title: "OncoPilot · 肿瘤入院记录草稿助手",
    description: "单入口整理主诉、现病史、各项病史、专科查体和医生已明确的诊断与计划。",
    images: ["/og-admission-draft.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
