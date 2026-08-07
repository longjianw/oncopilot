import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://oncopilot-safety-workbench.lisao.chatgpt.site"),
  title: "OncoPilot · 肿瘤入院记录草稿助手",
  description: "资料再少也先生成安全骨架，通过选择、填空和AI重新合成补全肿瘤入院记录草稿。",
  openGraph: {
    title: "OncoPilot · 肿瘤入院记录草稿助手",
    description: "把从零默写改成选择填空后微调：已知事实、疾病相关候选项、AI重新合成和可编辑入院记录草稿。",
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
