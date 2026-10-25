// Generates public/llms.txt (index) and public/llms-full.txt (all page bodies) from src/content/docs.
// Run before `astro build` so both files ship with the static output.
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const docsDir = join(root, 'src', 'content', 'docs');
const publicDir = join(root, 'public');
const SITE = 'https://docs.potswap.io';

/** Sidebar order mirrors astro.config.mjs; anything not listed is appended alphabetically. */
const ORDER = [
	'index',
	'getting-started/introduction',
	'getting-started/quickstart',
	'getting-started/troubleshooting',
	'agents/mcp-tools',
	'agents/strategies',
	'agents/configuration',
	'agents/sdk',
	'agents/cli',
	'agents/observations',
	'agents/defi',
	'routing/how-routing-works',
	'routing/fees',
	'routing/direct-dex-roadmap',
	'security/non-custodial',
	'security/limits-and-policies',
	'security/key-handling',
	'economy/points-and-pot',
	'economy/launch-meter',
	'resources/faq',
	'resources/changelog',
	'resources/roadmap',
	'resources/license',
];

function walk(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...walk(p));
		else if (/\.(md|mdx)$/.test(name)) out.push(p);
	}
	return out;
}

function parseFrontmatter(src) {
	const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!m) return { data: {}, body: src };
	const data = {};
	for (const line of m[1].split(/\r?\n/)) {
		const kv = line.match(/^(\w+):\s*(.*)$/);
		if (kv) data[kv[1]] = kv[2].replace(/^['"]|['"]$/g, '');
	}
	return { data, body: src.slice(m[0].length) };
}

/** Strip MDX-only syntax so the body reads as plain Markdown. */
function toPlainMarkdown(body) {
	return body
		.replace(/^import\s.*$/gm, '')
		.replace(/<Code\s+code="([^"]*)"\s+lang="(\w+)"\s*\/>/g, (_, code, lang) => `\`\`\`${lang}\n${code}\n\`\`\``)
		.replace(/<\/?CardGrid[^>]*>/g, '')
		.replace(/<Card\s+title="([^"]*)"[^>]*>/g, (_, title) => `### ${title}\n`)
		.replace(/<\/Card>/g, '')
		.replace(/^:::\w*(\[[^\]]*\])?\s*$/gm, (m) => {
			const label = m.match(/\[([^\]]*)\]/);
			return label ? `> **${label[1]}**` : '';
		})
		.replace(/^:::\s*$/gm, '')
		.replace(/^[ \t]+(?=\S)/gm, (m, offset, str) => (insideFence(str, offset) ? m : ''))
		.replace(/^[ \t]+$/gm, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/** True when `offset` falls inside a ``` fenced block (indentation there is content). */
function insideFence(str, offset) {
	let open = false;
	const re = /^```/gm;
	let m;
	while ((m = re.exec(str)) && m.index < offset) open = !open;
	return open;
}

const pages = walk(docsDir).map((file) => {
	const slug = relative(docsDir, file).split(sep).join('/').replace(/\.(md|mdx)$/, '');
	const { data, body } = parseFrontmatter(readFileSync(file, 'utf8'));
	const path = slug === 'index' ? '/' : `/${slug}/`;
	return { slug, path, title: data.title ?? slug, description: data.description ?? '', body: toPlainMarkdown(body) };
});

pages.sort((a, b) => {
	const ia = ORDER.indexOf(a.slug), ib = ORDER.indexOf(b.slug);
	if (ia !== -1 && ib !== -1) return ia - ib;
	if (ia !== -1) return -1;
	if (ib !== -1) return 1;
	return a.slug.localeCompare(b.slug);
});

const intro = [
	'# Potswap Docs',
	'',
	'> Solana DeFi infrastructure for AI agents: best-route swaps (Jupiter Swap V2 meta-aggregation), DCA / rebalance / take-profit strategies and POT rewards through one non-custodial MCP server, `@potswap_io/mcp`. Install: `npx -y @potswap_io/mcp`.',
	'',
	'`@potswap_io/mcp` 0.4.0 (27 tools) is available today; the Potswap API serves quotes, orders, token data, points, the launch meter and claims. Pages marked roadmap or planned describe specified, unbuilt work. `@potswap_io/sdk` (the engine as a library) and `@potswap_io/cli` (the `potswap` command) are published too.',
	'',
];

const sections = new Map();
for (const p of pages) {
	const section = p.slug.includes('/') ? p.slug.split('/')[0] : 'overview';
	if (!sections.has(section)) sections.set(section, []);
	sections.get(section).push(p);
}
const SECTION_TITLES = {
	overview: 'Overview',
	'getting-started': 'Getting started',
	agents: 'Agent integration',
	routing: 'Routing & fees',
	security: 'Security',
	economy: 'Economy',
	resources: 'Resources',
};

const index = [...intro];
for (const [section, list] of sections) {
	index.push(`## ${SECTION_TITLES[section] ?? section}`, '');
	for (const p of list) index.push(`- [${p.title}](${SITE}${p.path}): ${p.description}`);
	index.push('');
}
index.push('## Full text', '', `- [llms-full.txt](${SITE}/llms-full.txt): every page on this site as plain Markdown.`, '');

const full = [...intro, `Full text of every page. Canonical site: ${SITE}`, ''];
for (const p of pages) {
	full.push(`---`, '', `# ${p.title}`, '', `Source: ${SITE}${p.path}`, '');
	if (p.description) full.push(`> ${p.description}`, '');
	full.push(p.body, '');
}

mkdirSync(publicDir, { recursive: true });
writeFileSync(join(publicDir, 'llms.txt'), index.join('\n'));
writeFileSync(join(publicDir, 'llms-full.txt'), full.join('\n'));
console.log(`gen-llms: ${pages.length} pages → public/llms.txt, public/llms-full.txt`);
