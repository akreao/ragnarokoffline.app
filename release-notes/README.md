# Release notes

One file per release, `<version>.md`, added by that version's bump pull request
(the commit named `<version>` that changes `package.json`). `build.yml`
publishes the GitHub release with it as the body, and `release.yml` will not
tag a version that has none.

The shape, as in every release since 1.3.9:

- one summary sentence;
- `## New`, `## Modding`, `## Fixes` and `## Known issues`, leaving out empty
  ones;
- bold lead-ins, and "Thanks @github-user. (#PR)" credits;
- last, `**Full Changelog**: https://github.com/Flux159/ragnarokoffline.app/compare/v<previous>...v<version>`.

Describe what players see, not how it was done, and leave out anything reverted
before the release.
