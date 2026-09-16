# Release

Publishing goes through npm trusted publishing (OIDC) from `.github/workflows/release.yml`. No npm token is stored
anywhere. The first version of a new package cannot use trusted publishing, so the bootstrap below is done once by a
maintainer from their own terminal, never from an agent session or CI.

## One-time bootstrap (first publish)

1. Confirm the name is free: `npm view @pauldeng/node-red-contrib-centrifuge` must fail with 404.
2. On the release commit, run the full gate locally: `npm run lint && npm run format:check && npm test && npm run test:e2e && npm run check:release`, then `npm pack --dry-run` and read the file list.
3. Publish the first version manually with 2FA: `npm login`, then `npm publish --access public`. Provenance is not available for this manual publish; every later release has it.
4. On npmjs.com open the package, Settings, Trusted publisher, and register GitHub Actions with exactly:
   - Organization or user: `pauldeng`
   - Repository: `node-red-contrib-centrifuge`
   - Workflow filename: `release.yml`
   - Environment name: leave empty (the workflow declares none; a mismatch here produces a 404 after a publish that looks successful)
   - Allowed actions: enable direct publishing with `npm publish`. This workflow publishes directly and requires that permission; stage-only permissions are incompatible with it. See the [npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).
     npm does not verify the tuple when you save it; a typo only shows up as a failed release.
5. Still in Settings, set publishing access to "Require two-factor authentication and disallow tokens". Trusted publishers keep working; classic tokens stop.
6. Protect `main` on GitHub with a branch ruleset: require a pull request before merging, require the CI checks to pass, block force pushes and deletions. A solo maintainer needs no required reviewers.
7. Submit the package to the Flow Library at https://flows.nodered.org/add/node once the first version is on npm.

## Every release after that

1. Move the `Unreleased` entries in `CHANGELOG.md` under `## [x.y.z] - YYYY-MM-DD` and set the same version in `package.json` (`npm version x.y.z --no-git-tag-version` keeps the lockfile in sync).
2. Open a pull request; CI must be green on the merge commit.
3. Create a GitHub Release with tag `vx.y.z` on `main`. The workflow checks the tag equals the package version, that the version is not on the registry yet, that the changelog has its section, reruns lint, format, `npm test`, the editor suite, `npm audit --omit=dev` and `npm run check:release`, installs the packed tarball into a clean Node-RED and confirms all declared node types register, publishes with provenance, and finally requires the expected version, a tarball URL and SLSA provenance metadata from the registry. The registry check polls for up to ten minutes while the registry propagates the new version and fails if any required field remains absent. If it still fails but `npm view` shows the version with provenance, the publish succeeded and only the check timed out; do not re-run the workflow, because the version is now on the registry.
4. Trust the registry, not the workflow log: `npm view @pauldeng/node-red-contrib-centrifuge@x.y.z dist.attestations` must list the provenance attestation.
5. Refresh the Flow Library entry if the README or node set changed.

## Recovery

- A broken release gets a new patch version. Never move or reuse a published tag.
- A harmful release is deprecated, not unpublished: `npm deprecate @pauldeng/node-red-contrib-centrifuge@x.y.z "reason"`.
- If the trusted publisher must change (workflow renamed, environment added), delete and recreate it; configurations cannot be edited.

## Local verification of the release gates

The clean-install step uses `scripts/check-installed-package.js <user-directory>` after installing the tarball into that directory. It rejects startup exits, failed HTTP responses and missing, disabled or incorrect node registrations; readiness and the HTTP request share a deadline, and the child is stopped on every outcome.

For registry verification, capture `npm view <name>@<version> version dist.tarball dist.attestations --json` to a file and pass it to `node scripts/check-published-package.js <file>`. This asserts registry metadata presence and the expected version/predicate type; it is not cryptographic verification of the attestation bundle. Neither script publishes anything. Regression checks run in `npm test`.
