---
name: npm-release
description: Prepare and trigger a stage-only npm release for the gatewayhelper or handoff package in this repository. Use only when explicitly invoked with /skill:npm-release.
disable-model-invocation: true
---

# Release a Pi package

Invoke as `/skill:npm-release <gatewayhelper|handoff> <version>`, for example `/skill:npm-release gatewayhelper 0.1.2`. Release one package per invocation. If releasing both, complete gatewayhelper first, then handoff, because handoff optionally depends on it.

This repository's release tags trigger GitHub Actions to **stage** npm releases. They do not publish immediately; a maintainer must inspect and approve each staged release in npm. Never run `npm publish` or `npm stage publish` locally.

## Preflight

1. Read the root `AGENTS.md`, target package manifest and README, root README, and the target package's release workflow.
2. Map the target exactly:
   - `gatewayhelper`: directory `gatewayhelper/`, npm name `@holysoles/pi-gatewayhelper`, tag `gatewayhelper-v<version>`.
   - `handoff`: directory `handoff/`, npm name `@holysoles/pi-handoff`, tag `handoff-v<version>`.
3. Check `git status --short --branch`, current branch/upstream, and local/remote tags. Do not reset, stash, overwrite, or include unrelated changes. If unrelated tracked changes make the release commit ambiguous, stop and ask.
4. Confirm the requested version is valid and greater than the latest published version. If it is greater than the manifest version, update the manifest; if it matches an already-prepared manifest version, leave it; if it is lower, stop. Check that the npm version, any pending staged release, and exact tag do not already exist. npm versions and tags are immutable: if the version or tag exists, stop and choose a new version rather than retagging.
5. Confirm the package manifest has `keywords` containing `pi-package`, an explicit `pi.extensions` entry that exists, and the expected `files`, exports, peer dependencies, and runtime dependencies. Preserve the handoff optional dependency on gatewayhelper.

## Prepare and verify

1. Set only the target package's `package.json` version to the requested version if it has not already been prepared. Keep `keywords: ["pi-package"]`; do not change the root private workspace manifest.
2. Update the target package's pinned install/remove commands in its README and the corresponding commands in the root README to the new version. Do not change the other package's version or install commands.
3. Review the diff. Stage only the intended release files; never stage unrelated work implicitly.
4. Run `npm test` from the repository root and `npm pack --dry-run --json` from the target package directory. Verify the tarball contains the intended entry point, runtime files, README, and LICENSE, and excludes tests and repository-only files.
5. Verify the workflow trigger and version check agree with the exact tag `gatewayhelper-v<version>` or `handoff-v<version>`.

## Commit, tag, and push

Before creating the commit or pushing, show the user the package/version, exact staged diff, and tag; get explicit confirmation because pushing the tag triggers npm staging.

After confirmation:

1. Commit only the reviewed release files with a conventional message such as `chore(release): gatewayhelper v0.1.2`.
2. Push the commit to `origin main` and verify it succeeded.
3. Create an annotated tag on that commit using the exact workflow tag, then push only that tag. Never force-push, delete, or move a release tag.
4. Watch the corresponding GitHub Actions run. If it succeeds, tell the user the npm release is staged and awaits manual approval. If it fails, inspect the logs and report the cause; fix the issue and rerun that workflow instead of making another version/tag merely to retry.

The release workflows use npm trusted publishing with stage-only permissions. Do not create or store npm tokens. After approval, verify the published version and provenance on npm.
