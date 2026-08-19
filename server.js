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
const HEALTH_PATH = "/healthz";
const READY_PATH = "/readyz";

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
  Basic server status page
*/

app.get("/", (req, res) => {
  res
    .status(200)
    .type("text/plain")
    .send(
      [
        "AAUP Major Advisor MCP server is running.",
        "",
        `MCP endpoint: ${MCP_PATH}`,
        `Health check: ${HEALTH_PATH}`,
        `Readiness check: ${READY_PATH}`,
      ].join("\n")
    );
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