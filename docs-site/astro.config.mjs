// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';


// https://astro.build/config
export default defineConfig({
  site: 'https://docs.potswap.io',
  output: 'static',

  integrations: [
      starlight({
          title: 'Potswap Docs',
          description: 'Solana DeFi infrastructure for AI agents: best-route swaps, strategies and POT rewards through one non-custodial MCP server.',
          social: [
              { icon: 'seti:npm', label: 'npm', href: 'https://www.npmjs.com/package/@potswap_io/mcp' },
              { icon: 'external', label: 'potswap.io', href: 'https://www.potswap.io' },
          ],
          lastUpdated: false,
          head: [
              { tag: 'link', attrs: { rel: 'alternate', type: 'text/plain', title: 'llms.txt', href: '/llms.txt' } },
          ],
          sidebar: [
              {
                  label: 'Getting started',
                  items: [
                      { label: 'Introduction', slug: 'getting-started/introduction' },
                      { label: 'Quickstart', slug: 'getting-started/quickstart' },
                      { label: 'Troubleshooting', slug: 'getting-started/troubleshooting' },
                  ],
              },
              {
                  label: 'Agent integration',
                  items: [
                      { label: 'MCP tools reference', slug: 'agents/mcp-tools' },
                      { label: 'Strategies', slug: 'agents/strategies' },
                      { label: 'Configuration', slug: 'agents/configuration' },
						{ label: 'SDK (@potswap_io/sdk)', slug: 'agents/sdk' },
						{ label: 'CLI (potswap)', slug: 'agents/cli' },
						{ label: 'Observations', slug: 'agents/observations' },
						{ label: 'Lending and liquidity', slug: 'agents/defi' },
                  ],
              },
              {
                  label: 'Routing & fees',
                  items: [
                      { label: 'How routing works', slug: 'routing/how-routing-works' },
                      { label: 'Fees', slug: 'routing/fees' },
                      { label: 'Direct DEX routing', slug: 'routing/direct-dex-roadmap' },
                  ],
              },
              {
                  label: 'Security',
                  items: [
                      { label: 'Non-custodial by design', slug: 'security/non-custodial' },
                      { label: 'Limits and policies', slug: 'security/limits-and-policies' },
                      { label: 'Key handling', slug: 'security/key-handling' },
                  ],
              },
              {
                  label: 'Economy',
                  items: [
                      { label: 'Points and POT', slug: 'economy/points-and-pot' },
                      { label: 'Launch meter', slug: 'economy/launch-meter' },
                  ],
              },
              {
                  label: 'Resources',
                  items: [
                      { label: 'FAQ', slug: 'resources/faq' },
                      { label: 'Changelog', slug: 'resources/changelog' },
                      { label: 'Roadmap', slug: 'resources/roadmap' },
                      { label: 'License', slug: 'resources/license' },
                  ],
              },
          ],
      }),
	],
});