import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OncoPilot · 肿瘤病例整理助手",
  description: "粘贴合成资料，使用AI生成可核实的现病史、质控提醒与资料来源，再衔接简洁管床卡。",
  openGraph: {
    title: "OncoPilot · 肿瘤病例整理助手",
    description: "一条简单的医疗AI主线：资料整理、医生确认、管床衔接。",
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
