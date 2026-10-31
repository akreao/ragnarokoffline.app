# Client-test release notes

This fork's own releases, for Steven's testers. One file per release,
`<version>.md`, added by that version's bump pull request (the commit named
`<version>` that changes `package.json`). `release.yml` tags it
`v<version>-client-test` and will not tag a version that has no notes here;
`build.yml` publishes the release, titled "Ragnarok Offline <version>
(client-test)", with the file as its body.

They live in this folder, not beside upstream's `release-notes/<version>.md`,
so merging Flux159's main never collides with them.

Same shape as upstream's notes (see `../README.md`). From the second release
on, end with
`**Full Changelog**: https://github.com/akreao/ragnarokoffline.app/compare/v<previous>-client-test...v<version>-client-test`.
