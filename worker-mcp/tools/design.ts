import type { McpTool } from '../../worker/agents/universal/mcp/types';
import type { ToolServerEnv } from '../env';

export const TOOL_DEFINITIONS: McpTool[] = [
	{
		name: 'get_design_system',
		description:
			'Return the Cloudflare brand design system tokens — colors, gradients, typography, CSS variables, Tailwind config, and component patterns. ' +
			'Use when generating websites, web pages, or any frontend UI to apply Cloudflare visual style.',
		inputSchema: {
			type: 'object',
			properties: {
				style: {
					type: 'string',
					description: 'Design style variant. Options: "cf2026" (Cloudflare Corporate, default), "workers-dev" (warm cream/orange workers.cloudflare.com style).',
					enum: ['cf2026', 'workers-dev'],
				},
			},
			required: [],
		},
	},
];

// Cloudflare 2026 Corporate design system extracted from official brand guide
const CF2026_SYSTEM = {
	style: 'Cloudflare 2026 Corporate',
	brand_rule: 'Tangerine (#F6821F) MUST appear in every layout as the primary brand color.',
	colors: {
		primary: {
			tangerine: '#F6821F',
			ruby: '#FF6633',
			mango: '#FBAD41',
			white: '#FFFFFF',
		},
		secondary: {
			lemon: '#FFD43C',
			blueberry: '#3E74FF',
			raspberry: '#CE2F55',
			blackberry: '#0F006B',
			cherry: '#960C3E',
		},
		semantic: {
			text: '#000000',
			success: '#57CF7D',
			danger: '#FC3D2E',
			muted: '#747474',
			border: '#DFDFDF',
		},
		light: {
			orange: '#FFE9CB',
			blue: '#E0ECFF',
			blue2: '#A8CBFF',
		},
	},
	gradients: {
		dawn: 'linear-gradient(to right, #FF6633, #F6821F, #FBAD41)',
		dawn_vertical: 'linear-gradient(to bottom, #FF6633, #F6821F, #FBAD41)',
		dawn_diagonal: 'linear-gradient(135deg, #FF6633, #F6821F, #FBAD41)',
	},
	typography: {
		font_family: '"Inter", system-ui, -apple-system, sans-serif',
		weights: { regular: 400, medium: 500, semibold: 600, bold: 700 },
		scale: {
			hero: { size: '2.375rem', weight: 600, tracking: '-0.03em', lineHeight: '1.1' },
			heading: { size: '1.375rem', weight: 600, tracking: '-0.03em', lineHeight: '1.2' },
			subheading: { size: '1.125rem', weight: 500, tracking: '-0.02em', lineHeight: '1.3' },
			eyebrow: { size: '0.5625rem', weight: 600, tracking: '0.05em', transform: 'uppercase', color: '#FF6633' },
			body: { size: '1.0625rem', weight: 400, tracking: '-0.02em', lineHeight: '1.5' },
			small: { size: '0.875rem', weight: 400, tracking: '-0.01em', lineHeight: '1.5' },
		},
		rules: [
			'Never use font weight below 400 (no Light or Thin).',
			'Eyebrow text above headings: ALWAYS Ruby #FF6633, ALL CAPS, font-weight 600.',
			'Cover/hero titles use SemiBold (600). Body text uses Regular (400).',
			'Default text alignment is left.',
		],
	},
	tailwind_extend: {
		colors: {
			'cf-tangerine': '#F6821F',
			'cf-ruby': '#FF6633',
			'cf-mango': '#FBAD41',
			'cf-lemon': '#FFD43C',
			'cf-blueberry': '#3E74FF',
			'cf-raspberry': '#CE2F55',
			'cf-blackberry': '#0F006B',
			'cf-orange-light': '#FFE9CB',
			'cf-blue-light': '#E0ECFF',
			'cf-success': '#57CF7D',
			'cf-danger': '#FC3D2E',
			'cf-muted': '#747474',
			'cf-border': '#DFDFDF',
		},
		fontFamily: {
			sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
		},
	},
	css_variables: `
:root {
  --cf-tangerine: #F6821F;
  --cf-ruby: #FF6633;
  --cf-mango: #FBAD41;
  --cf-lemon: #FFD43C;
  --cf-blueberry: #3E74FF;
  --cf-orange-light: #FFE9CB;
  --cf-blue-light: #E0ECFF;
  --cf-success: #57CF7D;
  --cf-danger: #FC3D2E;
  --cf-muted: #747474;
  --cf-border: #DFDFDF;
  --cf-gradient-dawn: linear-gradient(to right, #FF6633, #F6821F, #FBAD41);
  --font-inter: "Inter", system-ui, -apple-system, sans-serif;
}`,
	design_rules: [
		'Tangerine (#F6821F) MUST appear in every page as the primary brand accent — buttons, links, highlights, borders, or section headers.',
		'Black (#000000) is for body text only. Never use as a background or decorative fill.',
		'Use ample white space. Clean, minimal layouts with strong typographic hierarchy.',
		'Apply the Dawn gradient (linear-gradient(to right, #FF6633, #F6821F, #FBAD41)) to hero sections, section dividers, and gradient bars.',
		'Eyebrow text above headings: Ruby #FF6633, ALL CAPS, letter-spacing 0.05em, font-weight 600.',
		'Inter font only. Weights: 400/500/600/700. Never use 300 or lighter.',
		'Secondary colors (blueberry #3E74FF, raspberry #CE2F55) are for data visualization and diagrams only.',
		'Buttons: background #F6821F, text white, font-weight 600, border-radius 4px. Hover: darken by ~10%.',
		'Links: color #3E74FF (blueberry), underline on hover.',
	],
	web_patterns: {
		hero_section:
			'Full-width section with Dawn gradient background or dark #1D1D1B. Large white headline (SemiBold 600). ' +
			'Orange eyebrow label above headline. White/light subheading. Tangerine CTA button. ' +
			'Optional: subtle flare arc decoration (orange translucent circle cropped at edge).',
		navbar:
			'White background, Cloudflare horizontal logo on left (logomark + wordmark). Nav links in Inter Regular 400. ' +
			'Tangerine #F6821F highlight on active/hover. Right side: CTA button (bg #F6821F, text white).',
		stats_row:
			'3–4 large Tangerine #F6821F numbers (font-size 3rem, font-weight 700) with white/dark body labels below. ' +
			'Horizontal layout with dividers. White or near-white background.',
		feature_grid:
			'3-column responsive grid. Each card: CF icon (SVG), bold heading (SemiBold), body text (Regular). ' +
			'Subtle border (#DFDFDF) or shadow. Tangerine left-border accent on hover.',
		section_divider:
			'4–8px Dawn gradient bar (linear-gradient to right: #FF6633, #F6821F, #FBAD41), full width. ' +
			'Or a full-bleed orange section separating content blocks.',
		code_block:
			'Dark background (#1D1D1B or #0F0F0F). Monospace font. Tangerine for highlights and syntax accents. ' +
			'Rounded corners (border-radius 8px). Subtle orange top-border.',
		card:
			'White background, 1px solid #DFDFDF border, border-radius 8px, padding 24px. ' +
			'Heading in SemiBold. Body in Regular #747474. Bottom link in Tangerine #F6821F.',
		cta_button:
			'Primary: background #F6821F, color white, font-weight 600, padding 12px 24px, border-radius 4px. ' +
			'Ghost: border 2px solid #F6821F, color #F6821F, transparent background.',
		footer:
			'Dark background (#1D1D1B). White horizontal Cloudflare logo. White text for links. ' +
			'Section headers in Tangerine #F6821F. Bottom copyright in #747474.',
	},
};

// workers.cloudflare.com style — warm cream palette
const WORKERS_DEV_SYSTEM = {
	style: 'Cloudflare Workers.dev',
	brand_rule: 'Warm cream/orange palette. Light backgrounds with bold orange accents.',
	colors: {
		primary: {
			orange: '#F6821F',
			orange_bright: '#FF6633',
			cream: '#FFF8F0',
			dark: '#1D1D1B',
		},
		accents: {
			orange_light: '#FFE9CB',
			orange_muted: '#FBAD41',
			blue: '#3E74FF',
		},
		semantic: {
			text: '#1D1D1B',
			text_muted: '#747474',
			background: '#FAFAFA',
			border: '#E5E5E5',
		},
	},
	gradients: {
		warm: 'linear-gradient(135deg, #FFF8F0 0%, #FFE9CB 100%)',
		orange: 'linear-gradient(to right, #F6821F, #FBAD41)',
		hero: 'linear-gradient(135deg, #FF6633 0%, #F6821F 50%, #FBAD41 100%)',
	},
	typography: {
		font_family: '"Inter", system-ui, -apple-system, sans-serif',
		weights: { regular: 400, medium: 500, semibold: 600, bold: 700 },
		scale: {
			hero: { size: '3rem', weight: 700, tracking: '-0.04em', lineHeight: '1.05' },
			heading: { size: '1.75rem', weight: 700, tracking: '-0.03em', lineHeight: '1.15' },
			body: { size: '1.0625rem', weight: 400, lineHeight: '1.6' },
		},
	},
	design_rules: [
		'Cream/warm white (#FFF8F0) as page background gives a warm, approachable feel.',
		'Orange (#F6821F) for primary CTAs, highlights, and accent borders.',
		'Dark (#1D1D1B) for text and headings — never pure black backgrounds.',
		'Large, bold typography with tight tracking for hero headlines.',
		'Cards with cream background and subtle orange accent border.',
	],
};

export async function executeTool(
	name: string,
	args: Record<string, unknown>,
	_env: ToolServerEnv,
): Promise<string> {
	switch (name) {
		case 'get_design_system': {
			const style = typeof args.style === 'string' ? args.style : 'cf2026';
			const system = style === 'workers-dev' ? WORKERS_DEV_SYSTEM : CF2026_SYSTEM;
			return JSON.stringify(system);
		}
		default:
			throw new Error(`design: unknown tool ${name}`);
	}
}
