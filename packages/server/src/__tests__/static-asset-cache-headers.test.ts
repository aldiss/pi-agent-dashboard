import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { gzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";

/**
 * Regression guard for the immutable-asset Cache-Control headers registered in
 * server.ts (production-build static serving).
 *
 * The fastifyStatic register uses preCompressed:true so gzip siblings ship a
 * stable Content-Length. @fastify/static (via @fastify/send) computes its own
 * Cache-Control from cacheControl/maxAge and applies it via reply.headers()
 * AFTER the setHeaders callback — so a setHeaders override of Cache-Control is
 * SILENTLY clobbered to "public, max-age=0" unless cacheControl:false disables
 * send's own header. The corrected (complete) form therefore needs BOTH
 * cacheControl:false AND the setHeaders branches.
 *
 * The setHeaders logic below mirrors server.ts; it is kept in sync by hand (see
 * the source-guard test that asserts server.ts still carries cacheControl:false
 * alongside preCompressed:true).
 */
function setAssetHeaders(
  res: { setHeader(name: string, value: string): void },
  filePath: string,
): void {
  if (
    filePath.endsWith(".html") ||
    filePath.endsWith(".html.gz") ||
    filePath.endsWith(".html.br")
  ) {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  } else if (filePath.includes("/assets/")) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    res.setHeader("Cache-Control", "public, max-age=300");
  }
}

const HASHED_ASSET = "foo-AbCd1234.js";

let root: string;

beforeAll(() => {
  // Fake Vite production build: a content-hashed JS chunk with a gzip sibling,
  // plus an index.html (also with a gzip sibling) — exactly the layout the
  // production static handler serves with preCompressed:true.
  root = mkdtempSync(path.join(os.tmpdir(), "leverB-headers-"));
  mkdirSync(path.join(root, "assets"), { recursive: true });
  const js = "console.log('hashed chunk');";
  writeFileSync(path.join(root, "assets", HASHED_ASSET), js);
  writeFileSync(path.join(root, "assets", `${HASHED_ASSET}.gz`), gzipSync(js));
  const html = "<!doctype html><title>dashboard</title>";
  writeFileSync(path.join(root, "index.html"), html);
  writeFileSync(path.join(root, "index.html.gz"), gzipSync(html));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

async function buildStaticServer(
  opts: Record<string, unknown>,
): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(fastifyStatic, { root, prefix: "/", ...opts });
  await app.ready();
  return app;
}

describe("immutable asset Cache-Control (corrected preCompressed-safe form)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // The exact option triple shipped in server.ts.
    app = await buildStaticServer({
      preCompressed: true,
      cacheControl: false,
      setHeaders: setAssetHeaders,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("marks a hashed /assets chunk immutable on the gzip (preCompressed) path", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/assets/${HASHED_ASSET}`,
      headers: { "accept-encoding": "gzip, br" },
    });
    expect(res.statusCode).toBe(200);
    // Confirms we actually exercised the preCompressed branch — the one where
    // send clobbers Cache-Control unless cacheControl:false is set.
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(res.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  it("marks a hashed /assets chunk immutable on the identity path", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/assets/${HASHED_ASSET}`,
      headers: { "accept-encoding": "identity" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  it("serves index.html as no-cache on the gzip path", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/index.html",
      headers: { "accept-encoding": "gzip, br" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(res.headers["cache-control"]).toBe(
      "no-cache, no-store, must-revalidate",
    );
  });

  it("serves index.html as no-cache on the identity path", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/index.html",
      headers: { "accept-encoding": "identity" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.headers["cache-control"]).toBe(
      "no-cache, no-store, must-revalidate",
    );
  });
});

describe("trap: setHeaders alone is clobbered under preCompressed:true", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // The NAIVE form — preCompressed + setHeaders, WITHOUT cacheControl:false.
    app = await buildStaticServer({
      preCompressed: true,
      setHeaders: setAssetHeaders,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("regresses hashed assets to max-age=0 (documents why cacheControl:false is required)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/assets/${HASHED_ASSET}`,
      headers: { "accept-encoding": "gzip, br" },
    });
    expect(res.statusCode).toBe(200);
    // send's own Cache-Control wins over the setHeaders override — proving the
    // immutable directive is silently lost without cacheControl:false.
    expect(res.headers["cache-control"]).toBe("public, max-age=0");
  });
});

describe("setHeaders classifier (mirrors server.ts)", () => {
  function classify(filePath: string): string {
    let value = "";
    setAssetHeaders({ setHeader: (_k, v) => (value = v) }, filePath);
    return value;
  }

  it("treats brotli-precompressed html as no-cache", () => {
    expect(classify("/root/index.html.br")).toBe(
      "no-cache, no-store, must-revalidate",
    );
  });

  it("treats non-hashed root files (manifest/icons/sw.js) as short-cache", () => {
    expect(classify("/root/sw.js")).toBe("public, max-age=300");
    expect(classify("/root/manifest.json")).toBe("public, max-age=300");
  });
});

describe("source guard: server.ts carries the corrected complete form", () => {
  it("registers fastifyStatic with cacheControl:false alongside preCompressed:true", () => {
    const serverPath = path.join(import.meta.dirname, "..", "server.ts");
    const src = readFileSync(serverPath, "utf8");

    const registerIdx = src.indexOf("fastifyStatic, {");
    expect(registerIdx).toBeGreaterThan(-1);

    const setHeadersIdx = src.indexOf("setHeaders:", registerIdx);
    expect(setHeadersIdx).toBeGreaterThan(registerIdx);

    // cacheControl:false must sit inside the register options, before setHeaders.
    const optionsHead = src.slice(registerIdx, setHeadersIdx);
    expect(optionsHead).toContain("preCompressed: true");
    expect(optionsHead).toContain("cacheControl: false");

    // The immutable + no-store directives must live in the setHeaders body.
    const setHeadersBody = src.slice(
      setHeadersIdx,
      src.indexOf("});", setHeadersIdx),
    );
    expect(setHeadersBody).toContain(
      "public, max-age=31536000, immutable",
    );
    expect(setHeadersBody).toContain("no-cache, no-store, must-revalidate");
  });
});
