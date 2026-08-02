import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OncoPilot · 肿瘤住院安全工作台",
  description: "一个使用完全合成数据演示病例追溯、管床任务、医嘱复核与医疗AI评测的安全工作台。",
  openGraph: {
    title: "OncoPilot · 肿瘤住院安全工作台",
    description: "从患者时间线到安全复核与评测闭环的医疗 AI 作品原型。",
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
