#!/usr/bin/env node
/**
 * Publishes @nearpay/node to the local registry (Verdaccio in the nearpay-deploy Compose stack, system
 * audit S-11), as a reproducible tarball (see `stage`), the same way nearpay-spec and nearpay-kit
 * publish. Idempotent: a version already published with identical contents is skipped; different
 * contents under the same version fail (bump the version — semver, CHANGELOG).
 *
 * Env: NP_REGISTRY_URL (default http://127.0.0.1:4873), NP_REGISTRY_USER (default nearpay-local),
 *      NP_REGISTRY_PASSWORD (required; `nearpay-deploy/scripts/seed.sh keys` generates it).
 * Flags: --skip-verify   skip `pnpm verify` (callers that already verified; still builds)
 *        --dry-run       stage and pack only (prints the tarball contents), publish nothing
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const registry = (process.env.NP_REGISTRY_URL ?? "http://127.0.0.1:4873").replace(/\/$/, "");
// Publishing anywhere but this machine's registry is a human decision: refuse non-loopback registries.
if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(registry)) {
  console.error(`refusing to publish to ${registry}: only a local registry (127.0.0.1/localhost) is allowed`);
  process.exit(1);
}
/** npm must use exactly the local registry: drop inherited npm_config_* overrides from the caller. */
const npmEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_config_/i.test(k)));
const user = process.env.NP_REGISTRY_USER ?? "nearpay-local";
const password = process.env.NP_REGISTRY_PASSWORD;
const dryRun = process.argv.includes("--dry-run");

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
}

async function token() {
  if (!password) throw new Error("NP_REGISTRY_PASSWORD is not set (see nearpay-deploy/.secrets/registry_password)");
  const url = `${registry}/-/user/org.couchdb.user:${encodeURIComponent(user)}`;
  const body = JSON.stringify({ name: user, password });
  const headers = { "content-type": "application/json" };
  let res = await fetch(url, { method: "PUT", headers, body });
  if (res.status === 409) {
    const basic = Buffer.from(`${user}:${password}`).toString("base64");
    res = await fetch(url, { method: "PUT", headers: { ...headers, authorization: `Basic ${basic}` }, body });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.token) throw new Error(`registry login failed (${res.status}): ${JSON.stringify(json)}`);
  return json.token;
}

function unpack(tgz, dir) {
  run("tar", ["-xzf", tgz, "-C", dir], { stdio: "pipe" });
  const files = {};
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else files[r] = readFileSync(p);
    }
  };
  walk(dir, "");
  return files;
}

/** Canonical JSON (sorted keys) so manifest key order never makes two identical packages differ. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

function sameFile(name, x, y) {
  if (name.endsWith("package.json"))
    return canonical(JSON.parse(x.toString("utf8"))) === canonical(JSON.parse(y.toString("utf8")));
  return x.equals(y);
}

function sameContents(a, b) {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameFile(k, a[k], b[k]));
}

/**
 * Copies the publishable files to `dest` with a publishable manifest: dev-only fields (devDependencies,
 * scripts, pnpm settings, packageManager) are dropped and key order is kept, so `npm pack` of the
 * result is reproducible and consumers' lockfile integrity hashes stay valid on a re-seeded registry.
 */
function stage(dest) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  mkdirSync(dest, { recursive: true });
  for (const f of manifest.files) cpSync(join(root, f), join(dest, f), { recursive: true });
  for (const field of ["devDependencies", "scripts", "pnpm", "packageManager"]) delete manifest[field];
  const loose = Object.entries({ ...manifest.dependencies }).filter(([, v]) => !/^\d+\.\d+\.\d+$/.test(String(v)));
  if (loose.length) throw new Error(`dependencies must be pinned exactly: ${loose.map(([k]) => k).join(", ")}`);
  writeFileSync(join(dest, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function main() {
  if (!process.argv.includes("--skip-verify")) run("pnpm", ["verify"]);
  else run("pnpm", ["build"]);
  const work = mkdtempSync(join(tmpdir(), "nearpay-node-release-"));
  try {
    const staged = join(work, "stage");
    const { name, version } = stage(staged);
    const out = join(work, "out");
    mkdirSync(out, { recursive: true });
    run("npm", ["pack", "--pack-destination", out], { cwd: staged, stdio: "pipe", env: npmEnv });
    const tgz = join(
      out,
      readdirSync(out).find((f) => f.endsWith(".tgz")),
    );
    const packed = unpack(tgz, mkdtempSync(join(work, "a-")));
    if (dryRun) {
      console.log(`${name}@${version} (dry run):\n  ${Object.keys(packed).sort().join("\n  ")}`);
      return;
    }
    const auth = await token();
    const npmrc = join(work, ".npmrc");
    const host = registry.replace(/^https?:/, "");
    writeFileSync(npmrc, `registry=${registry}/\n${host}/:_authToken=${auth}\n`);
    const view = spawnSync(
      "npm",
      ["view", `${name}@${version}`, "version", "--userconfig", npmrc, "--registry", `${registry}/`],
      { env: npmEnv, encoding: "utf8" },
    );
    if (view.status === 0 && view.stdout.trim() === version) {
      const existing = join(work, "published");
      mkdirSync(existing, { recursive: true });
      run(
        "npm",
        [
          "pack",
          `${name}@${version}`,
          "--pack-destination",
          existing,
          "--userconfig",
          npmrc,
          "--registry",
          `${registry}/`,
        ],
        { env: npmEnv, stdio: "pipe" },
      );
      const pub = join(
        existing,
        readdirSync(existing).find((f) => f.endsWith(".tgz")),
      );
      if (!sameContents(packed, unpack(pub, mkdtempSync(join(work, "b-"))))) {
        throw new Error(`${name}@${version} is already published with different contents; bump the version`);
      }
      console.log(`= ${name}@${version} already published (identical)`);
      return;
    }
    run("npm", ["publish", tgz, "--userconfig", npmrc, "--registry", `${registry}/`, "--access", "public"], {
      env: npmEnv,
    });
    console.log(`+ ${name}@${version} published to ${registry}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
