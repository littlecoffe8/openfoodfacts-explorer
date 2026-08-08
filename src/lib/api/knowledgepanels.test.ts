import { describe, it, expect, vi } from 'vitest';

const mockEnv = {
	PUBLIC_OFF_BASE_URL: 'https://world.openfoodfacts.net'
};

vi.mock('$env/dynamic/public', () => ({
	get env() {
		return mockEnv;
	}
}));

// Réponse réelle de GET https://world.openfoodfacts.net/api/v3/external_sources
// (capturée le 06/08/2026).
const REAL_EXTERNAL_SOURCES_RESPONSE = {
	errors: [],
	external_sources: [
		{
			description: 'Indicator of animal suffering computed by product',
			filters: {
				categories: ['en:eggs'],
				countries: [],
				languages: [],
				product_types: ['food']
			},
			icon_url: 'https://lheuredescomptes.org/logo_ES_alpha.svg',
			id: 'empreinte_souffrance',
			knowledge_panel_url:
				'https://api.lheuredescomptes.org/off/v1/knowledge-panel/$code?lang=$lc&country=$cc',
			name: 'Suffering Footprint',
			privacy_policy_url: '',
			provider_name: "l'Heure des Comptes",
			provider_website: 'https://lheuredescomptes.org/',
			scope: 'moderators',
			section: 'animal_welfare',
			section_title: 'Animal welfare',
			user_in_scope: false
		}
	],
	result: { id: 'ok', lc_name: '', name: '' },
	status: 'success',
	warnings: []
};

// Réponse réelle (tronquée) de GET https://api.lheuredescomptes.org/off/v1/knowledge-panel/0061719011930?lang=fr&country=en
const REAL_THIRD_PARTY_PANEL_RESPONSE = {
	panels: {
		root: {
			elements: [
				{ element_type: 'text', text_element: { html: '<div>Souffrance physique</div>' } },
				{ element_type: 'panel', panel_element: { panel_id: 'project_panel' } }
			],
			level: 'info',
			title_element: {
				title: 'Welfare footprint',
				subtitle: 'What is the welfare footprint?',
				name: 'suffering-footprint',
				icon_url: 'https://iili.io/3o05WOX.png'
			},
			topics: ['suffering-footprint']
		},
		project_panel: {
			elements: [{ element_type: 'text', text_element: { html: "<div>D'où vient...</div>" } }],
			level: 'info',
			title_element: {
				title: "En savoir plus sur l'Empreinte Souffrance",
				name: 'suffering-footprint'
			},
			topics: ['suffering-footprint']
		}
	},
	product: {
		image_url:
			'https://images.openfoodfacts.org/images/products/006/171/901/1930/front_en.21.400.jpg',
		name: '12 œufs blanc calibre gros'
	}
};

describe('knowledgepanels external sources', () => {
	it('getExternalSources parses the real external_sources payload', async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve(REAL_EXTERNAL_SOURCES_RESPONSE)
		});

		const { getExternalSources } = await import('./knowledgepanels');
		const sources = await getExternalSources(fetchMock as unknown as typeof fetch);

		expect(fetchMock).toHaveBeenCalledWith(
			'https://world.openfoodfacts.net/api/v3/external_sources'
		);
		expect(sources).toHaveLength(1);
		expect(sources[0].id).toBe('empreinte_souffrance');
		expect(sources[0].provider_name).toBe("l'Heure des Comptes");
	});

	it('getExternalSources throws on a non-ok response', async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: 'Down' });

		const { getExternalSources } = await import('./knowledgepanels');
		await expect(getExternalSources(fetchMock as unknown as typeof fetch)).rejects.toThrow(/503/);
	});

	it('filterApplicableSources keeps a source whose category/product_type filters match', async () => {
		const { filterApplicableSources } = await import('./knowledgepanels');
		const sources = REAL_EXTERNAL_SOURCES_RESPONSE.external_sources;

		const kept = filterApplicableSources(sources, {
			categories_tags: ['en:eggs', 'en:fresh-eggs'],
			countries_tags: ['en:france'],
			product_type: 'food'
		});
		expect(kept).toHaveLength(1);
	});

	it('filterApplicableSources drops a source whose category filter does not match', async () => {
		const { filterApplicableSources } = await import('./knowledgepanels');
		const sources = REAL_EXTERNAL_SOURCES_RESPONSE.external_sources;

		const kept = filterApplicableSources(sources, {
			categories_tags: ['en:chocolates'],
			countries_tags: [],
			product_type: 'food'
		});
		expect(kept).toHaveLength(0);
	});

	it('filterApplicableSources drops a source whose product_type filter does not match', async () => {
		const { filterApplicableSources } = await import('./knowledgepanels');
		const sources = REAL_EXTERNAL_SOURCES_RESPONSE.external_sources;

		const kept = filterApplicableSources(sources, {
			categories_tags: ['en:eggs'],
			countries_tags: [],
			product_type: 'beauty'
		});
		expect(kept).toHaveLength(0);
	});

	it('getExternalKnowledgePanel substitutes $code/$lc/$cc and parses the real payload', async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve(REAL_THIRD_PARTY_PANEL_RESPONSE)
		});

		const { getExternalKnowledgePanel } = await import('./knowledgepanels');
		const source = REAL_EXTERNAL_SOURCES_RESPONSE.external_sources[0];

		const result = await getExternalKnowledgePanel(
			fetchMock as unknown as typeof fetch,
			source,
			'0061719011930',
			'fr',
			'en'
		);

		expect(fetchMock).toHaveBeenCalledWith(
			'https://api.lheuredescomptes.org/off/v1/knowledge-panel/0061719011930?lang=fr&country=en'
		);
		expect(result).not.toBeNull();
		expect(result?.panels.root.title_element.title).toBe('Welfare footprint');
		// L'icône du titre doit être proxifiée pour respecter la CSP img-src.
		expect(result?.panels.root.title_element.icon_url).toBe(
			'/api/image-proxy?url=' + encodeURIComponent('https://iili.io/3o05WOX.png')
		);
		// L'élément de type "panel" pointe vers "project_panel", qui doit bien
		// exister dans le même dict de panels renvoyé par le tiers.
		const secondElement = result?.panels.root.elements[1];
		expect(secondElement?.element_type).toBe('panel');
		if (secondElement?.element_type === 'panel') {
			expect(result?.panels[secondElement.panel_element.panel_id]).toBeDefined();
		}
	});

	it('proxyThirdPartyPanelImages rewrites <img src="..."> embedded in raw HTML', async () => {
		const { sanitizeThirdPartyPanelContent } = await import('./knowledgepanels');

		const panels = {
			root: {
				elements: [
					{
						element_type: 'text' as const,
						text_element: {
							html: '<div><img src="https://lheuredescomptes.org/kp/barn_icon.svg" style="height:5rem;"></div>'
						}
					}
				],
				title_element: { title: 'Test' }
			}
		};

		// @ts-expect-error - objet de test volontairement partiel
		const result = sanitizeThirdPartyPanelContent(panels);
		const html = (result.root.elements[0] as { text_element: { html: string } }).text_element.html;

		expect(html).toContain(
			'src="/api/image-proxy?url=' +
				encodeURIComponent('https://lheuredescomptes.org/kp/barn_icon.svg') +
				'"'
		);
		// L'appel d'origine ne doit pas être muté.
		expect(panels.root.elements[0].text_element.html).toContain(
			'src="https://lheuredescomptes.org/kp/barn_icon.svg"'
		);
	});

	it('sanitizeThirdPartyPanelContent strips hardcoded colors but keeps other inline styles', async () => {
		const { sanitizeThirdPartyPanelContent } = await import('./knowledgepanels');

		const panels = {
			root: {
				elements: [
					{
						element_type: 'text' as const,
						text_element: {
							html:
								'<div style="color: black; background-color: #fff; height: 5rem;">Souffrance</div>' +
								'<span bgcolor="white" color="black">legacy</span>'
						}
					}
				],
				title_element: { title: 'Test' }
			}
		};

		// @ts-expect-error - objet de test volontairement partiel
		const result = sanitizeThirdPartyPanelContent(panels);
		const html = (result.root.elements[0] as { text_element: { html: string } }).text_element.html;

		expect(html).not.toContain('color');
		expect(html).not.toContain('background');
		expect(html).not.toContain('bgcolor');
		// La propriété non liée à la couleur doit être préservée.
		expect(html).toContain('height: 5rem');
	});

	it('sanitizeThirdPartyPanelContent strips class/id and <style> blocks (prevents a third-party class from hijacking our Tailwind/daisyUI bundle, e.g. "bg-white" forcing a white panel in dark mode)', async () => {
		const { sanitizeThirdPartyPanelContent } = await import('./knowledgepanels');

		const panels = {
			root: {
				elements: [
					{
						element_type: 'text' as const,
						text_element: {
							html:
								'<style>.evil { background: red; }</style>' +
								'<div class="bg-white text-black" id="panel-1">Souffrance</div>'
						}
					}
				],
				title_element: { title: 'Test' }
			}
		};

		// @ts-expect-error - objet de test volontairement partiel
		const result = sanitizeThirdPartyPanelContent(panels);
		const html = (result.root.elements[0] as { text_element: { html: string } }).text_element.html;

		expect(html).not.toContain('<style>');
		expect(html).not.toContain('class=');
		expect(html).not.toContain('id=');
		expect(html).toContain('<div>Souffrance</div>');
	});

	it('getExternalKnowledgePanel returns null on a non-ok response instead of throwing', async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Error' });

		const { getExternalKnowledgePanel } = await import('./knowledgepanels');
		const source = REAL_EXTERNAL_SOURCES_RESPONSE.external_sources[0];

		const result = await getExternalKnowledgePanel(
			fetchMock as unknown as typeof fetch,
			source,
			'0061719011930',
			'fr',
			'en'
		);
		expect(result).toBeNull();
	});

	it('getExternalKnowledgePanel returns null when the provider is unreachable (network error)', async () => {
		const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

		const { getExternalKnowledgePanel } = await import('./knowledgepanels');
		const source = REAL_EXTERNAL_SOURCES_RESPONSE.external_sources[0];

		const result = await getExternalKnowledgePanel(
			fetchMock as unknown as typeof fetch,
			source,
			'0061719011930',
			'fr',
			'en'
		);
		expect(result).toBeNull();
	});

	it('getExternalKnowledgePanel returns null when the response has no root panel', async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ panels: {} })
		});

		const { getExternalKnowledgePanel } = await import('./knowledgepanels');
		const source = REAL_EXTERNAL_SOURCES_RESPONSE.external_sources[0];

		const result = await getExternalKnowledgePanel(
			fetchMock as unknown as typeof fetch,
			source,
			'0061719011930',
			'fr',
			'en'
		);
		expect(result).toBeNull();
	});
});
