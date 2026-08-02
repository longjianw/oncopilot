import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OncoPilot · 肿瘤住院管床助手",
  description: "一个聚焦在区患者与分管患者的医疗 AI 作品原型，全部使用合成数据。",
  openGraph: {
    title: "OncoPilot · 肿瘤住院管床助手",
    description: "从在区患者到个人分管与今日待办的轻量医疗 AI 作品原型。",
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
