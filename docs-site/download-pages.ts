import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';

// /download/mac/, /download/windows/ and /download/linux/: static pages that
// send the browser straight to the newest release's installer, under its own
// versioned name. The README's Install links point here, because GitHub's
// releases/latest/download/<name> only works for a name that never changes, and
// ours carry the version.
//
// The version is read at build time, so the site has to be rebuilt after each
// release: build.yml runs deploy-docs.yml with the tag it just published
// (RELEASE_TAG). Without it the build asks GitHub for the latest release.
//
// A release whose installers are not named as below fails the build rather than
// publishing pages that 404. Outside CI, a build with no network falls back to
// the releases page, so `bun run build` still works offline.

const REPO = 'Flux159/ragnarokoffline.app';
const RELEASES = `https://github.com/${REPO}/releases`;

const PLATFORMS = [
  { slug: 'mac', label: 'macOS (Apple Silicon)', asset: (v: string) => `Ragnarok.Offline-${v}-arm64.dmg` },
  { slug: 'windows', label: 'Windows', asset: (v: string) => `Ragnarok.Offline-${v}-x64.exe` },
  { slug: 'linux', label: 'Linux (AppImage)', asset: (v: string) => `Ragnarok.Offline-${v}-x86_64.AppImage` },
];

type Target = { version: string | null; urls: Record<string, string> };

async function fetchRelease(tag: string | undefined) {
  const url = tag ? `https://api.github.com/repos/${REPO}/releases/tags/${tag}` : `https://api.github.com/repos/${REPO}/releases/latest`;
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'ragnarokoffline-docs' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return (await response.json()) as { tag_name: string; assets: { name: string; browser_download_url: string }[] };
}

async function resolveTarget(): Promise<Target> {
  const tag = process.env.RELEASE_TAG || undefined;
  const strict = Boolean(tag || process.env.CI);
  let release;
  try {
    release = await fetchRelease(tag);
  } catch (error) {
    if (strict) throw new Error(`download pages: could not read the release (${(error as Error).message})`);
    console.warn(`download pages: ${(error as Error).message}; linking the releases page instead`);
    return { version: null, urls: Object.fromEntries(PLATFORMS.map((p) => [p.slug, `${RELEASES}/latest`])) };
  }
  const version = release.tag_name.replace(/^v/, '');
  const urls: Record<string, string> = {};
  const missing: string[] = [];
  for (const p of PLATFORMS) {
    const found = release.assets.find((a) => a.name === p.asset(version));
    if (found) urls[p.slug] = found.browser_download_url;
    else missing.push(p.asset(version));
  }
  if (missing.length) {
    throw new Error(`download pages: ${release.tag_name} has no ${missing.join(', ')} -- did the installer names change?`);
  }
  return { version, urls };
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function page(title: string, body: string, redirect?: string) {
  const refresh = redirect ? `\n  <meta http-equiv="refresh" content="0; url=${escape(redirect)}" />` : '';
  const script = redirect ? `\n  <script>location.replace(${JSON.stringify(redirect)});</script>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escape(title)}</title>${refresh}
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; padding: 64px 16px; background: #0d1117; color: #e6edf3;
      font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; text-align: center; }
    a { color: #58a6ff; }
    a:hover { color: #a5d6ff; }
    p.muted { color: #8b949e; }
  </style>${script}
</head>
<body>
${body}
</body>
</html>
`;
}

export default function downloadPages(): Plugin {
  let outDir = 'dist';
  return {
    name: 'download-pages',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const { version, urls } = await resolveTarget();
      const name = version ? `Ragnarok Offline ${version}` : 'Ragnarok Offline';
      for (const p of PLATFORMS) {
        const url = urls[p.slug];
        const body = `  <p>Downloading ${escape(name)} for ${escape(p.label)}…</p>
  <p>If it doesn't start, <a href="${escape(url)}">download it here</a>.</p>
  <p class="muted"><a href="${RELEASES}">All releases</a></p>`;
        await mkdir(path.join(outDir, 'download', p.slug), { recursive: true });
        await writeFile(path.join(outDir, 'download', p.slug, 'index.html'), page(`Download ${name}`, body, url));
      }
      const list = PLATFORMS.map((p) => `    <li><a href="${escape(urls[p.slug])}">${escape(p.label)}</a></li>`).join('\n');
      await writeFile(
        path.join(outDir, 'download', 'index.html'),
        page(`Download ${name}`, `  <p>Download ${escape(name)}:</p>\n  <ul style="list-style: none; padding: 0">\n${list}\n  </ul>\n  <p class="muted"><a href="${RELEASES}">All releases</a></p>`),
      );
      console.log(`download pages: ${version ? `v${version}` : 'releases page (no version)'}`);
    },
  };
}
