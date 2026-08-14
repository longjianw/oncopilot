/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  ARK_CODING_API_KEY?: string;
  ARK_CODING_MODEL?: string;
  ARK_REFERENCE_MODEL?: string;
  ARK_CODING_BASE_URL?: string;
  ARK_VISION_API_KEY?: string;
  ARK_VISION_MODEL?: string;
  ARK_VISION_BASE_URL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_EVAL_MODEL?: string;
  OPENAI_BASE_URL?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env | undefined, ctx: ExecutionContext): Promise<Response> {
    const bindings = env || ({} as Env);
    if (bindings.ARK_CODING_API_KEY) process.env.ARK_CODING_API_KEY = bindings.ARK_CODING_API_KEY;
    if (bindings.ARK_CODING_MODEL) process.env.ARK_CODING_MODEL = bindings.ARK_CODING_MODEL;
    if (bindings.ARK_REFERENCE_MODEL) process.env.ARK_REFERENCE_MODEL = bindings.ARK_REFERENCE_MODEL;
    if (bindings.ARK_CODING_BASE_URL) process.env.ARK_CODING_BASE_URL = bindings.ARK_CODING_BASE_URL;
    if (bindings.ARK_VISION_API_KEY) process.env.ARK_VISION_API_KEY = bindings.ARK_VISION_API_KEY;
    if (bindings.ARK_VISION_MODEL) process.env.ARK_VISION_MODEL = bindings.ARK_VISION_MODEL;
    if (bindings.ARK_VISION_BASE_URL) process.env.ARK_VISION_BASE_URL = bindings.ARK_VISION_BASE_URL;
    if (bindings.OPENAI_API_KEY) process.env.OPENAI_API_KEY = bindings.OPENAI_API_KEY;
    if (bindings.OPENAI_EVAL_MODEL) process.env.OPENAI_EVAL_MODEL = bindings.OPENAI_EVAL_MODEL;
    if (bindings.OPENAI_BASE_URL) process.env.OPENAI_BASE_URL = bindings.OPENAI_BASE_URL;
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => bindings.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await bindings.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, bindings, ctx);
  },
};

export default worker;
