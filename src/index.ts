#!/usr/bin/env node
/**
 * Local stdio bridge to the Frantic MCP server.
 *
 * Frantic runs as a remote Streamable HTTP server. Clients that speak remote MCP should
 * connect to it directly and skip this package entirely. This exists for the clients that
 * only support stdio.
 *
 * Tool definitions are read from the live server at startup rather than restated here, so
 * this bridge cannot drift from the venue: a tool added, renamed, or re-described upstream
 * appears here on the next launch with no release of this package.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_ENDPOINT = "https://api.gofrantic.com/mcp";
const BRIDGE_VERSION = "0.1.0";

// stdout carries the protocol, so every diagnostic goes to stderr.
const note = (message: string) => process.stderr.write(`[frantic-mcp] ${message}\n`);

async function main(): Promise<void> {
  const endpoint = process.env.FRANTIC_MCP_URL ?? DEFAULT_ENDPOINT;

  const upstream = new Client(
    { name: "frantic-mcp-bridge", version: BRIDGE_VERSION },
    { capabilities: {} },
  );
  await upstream.connect(new StreamableHTTPClientTransport(new URL(endpoint)));

  // Present the venue's own identity and instructions to the local client. Anything the
  // upstream handshake does not carry falls back to a plain local default.
  const identity = upstream.getServerVersion();
  const server = new Server(
    {
      name: identity?.name ?? "frantic",
      version: identity?.version ?? BRIDGE_VERSION,
      ...(identity?.title ? { title: identity.title } : {}),
    },
    {
      capabilities: { tools: {} },
      ...(upstream.getInstructions() ? { instructions: upstream.getInstructions() } : {}),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (request): Promise<ListToolsResult> =>
    upstream.listTools(request.params ?? {}));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> =>
    upstream.callTool(request.params) as Promise<CallToolResult>);

  const shutdown = (reason: string, code: number) => {
    note(reason);
    void Promise.allSettled([server.close(), upstream.close()]).finally(() => process.exit(code));
  };

  // A dropped upstream connection makes every later call fail in a way the client cannot
  // act on, so end the process and let the client's own restart policy handle it.
  upstream.onclose = () => shutdown("upstream connection closed", 1);

  // In a container this process is PID 1, and the kernel applies no default action to
  // signals PID 1 has not handled. Without these, SIGTERM is silently discarded: `docker
  // stop` burns its whole grace period before SIGKILL, and anything bounding the process
  // with a plain SIGTERM waits forever.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => shutdown(`received ${signal}`, 0));
  }

  await server.connect(new StdioServerTransport());
  note(`bridging ${endpoint}`);
}

main().catch((error: unknown) => {
  note(`failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
