import { createServer } from "node:http";
import path from "node:path";
import express from "express";
import rateLimit from "express-rate-limit";

import {
  StreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import {
  createMajorAdvisorServer,
} from "./src/aaupServer.js";

import {
  loadAdmissionSystems,
  loadMajors,
} from "./src/utils.js";

/*
  Server configuration
*/

const PORT =
  Number(process.env.PORT ?? 8787);

const MCP_PATH = "/mcp";
const CHAT_PATH = "/api/chat";
const HEALTH_PATH = "/healthz";
const READY_PATH = "/readyz";

const CHAT_PAGE_PATH =
  path.resolve("public/index.html");

const OPENAI_API_URL =
  "https://api.openai.com/v1/responses";

const OPENAI_MODEL =
  process.env.OPENAI_MODEL?.trim() ||
  "gpt-6-luna";

const MCP_METHODS = new Set([
  "POST",
  "GET",
  "DELETE",
]);

if (
  !Number.isInteger(PORT) ||
  PORT < 1 ||
  PORT > 65535
) {
  throw new Error(
    "PORT must be a valid integer between 1 and 65535."
  );
}

/*
  Load and validate the admissions
  data before accepting traffic.

  The validation added in Step 3A
  will stop startup if the data is
  malformed.
*/

const majors = loadMajors();

const admissionSystems =
  loadAdmissionSystems();

/*
  Create Express application
*/

const app = express();

app.disable("x-powered-by");

/*
  Reverse-proxy configuration

  Set TRUST_PROXY only when the
  production server is behind a
  trusted reverse proxy.

  Examples:

  TRUST_PROXY=1
  TRUST_PROXY=loopback
  TRUST_PROXY=127.0.0.1
  TRUST_PROXY=loopback,10.0.0.0/8

  Never use TRUST_PROXY=true.
*/

const trustProxyValue =
  process.env.TRUST_PROXY?.trim();

if (trustProxyValue) {
  if (
    trustProxyValue.toLowerCase() ===
    "true"
  ) {
    throw new Error(
      "Do not use TRUST_PROXY=true. " +
      "Use an exact proxy count, IP, " +
      "subnet, or trusted proxy name."
    );
  }

  const parsedTrustProxy =
    /^\d+$/.test(trustProxyValue)
      ? Number(trustProxyValue)
      : trustProxyValue
          .split(",")
          .map((value) =>
            value.trim()
          )
          .filter(Boolean);

  app.set(
    "trust proxy",
    parsedTrustProxy
  );
}

/*
  Readiness state
*/

let ready = false;
let shuttingDown = false;

/*
  MCP rate limiting
*/

const mcpLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 200,

  standardHeaders: true,
  legacyHeaders: false,

  skip: (req) =>
    req.method === "OPTIONS",

  message:
    "Too many requests. Please try again shortly.",
});

app.use(
  MCP_PATH,
  mcpLimiter
);

/*
  Website chat rate limiting
*/

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,

  standardHeaders: true,
  legacyHeaders: false,

  message: {
    error:
      "Too many chat requests. Please try again shortly.",
  },
});

/*
  Handle CORS preflight requests
  for the MCP endpoint.
*/

app.use((req, res, next) => {
  if (
    req.method === "OPTIONS" &&
    req.path === MCP_PATH
  ) {
    res.setHeader(
      "Access-Control-Allow-Origin",
      "*"
    );

    res.setHeader(
      "Access-Control-Allow-Methods",
      "POST, GET, DELETE, OPTIONS"
    );

    res.setHeader(
      "Access-Control-Allow-Headers",
      "content-type, mcp-session-id"
    );

    res.setHeader(
      "Access-Control-Expose-Headers",
      "Mcp-Session-Id"
    );

    res
      .status(204)
      .end();

    return;
  }

  next();
});

/*
  Major Advisor website
*/

app.get("/", (req, res) => {
  res.sendFile(CHAT_PAGE_PATH);
});

/*
  Liveness check

  This confirms that the Node
  process is running and has not
  started shutting down.
*/

app.get(
  HEALTH_PATH,

  (req, res) => {
    const healthy =
      !shuttingDown;

    res
      .status(
        healthy ? 200 : 503
      )
      .json({
        status: healthy
          ? "ok"
          : "shutting_down",
      });
  }
);

/*
  Readiness check

  This confirms that the server
  successfully loaded validated
  admissions data and is ready
  to receive requests.
*/

app.get(
  READY_PATH,

  (req, res) => {
    const isReady =
      ready && !shuttingDown;

    res
      .status(
        isReady ? 200 : 503
      )
      .json({
        status: isReady
          ? "ready"
          : "not_ready",

        academicYear:
          admissionSystems
            .academicYear,

        programsLoaded:
          majors.length,
      });
  }
);

/*
  Handle one MCP request
*/

async function handleMcpRequest(
  req,
  res
) {
  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Access-Control-Expose-Headers",
    "Mcp-Session-Id"
  );

  const mcpServer =
    createMajorAdvisorServer();

  const transport =
    new StreamableHTTPServerTransport({
      sessionIdGenerator:
        undefined,

      enableJsonResponse:
        true,
    });

  /*
    Clean up MCP resources after
    the response connection closes.
  */

  res.once("close", () => {
    void transport.close();
    void mcpServer.close();
  });

  await mcpServer.connect(
    transport
  );

  await transport.handleRequest(
    req,
    res
  );
}

/*
  Major Advisor MCP endpoint
*/

app.all(
  MCP_PATH,

  async (req, res) => {
    const method =
      req.method ?? "";

    if (
      !MCP_METHODS.has(method)
    ) {
      res.setHeader(
        "Allow",
        "POST, GET, DELETE, OPTIONS"
      );

      res
        .status(405)
        .type("text/plain")
        .send(
          "Method Not Allowed"
        );

      return;
    }

    try {
      await handleMcpRequest(
        req,
        res
      );
    } catch (error) {
      console.error(
        "Error handling Major Advisor MCP request:",
        error
      );

      if (!res.headersSent) {
        res
          .status(500)
          .type("text/plain")
          .send(
            "Internal server error"
          );

        return;
      }

      if (!res.writableEnded) {
        res.end();
      }
    }
  }
);

/*
  Temporary website chat

  The browser sends a small in-memory
  transcript. Nothing is stored by this
  application between requests.
*/

function normalizeChatHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .slice(-12)
    .map((item) => ({
      role:
        item?.role === "assistant"
          ? "Assistant"
          : "User",
      content:
        typeof item?.content === "string"
          ? item.content.trim().slice(0, 4000)
          : "",
    }))
    .filter((item) => item.content);
}

function buildChatInput(history, message) {
  const transcript = history
    .map(
      (item) =>
        `${item.role}: ${item.content}`
    )
    .join("\n\n");

  if (!transcript) {
    return message;
  }

  return [
    "Conversation so far:",
    transcript,
    "",
    `User: ${message}`,
  ].join("\n");
}

function extractResponseText(response) {
  const textParts = [];

  for (const item of response?.output ?? []) {
    if (item?.type !== "message") {
      continue;
    }

    for (const content of item.content ?? []) {
      if (
        content?.type === "output_text" &&
        typeof content.text === "string"
      ) {
        textParts.push(content.text);
      }

      if (
        content?.type === "refusal" &&
        typeof content.refusal === "string"
      ) {
        textParts.push(content.refusal);
      }
    }
  }

  return textParts.join("\n\n").trim();
}

function getPublicMcpUrl(req) {
  const configuredUrl =
    process.env.MCP_SERVER_URL?.trim();

  if (configuredUrl) {
    return configuredUrl;
  }

  return `${req.protocol}://${req.get("host")}${MCP_PATH}`;
}

app.post(
  CHAT_PATH,
  chatLimiter,
  express.json({ limit: "32kb" }),

  async (req, res) => {
    const apiKey =
      process.env.OPENAI_API_KEY?.trim();

    if (!apiKey) {
      res.status(503).json({
        error:
          "AI chat is not configured yet.",
      });
      return;
    }

    const message =
      typeof req.body?.message === "string"
        ? req.body.message.trim()
        : "";

    if (!message) {
      res.status(400).json({
        error: "Message is required.",
      });
      return;
    }

    if (message.length > 4000) {
      res.status(400).json({
        error:
          "Message is too long. Please keep it under 4,000 characters.",
      });
      return;
    }

    const history =
      normalizeChatHistory(
        req.body?.history
      );

    const mcpServerUrl =
      getPublicMcpUrl(req);

    try {
      const openaiResponse =
        await fetch(OPENAI_API_URL, {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
            Authorization:
              `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: OPENAI_MODEL,
            store: false,
            reasoning: {
              effort: "low",
            },
            instructions: [
              "You are the AAUP Major Advisor, an AI-assisted academic-program exploration assistant for Arab American University (AAUP).",
              "Answer in the user's language; support both English and Arabic.",
              "For questions about AAUP bachelor-program eligibility, program matching, majors, campuses, admission averages, or personalized recommendations, use the create_major_match_report tool whenever the required information is available.",
              "If required information is missing, ask only for the missing information before calling the tool.",
              "Treat the AAUP tool result as authoritative for the structured report. Do not invent admission rules, program requirements, tuition figures, or eligibility decisions.",
              "Never claim that the Advisor guarantees admission, confirms certificate equivalency, submits an application, reserves a seat, determines a scholarship, or accesses private student records.",
              "Final eligibility must be confirmed by the AAUP Deanship of Admission and Registration.",
              "Keep answers concise, clear, and student-friendly.",
            ].join("\n"),
            tools: [
              {
                type: "mcp",
                server_label:
                  "aaup_major_advisor",
                server_description:
                  "AAUP's read-only Major Advisor for preliminary bachelor-program eligibility checks and program matching.",
                server_url:
                  mcpServerUrl,
                require_approval:
                  "never",
                allowed_tools: [
                  "create_major_match_report",
                ],
              },
            ],
            input:
              buildChatInput(
                history,
                message
              ),
            max_output_tokens: 2000,
          }),
          signal:
            AbortSignal.timeout(120000),
        });

      const responseBody =
        await openaiResponse.json();

      if (!openaiResponse.ok) {
        console.error(
          "OpenAI chat request failed:",
          openaiResponse.status,
          responseBody?.error?.message ??
            "Unknown OpenAI API error"
        );

        res.status(502).json({
          error:
            "The AI service is temporarily unavailable. Please try again.",
        });
        return;
      }

      const reply =
        extractResponseText(
          responseBody
        );

      if (!reply) {
        console.error(
          "OpenAI chat response did not contain text output."
        );

        res.status(502).json({
          error:
            "The AI service returned an empty response. Please try again.",
        });
        return;
      }

      res.status(200).json({
        reply,
      });
    } catch (error) {
      console.error(
        "Error handling website chat request:",
        error
      );

      res.status(502).json({
        error:
          "The AI service is temporarily unavailable. Please try again.",
      });
    }
  }
);

/*
  OpenAI domain-verification route
*/

app.get(
  "/.well-known/openai-apps-challenge",

  (req, res) => {
    const token =
      process.env
        .OPENAI_APPS_CHALLENGE;

    if (!token) {
      res
        .status(404)
        .type("text/plain")
        .send("Not Found");

      return;
    }

    res
      .status(200)
      .type("text/plain")
      .send(token);
  }
);

/*
  Documents
*/

const DOCS_DIR = path.resolve("public/docs");

app.get("/privacy", (req, res) => {
  res.sendFile(path.join(DOCS_DIR, "privacy.pdf"), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": "inline"
    }
  });
});

app.get("/terms", (req, res) => {
  res.sendFile(path.join(DOCS_DIR, "terms.pdf"), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": "inline"
    }
  });
});

app.get("/support", (req, res) => {
  res.sendFile(path.join(DOCS_DIR, "support.pdf"), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": "inline"
    }
  });
});

/*
  Return 404 for unmatched routes
*/

app.use((req, res) => {
  res
    .status(404)
    .type("text/plain")
    .send("Not Found");
});

/*
  Create HTTP server
*/

const httpServer =
  createServer(app);

/*
  HTTP timeout settings

  These can be overridden using
  production environment variables.
*/

httpServer.requestTimeout =
  Number(
    process.env
      .REQUEST_TIMEOUT_MS ??
    120000
  );

httpServer.headersTimeout =
  Number(
    process.env
      .HEADERS_TIMEOUT_MS ??
    65000
  );

httpServer.keepAliveTimeout =
  Number(
    process.env
      .KEEP_ALIVE_TIMEOUT_MS ??
    60000
  );

/*
  Begin accepting traffic
*/

httpServer.listen(
  PORT,
  "0.0.0.0",

  () => {
    ready = true;

    console.log(
      `AAUP Major Advisor server listening on port ${PORT}`
    );

    console.log(
      `Major Advisor MCP: http://localhost:${PORT}${MCP_PATH}`
    );

    console.log(
      `Website chat: http://localhost:${PORT}${CHAT_PATH}`
    );

    console.log(
      `Health check: http://localhost:${PORT}${HEALTH_PATH}`
    );

    console.log(
      `Readiness check: http://localhost:${PORT}${READY_PATH}`
    );

    console.log(
      `Loaded ${majors.length} programs for academic year ${admissionSystems.academicYear}.`
    );
  }
);

/*
  Graceful shutdown

  This allows a production host to
  restart or stop the application
  without abruptly ending active
  connections.
*/

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  ready = false;

  console.log(
    `Received ${signal}. Shutting down.`
  );

  const forceShutdown =
    setTimeout(() => {
      console.error(
        "Graceful shutdown timed out."
      );

      process.exit(1);
    }, 10000);

  forceShutdown.unref();

  httpServer.close((error) => {
    clearTimeout(
      forceShutdown
    );

    if (error) {
      console.error(
        "Server shutdown failed:",
        error
      );

      process.exit(1);
    }

    console.log(
      "Server shut down successfully."
    );

    process.exit(0);
  });

  /*
    Close inactive keep-alive
    connections when supported.
  */

  httpServer
    .closeIdleConnections?.();
}

process.on(
  "SIGTERM",

  () => {
    shutdown("SIGTERM");
  }
);

process.on(
  "SIGINT",

  () => {
    shutdown("SIGINT");
  }
);
