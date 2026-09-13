// Downloads the pinned Centrifugo static binary once, verifies its sha256 against the release
// checksums file, and extracts it to .cache/centrifugo/<version>/centrifugo. No Docker needed.
import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "6.9.4";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, ".cache", "centrifugo", VERSION);
const bin = path.join(dir, process.platform === "win32" ? "centrifugo.exe" : "centrifugo");
const os = { linux: "linux", darwin: "darwin", win32: "windows" }[process.platform];
const arch = { x64: "amd64", arm64: "arm64" }[process.arch];
if (!os || !arch) throw new Error(`unsupported platform ${process.platform}/${process.arch}`);
const asset = `centrifugo_${VERSION}_${os}_${arch}.${os === "windows" ? "zip" : "tar.gz"}`;
const base = `https://github.com/centrifugal/centrifugo/releases/download/v${VERSION}/`;

const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};
const download = async (name) => {
  const res = await fetch(base + name, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`download failed ${res.status} for ${name}`);
  return Buffer.from(await res.arrayBuffer());
};

if (await exists(bin)) {
  console.log(`centrifugo ${VERSION} present at ${bin}`);
} else {
  await mkdir(dir, { recursive: true });
  const [archive, sums] = await Promise.all([download(asset), download(`centrifugo_${VERSION}_checksums.txt`)]);
  const expected = sums
    .toString()
    .split("\n")
    .find((l) => l.trim().endsWith(asset))
    ?.split(/\s+/)[0];
  if (!expected) throw new Error(`no checksum for ${asset}`);
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== expected) throw new Error(`checksum mismatch for ${asset}: ${actual} != ${expected}`);
  const archivePath = path.join(dir, asset);
  await writeFile(archivePath, archive);
  await promisify(execFile)("tar", ["-xzf", archivePath, "-C", dir, "centrifugo"]);
  if (!(await exists(bin))) throw new Error("extraction did not produce the binary");
  console.log(`centrifugo ${VERSION} downloaded and verified (${expected.slice(0, 12)}…) at ${bin}`);
}
const { stdout } = await promisify(execFile)(bin, ["version"]);
console.log(stdout.trim());
