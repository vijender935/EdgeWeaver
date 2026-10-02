/**
 * Cloudflare MCP Server
 * Exposes the ai-images-pilot Worker API as MCP tools.
 *
 * Tools:
 *  - health          → GET /
 *  - list_images     → GET /images
 *  - search_images   → GET /search?q=
 *  - process_image   → POST /process
 *  - list_r2_objects → GET /r2
 *  - get_image       → base64 image (direct) when small, else public URL
 *
 * Deploy: npm run deploy
 * Connect clients to: https://cloudflare-mcp.<your-subdomain>.workers.dev/mcp
 */

import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export interface Env {
  /** Cloudflare Service Binding to the ai-images-pilot Worker. */
  AI_IMAGES: Fetcher;
}

const PUBLIC_IMAGE_BASE = "https://ai-images-serve.vijender935.workers.dev/image";

/** Max raw bytes for returning base64 image content (keeps MCP payload reasonable). */
const MAX_BASE64_BYTES = 280_000;

/**
 * Helper: call the upstream ai-images-pilot Worker through a Cloudflare
 * Service Binding. This removes the dependency on a public Worker URL.
 */
async function callWorker(
  worker: Fetcher,
  path: string,
  options: RequestInit = {}
): Promise<any> {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const request = new Request(
    `https://ai-images-pilot.internal${normalizedPath}`,
    {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    }
  );

  const res = await worker.fetch(request);

  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    throw new Error(
      `Worker responded ${res.status}: ${data?.error || text || res.statusText}`
    );
  }
  return data;
}

async function fetchImageBinary(
  worker: Fetcher,
  key: string
): Promise<{ bytes: Uint8Array; mimeType: string; size: number } | null> {
  const params = new URLSearchParams({ key });
  const request = new Request(
    `https://ai-images-pilot.internal/image?${params.toString()}`
  );
  const res = await worker.fetch(request);

  if (!res.ok) return null;

  const contentType =
    res.headers.get("Content-Type") || "application/octet-stream";
  const buffer = await res.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  return {
    bytes,
    mimeType: contentType.split(";")[0].trim(),
    size: bytes.length,
  };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "cloudflare-mcp",
    version: "1.3.0",
  });

  const worker = env.AI_IMAGES;

  server.registerTool(
    "health",
    {
      description:
        "Check health / status of the ai-images-pilot Worker and its bindings (AI, DB, R2, Vectorize).",
      inputSchema: {},
    },
    async () => {
      const data = await callWorker(worker, "/health");
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.registerTool(
    "list_images",
    {
      description:
        "List images from the D1 catalog. Supports limit, offset and optional status filter (pending|processing|ready|error).",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max number of images to return (default 20, max 100)"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Offset for pagination (default 0)"),
        status: z
          .enum(["pending", "processing", "ready", "error"])
          .optional()
          .describe("Filter by processing status"),
      },
    },
    async ({ limit, offset, status }) => {
      const params = new URLSearchParams();
      if (limit !== undefined) params.set("limit", String(limit));
      if (offset !== undefined) params.set("offset", String(offset));
      if (status) params.set("status", status);

      const qs = params.toString() ? `?${params.toString()}` : "";
      const data = await callWorker(worker, `/images${qs}`);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.registerTool(
    "search_images",
    {
      description:
        "Semantic search over the image catalog using Vectorize + D1 enrichment. Provide a natural language query.",
      inputSchema: {
        q: z.string().min(1).describe("Natural language search query"),
        topK: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Number of nearest neighbors to return (default 5, max 20)"),
      },
    },
    async ({ q, topK }) => {
      const params = new URLSearchParams({ q });
      if (topK !== undefined) params.set("topK", String(topK));

      const data = await callWorker(worker, `/search?${params.toString()}`);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.registerTool(
    "process_image",
    {
      description:
        "Process an image: describe it with Llama 3.2 Vision, embed the description, store in Vectorize + D1. Pass an R2 key or leave empty to auto-pick a pending image.",
      inputSchema: {
        r2_key: z
          .string()
          .optional()
          .describe(
            "R2 object key to process. If omitted, the worker picks a pending image."
          ),
        id: z.string().optional().describe("Existing D1 image id (optional)"),
      },
    },
    async ({ r2_key, id }) => {
      const body: Record<string, string> = {};
      if (r2_key) body.r2_key = r2_key;
      if (id) body.id = id;

      const data = await callWorker(worker, "/process", {
        method: "POST",
        body: JSON.stringify(body),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.registerTool(
    "get_image",
    {
      description:
        "Return image for direct preview. Small images (≤~280KB) are returned as MCP image content (base64) for inline display. Larger images return a public full-quality URL. Pass the exact R2 object key from search_images or list_r2_objects.",
      inputSchema: {
        key: z
          .string()
          .min(1)
          .describe("Exact R2 object key of the image"),
      },
    },
    async ({ key }) => {
      const image = await fetchImageBinary(worker, key);

      if (!image) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "Image not found", key }, null, 2),
            },
          ],
        };
      }

      // Prefer pure image content so clients can render direct preview
      if (image.size <= MAX_BASE64_BYTES) {
        return {
          content: [
            {
              type: "image",
              data: toBase64(image.bytes),
              mimeType: image.mimeType,
            },
          ],
        };
      }

      // Fallback for large images: public URL (full original quality)
      const url = `${PUBLIC_IMAGE_BASE}?key=${encodeURIComponent(key)}`;
      return {
        content: [
          {
            type: "text",
            text: url,
          },
          {
            type: "text",
            text: JSON.stringify(
              {
                key,
                url,
                mimeType: image.mimeType,
                size_bytes: image.size,
                note: "Image too large for base64; use URL for full quality",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "list_r2_objects",
    {
      description:
        "List raw objects currently stored in the ai-images R2 bucket (helper for discovering unprocessed images).",
      inputSchema: {},
    },
    async () => {
      const data = await callWorker(worker, "/r2");
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  return server;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Create a fresh server instance per request so tools close over the correct env
    return createMcpHandler(() => createServer(env))(request, env, ctx);
  },
};
