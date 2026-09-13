// Builds nrc-nodered-e2e:local: `npm pack` the working tree into a throwaway build context next to the Dockerfile,
// then `docker build`. Installing from the tarball (not a bind-mounted workspace) is the point of this tier — it
// catches "files" allowlist mistakes a local `npm link`-style setup would hide. Idempotent: re-run any time, Docker
// layer caching keeps a repeat build cheap when the tarball is unchanged.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../.."); // repo root, three levels up from test/docker/browser
const TAG = "nrc-nodered-e2e:local";

export async function buildImage() {
  const dir = await mkdtemp(join(tmpdir(), "nrc-e2e-image-"));
  try {
    const { stdout } = await run("npm", ["pack", "--json", "--pack-destination", dir], { cwd: ROOT });
    const [{ filename }] = JSON.parse(stdout);
    await cp(join(dir, filename), join(dir, "node-red-contrib-centrifuge.tgz"));
    await cp(join(HERE, "Dockerfile"), join(dir, "Dockerfile"));
    await cp(join(HERE, "settings.js"), join(dir, "settings.js"));
    await run("docker", ["build", "-t", TAG, dir], { maxBuffer: 16 * 1024 * 1024 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return TAG;
}
