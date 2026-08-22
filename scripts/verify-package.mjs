import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const npmCli = process.env.npm_execpath;
const npmEnvironment = {
  ...process.env,
  npm_config_audit: "false",
  npm_config_dry_run: "false",
  npm_config_fund: "false",
  npm_config_offline: "true",
  npm_config_update_notifier: "false",
};

if (npmCli === undefined || npmCli.length === 0) {
  throw new Error("npm_execpath is required to verify the package.");
}

const temporaryDirectory = await fs.mkdtemp(
  path.join(os.tmpdir(), "http-client-consumer-"),
);
const packageDirectory = path.join(temporaryDirectory, "packages");
const consumerDirectory = path.join(temporaryDirectory, "consumer");
const server = http.createServer((request, response) => {
  if (request.url === "/conditional") {
    if (request.headers["if-none-match"] !== '"packed-v1"') {
      response.writeHead(412);
      response.end("missing validator");
      return;
    }
    response.writeHead(304, {
      etag: '"packed-v1"',
      "last-modified": "Fri, 21 Aug 2026 12:00:00 GMT",
    });
    response.end();
    return;
  }
  response.writeHead(207, "Verified Package", {
    "content-type": "text/plain",
  });
  response.end("installed package");
});

try {
  await fs.mkdir(packageDirectory);
  await fs.mkdir(consumerDirectory);
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

  const packageArchive = await pack(repositoryRoot, packageDirectory);
  const undiciArchive = await pack(
    path.join(repositoryRoot, "node_modules", "undici"),
    packageDirectory,
  );
  const nodeTypesArchive = await pack(
    path.join(repositoryRoot, "node_modules", "@types", "node"),
    packageDirectory,
  );
  const undiciTypesArchive = await pack(
    path.join(repositoryRoot, "node_modules", "undici-types"),
    packageDirectory,
  );
  verifyInventory(packageArchive.files);

  await fs.writeFile(
    path.join(consumerDirectory, "package.json"),
    `${JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@ismail-elkorchi/http-client": `file:../packages/${packageArchive.fileName}`,
        undici: `file:../packages/${undiciArchive.fileName}`,
      },
      devDependencies: {
        "@types/node": `file:../packages/${nodeTypesArchive.fileName}`,
        "undici-types": `file:../packages/${undiciTypesArchive.fileName}`,
      },
    }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(consumerDirectory, "verify.mjs"),
    consumerSource(),
  );
  await fs.writeFile(
    path.join(consumerDirectory, "verify-types.ts"),
    typeConsumerSource(),
  );
  await fs.writeFile(
    path.join(consumerDirectory, "tsconfig.json"),
    `${JSON.stringify({
      compilerOptions: {
        target: "ES2024",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        types: ["node"],
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        noEmit: true,
        skipLibCheck: false,
      },
      include: ["verify-types.ts"],
    }, null, 2)}\n`,
  );

  await execute(
    process.execPath,
    [
      npmCli,
      "install",
      "--ignore-scripts",
      "--no-package-lock",
    ],
    { cwd: consumerDirectory, env: npmEnvironment },
  );

  await execute(
    process.execPath,
    [
      path.join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"),
      "--project",
      path.join(consumerDirectory, "tsconfig.json"),
    ],
    { cwd: consumerDirectory },
  );

  const consumerPath = path.join(consumerDirectory, "verify.mjs");
  const runtimeEnvironment = {
    ...process.env,
    HTTP_CLIENT_TEST_URL: `http://127.0.0.1:${String(address.port)}/`,
  };
  await execute(process.execPath, [consumerPath, "Node.js"], {
    cwd: consumerDirectory,
    env: runtimeEnvironment,
  });
  await execute(
    "deno",
    [
      "run",
      "--cached-only",
      "--node-modules-dir=manual",
      "--allow-env",
      "--allow-net=127.0.0.1",
      "--allow-read",
      "--allow-sys",
      consumerPath,
      "Deno",
    ],
    {
      cwd: consumerDirectory,
      env: { ...runtimeEnvironment, DENO_NO_UPDATE_CHECK: "1" },
    },
  );
  process.stdout.write("packed consumers passed: Node.js, Deno\n");
} finally {
  await new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
}

async function pack(source, destination) {
  const packed = await execute(
    process.execPath,
    [
      npmCli,
      "pack",
      source,
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      destination,
    ],
    {
      cwd: repositoryRoot,
      env: npmEnvironment,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  const inventory = JSON.parse(packed.stdout);
  const archive = inventory[0];
  if (
    typeof archive !== "object" ||
    archive === null ||
    typeof archive.filename !== "string" ||
    !Array.isArray(archive.files)
  ) {
    throw new Error("npm pack did not report a package archive.");
  }
  return {
    fileName: archive.filename,
    files: archive.files,
  };
}

function verifyInventory(files) {
  const paths = new Set(files.map((file) => file.path));
  for (const required of [
    "CHANGELOG.md",
    "LICENSE",
    "README.md",
    "SECURITY.md",
    "dist/index.d.ts",
    "dist/index.js",
    "package.json",
  ]) {
    if (!paths.has(required)) {
      throw new Error(`Packed package is missing ${required}.`);
    }
  }
  if ([...paths].some((filePath) => filePath.startsWith("src/"))) {
    throw new Error("The npm package contains unpublished TypeScript sources.");
  }
}

function consumerSource() {
  return `
import assert from "node:assert/strict";
import {
  NodeHttpClient,
  disposeResponseBody,
  readResponseBody,
} from "@ismail-elkorchi/http-client";

const runtime = process.argv[2];
const rejectedClient = new NodeHttpClient();
try {
  const rejected = await rejectedClient.requestBuffered(
    process.env.HTTP_CLIENT_TEST_URL,
  );
  assert.equal(rejected.kind, "failure");
  assert.equal(rejected.error.code, "NETWORK_SAFETY_REJECTED");
} finally {
  await rejectedClient.close();
}

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

  const conditional = await client.fetchBuffered(
    new URL("conditional", process.env.HTTP_CLIENT_TEST_URL),
    { fields: [{ name: "if-none-match", value: '"packed-v1"' }] },
  );
  assert.equal(conditional.kind, "response");
  assert.equal(conditional.statusCode, 304);
  assert.equal(conditional.fields.first("etag"), '"packed-v1"');
  assert.equal(
    conditional.fields.first("last-modified"),
    "Fri, 21 Aug 2026 12:00:00 GMT",
  );
  await disposeResponseBody(conditional.body);
  console.log(runtime + " packed consumer passed");
} finally {
  await client.close();
}
`;
}

function typeConsumerSource() {
  return `
import {
  NodeHttpClient,
  type HttpClientEvent,
  type StreamingHttpResult,
} from "@ismail-elkorchi/http-client";

const client = new NodeHttpClient({
  observer: {
    async onEvent(event: HttpClientEvent) {
      void event.kind;
    },
  },
});

const result: Promise<StreamingHttpResult> = client.request(
  "https://example.com/",
);
void result;
`;
}
