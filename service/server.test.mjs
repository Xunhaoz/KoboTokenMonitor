import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  mkdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./server.mjs";
import { run } from "./process.mjs";

test("serve public PNG, isolate failed provider, prevent overlapping cycles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kobo-service-"));
  let calls = 0;
  const collector = {
    restore() {},
    async collect(id) {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      if (id === "claude") throw Error("failure");
      return {
        provider: id,
        usage: {
          updatedAt: new Date().toISOString(),
          primary: { usedPercent: 0 },
          secondary: { usedPercent: 20 },
        },
      };
    },
  };
  const app = createApp({
    dataDir: dir,
    collector,
    execute: async (_, args) => {
      const records = JSON.parse(
        await readFile(join(dir, "usage.json"), "utf8"),
      );
      assert.equal(records[1].error.code, "query_failed");
      await writeFile(args.at(-1), Buffer.from([137, 80, 78, 71]));
      return { code: 0 };
    },
  });
  try {
    await app.initialize();
    await Promise.all([app.cycle(), app.cycle()]);
    assert.equal(calls, 2);
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${app.server.address().port}`;
    const response = await fetch(url + "/usage.png");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal((await fetch(url + "/healthz")).status, 200);
    assert.equal((await fetch(url + "/.codex/auth.json")).status, 404);
  } finally {
    app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
test("render failure keeps previous image and makes health unhealthy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kobo-failure-"));
  const app = createApp({
    dataDir: dir,
    collector: {
      restore() {},
      async collect(id) {
        return { provider: id };
      },
    },
    execute: async () => ({ code: 1 }),
  });
  try {
    await app.initialize();
    await writeFile(join(dir, "usage.png"), "previous-image");
    await app.cycle();
    assert.equal(
      await readFile(join(dir, "usage.png"), "utf8"),
      "previous-image",
    );
    assert.equal(app.health.renderError, "update_failed");
  } finally {
    app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
test("CLI timeout terminates blocked process", async () => {
  const result = await run(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    { timeout: 100 },
  );
  assert.equal(result.reason, "timeout");
});

test("downloads reuse minute cache, share rendering, and never collect usage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kobo-minute-"));
  let clock = Date.parse("2026-10-25T00:00:10Z"),
    renders = 0,
    calls = 0;
  const app = createApp({
    dataDir: dir,
    now: () => clock,
    collector: {
      restore() {},
      async collect(id) {
        calls++;
        return { provider: id };
      },
    },
    execute: async (_, args) => {
      renders++;
      const at = args[args.indexOf("--at") + 1];
      await new Promise((r) => setTimeout(r, 10));
      await writeFile(args.at(-1), at);
      return { code: 0 };
    },
  });
  try {
    await app.initialize();
    await app.cycle();
    assert.equal(renders, 1);
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${app.server.address().port}/usage.png`;
    const download = async (method = "GET") => {
      const response = await fetch(url, { method });
      assert.equal(response.status, 200);
      return response.text();
    };
    clock += 20000;
    await download();
    assert.equal(renders, 1);
    clock += 60000;
    const images = await Promise.all([
      download(),
      download(),
      download("HEAD"),
    ]);
    assert.equal(renders, 2);
    assert.equal(calls, 2);
    assert.equal(images[0], new Date(clock).toISOString());
    assert.equal(images[1], images[0]);
    assert.equal(images[2], "");
    await app.cycle();
    assert.equal(renders, 3);
    assert.equal(calls, 4);
    await download();
    assert.equal(renders, 3);
  } finally {
    app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("download render failure serves previous PNG and retries successfully", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kobo-download-failure-"));
  let clock = Date.parse("2026-10-25T00:00:10Z"),
    fail = false;
  const app = createApp({
    dataDir: dir,
    now: () => clock,
    collector: {
      restore() {},
      async collect(id) {
        return { provider: id };
      },
    },
    execute: async (_, args) => {
      if (fail) return { code: 1 };
      await writeFile(args.at(-1), String(clock));
      return { code: 0 };
    },
  });
  try {
    await app.initialize();
    await app.cycle();
    const previous = String(clock);
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${app.server.address().port}/usage.png`;
    const download = () => fetch(url);
    clock += 60000;
    fail = true;
    const response = await download();
    assert.equal(response.status, 200);
    assert.equal(await response.text(), previous);
    assert.equal(app.health.renderError, "update_failed");
    fail = false;
    assert.equal(await (await download()).text(), String(clock));
    assert.equal(app.health.renderError, null);
  } finally {
    app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("public dashboard survives render failure, restores snapshots and never triggers collection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kobo-api-"));
  let clock = Date.parse("2026-10-25T01:00:00Z"),
    calls = 0;
  const good = {
    provider: "codex",
    usage: {
      updatedAt: new Date(clock).toISOString(),
      primary: { usedPercent: 0 },
      secondary: { usedPercent: 40 },
    },
    collection: { lastSuccessAt: new Date(clock).toISOString() },
    email: "private@example.com",
    token: "secret",
  };
  const app = createApp({
    dataDir: dir,
    now: () => clock,
    collector: {
      restore() {},
      async collect(id) {
        calls++;
        return id === "codex"
          ? good
          : { provider: id, error: { code: "authentication_required" } };
      },
    },
    execute: async () => ({ code: 1 }),
  });
  try {
    await writeFile(join(dir, "usage.json"), JSON.stringify([good]));
    await app.initialize();
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${app.server.address().port}`;
    let response = await fetch(url + "/api/dashboard");
    assert.equal(response.status, 200);
    let data = await response.json();
    assert.equal(data.providers[0].usage.primary.usedPercent, 0);
    assert.equal(calls, 0);
    await app.cycle();
    data = await (await fetch(url + "/api/dashboard")).json();
    assert.equal(data.service.renderError, "update_failed");
    assert.equal(
      data.providers[1].collection.status,
      "authentication_required",
    );
    assert.equal(data.providers[0].usage.primary.usedPercent, 0);
    assert.doesNotMatch(JSON.stringify(data), /secret|private@example/);
    const status = await (await fetch(url + "/status")).text();
    assert.doesNotMatch(status, /secret|private@example/);
    clock += 660000;
    data = await (await fetch(url + "/api/dashboard")).json();
    assert.equal(data.providers[0].usage.state, "stale");
    assert.equal(calls, 2);
    response = await fetch(url + "/api/dashboard", { method: "HEAD" });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "");
    assert.equal(
      (await fetch(url + "/api/dashboard", { method: "POST" })).status,
      405,
    );
    assert.equal((await fetch(url + "/api/missing")).status, 404);
  } finally {
    app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("serve SPA deep links and cached assets without exposing arbitrary files or symlinks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kobo-static-"));
  const staticDir = join(dir, "frontend");
  await mkdir(join(staticDir, "assets"), { recursive: true });
  await writeFile(
    join(staticDir, "index.html"),
    "<!doctype html><title>Monitor</title>",
  );
  await writeFile(
    join(staticDir, "assets", "app-ab12.js"),
    'console.log("app")',
  );
  await writeFile(join(dir, "secret.js"), "private-token");
  await symlink(join(dir, "secret.js"), join(staticDir, "assets", "leak.js"));
  const app = createApp({
    dataDir: dir,
    staticDir,
    collector: { restore() {} },
  });
  try {
    await app.initialize();
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${app.server.address().port}`;
    for (const path of ["/", "/usage", "/cli", "/overview"]) {
      const response = await fetch(url + path);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /text\/html/);
    }
    const asset = await fetch(url + "/assets/app-ab12.js");
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("cache-control"), /immutable/);
    const head = await fetch(url + "/usage", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    for (const path of [
      "/api/nope",
      "/.env",
      "/usage.json",
      "/service/server.mjs",
      "/assets/leak.js",
      "/assets/%2e%2e%2fsecret.js",
      "/unknown",
    ]) {
      assert.equal((await fetch(url + path)).status, 404, path);
    }
  } finally {
    app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
