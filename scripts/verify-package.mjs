import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const npmCli = process.env.npm_execpath;
const npmEnvironment = {
  ...process.env,
  npm_config_dry_run: "false",
};

if (npmCli === undefined || npmCli.length === 0) {
  throw new Error("npm_execpath is required to verify the package.");
}

const directory = await fs.mkdtemp(
  path.join(os.tmpdir(), "http-client-consumer-"),
);
const server = http.createServer((_request, response) => {
  response.writeHead(207, "Verified Package", {
    "content-type": "text/plain",
  });
  response.end("installed package");
});

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("The package verification server did not bind to TCP.");
  }

  const packed = await execute(
    process.execPath,
    [
      npmCli,
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      directory,
    ],
    {
      env: npmEnvironment,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  const inventory = JSON.parse(packed.stdout);
  const fileName = inventory[0]?.filename;
  if (typeof fileName !== "string") {
    throw new Error("npm pack did not report a package archive.");
  }
  const archive = path.join(directory, fileName);
  const consumerDirectory = path.join(directory, "consumer");
  await fs.mkdir(consumerDirectory);
  await fs.writeFile(
    path.join(consumerDirectory, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@ismail-elkorchi/http-client": pathToFileURL(archive).href,
      },
    }),
  );
  await fs.writeFile(
    path.join(consumerDirectory, "verify.mjs"),
    `
import assert from "node:assert/strict";
import {
  NodeHttpClient,
  disposeResponseBody,
  readResponseBody,
} from "@ismail-elkorchi/http-client";

const client = new NodeHttpClient({
  networkSafety: { allowLocalhost: true },
});
try {
  const result = await client.requestBuffered(process.env.HTTP_CLIENT_TEST_URL);
  assert.equal(result.kind, "response");
  assert.equal(result.statusCode, 207);
  assert.equal(result.statusMessage, "Verified Package");
  assert.equal(
    new TextDecoder().decode(await readResponseBody(result.body)),
    "installed package",
  );
  await disposeResponseBody(result.body);
} finally {
  await client.close();
}
`,
  );
  await execute(
    process.execPath,
    [
      npmCli,
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
    ],
    {
      cwd: consumerDirectory,
      env: npmEnvironment,
    },
  );
  await execute(
    process.execPath,
    [path.join(consumerDirectory, "verify.mjs")],
    {
      cwd: consumerDirectory,
      env: {
        ...process.env,
        HTTP_CLIENT_TEST_URL:
          `http://127.0.0.1:${String(address.port)}/`,
      },
    },
  );
} finally {
  await new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  await fs.rm(directory, { recursive: true, force: true });
}
