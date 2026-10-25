# Potswap docs site

Public developer documentation for Potswap, served at https://docs.potswap.io. Built with [Astro](https://astro.build) and [Starlight](https://starlight.astro.build): static output, dark / light themes, built-in search (Pagefind), sidebar navigation.

## Run

Node 20+ and npm.

```bash
cd docs-site
npm install
npm run dev        # http://localhost:4321
```

## Build

```bash
npm run build      # node scripts/gen-llms.mjs && astro build → dist/
npm run preview    # serve dist/ locally
```

`dist/` is pure static HTML and can be hosted on any free static host (Cloudflare Pages, GitHub Pages, Netlify). Point the host at `docs-site/`, build command `npm run build`, output directory `dist`.

## Layout

```
astro.config.mjs          site URL, title, sidebar
src/content/docs/         one .md / .mdx per page (frontmatter: title, description)
  index.mdx               landing (splash)
  getting-started/        introduction, quickstart, troubleshooting
  agents/                 mcp-tools, strategies, configuration
  routing/                how-routing-works, fees, direct-dex-roadmap
  security/               non-custodial, limits-and-policies, key-handling
  economy/                points-and-pot, launch-meter
  resources/              faq, changelog, roadmap, license
scripts/gen-llms.mjs      generates public/llms.txt and public/llms-full.txt from the pages
public/                   favicon, generated llms files
```

## llms.txt

`npm run build` (and `npm run dev`) first runs `scripts/gen-llms.mjs`, which writes:

- `public/llms.txt`: an index of every page (title, one-line description, canonical URL), grouped by section.
- `public/llms-full.txt`: the full body of every page as plain Markdown (MDX components flattened).

Both are regenerated from `src/content/docs` on each build; do not edit them by hand. The sidebar order in the script's `ORDER` array mirrors `astro.config.mjs`; add new pages to both.

## Editing rules

- Document only what exists in `@potswap_io/mcp` today as available. Anything specified but unbuilt goes under a **Roadmap** / **Planned** label (see `resources/roadmap.md`).
- Sources of truth: `mcp/README.md`, `mcp/src/server.ts`, `mcp/src/strategies/tools.ts`, `mcp/src/config.ts`, `app/src/lib/fee.ts`, `docs/PRD.md` (P8, P10, P11, P12), `docs/project/MASTER_SPEC.md`.
- Keep code blocks copyable: real mints, real env var names, real error copy.
