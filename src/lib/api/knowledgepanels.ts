import { EXTERNAL_SOURCES_URL } from '$lib/const';
import type { KnowledgePanels } from '@openfoodfacts/openfoodfacts-nodejs';

export type {
	KnowledgePanel,
	KnowledgePanels,
	KnowledgePanelTitle,
	KnowledgePanelSize,
	KnowledgeElement,
	KnowledgeElementBase,
	KnowledgeTextElement,
	KnowledgeImageElement,
	KnowledgePanelGroupElement,
	KnowledgePanelImage,
	KnowledgePanelImageSize,
	KnowledgePanelElement,
	KnowledgeTableElement,
	KnowledgePanelTableRow,
	KnowledgeTableColumn,
	KnowledgeActionElement,
	KnowledgeMapElement,
	KnowledgeMapElementPointer
} from '@openfoodfacts/openfoodfacts-nodejs';

export const KNOWLEDGE_PANEL_TOPICS = ['health', 'environment', 'problem'] as const;
export type KnowledgePanelTopic = (typeof KNOWLEDGE_PANEL_TOPICS)[number];

export const KNOWLEDGE_PANEL_EVALUATIONS = [
	'good',
	'average',
	'neutral',
	'bad',
	'unknown'
] as const;
export type KnowledgePanelEvaluation = (typeof KNOWLEDGE_PANEL_EVALUATIONS)[number];

// Forme réelle de GET /api/v3/external_sources (vérifiée sur
// https://world.openfoodfacts.net/api/v3/external_sources).
export type ExternalSourceFilters = {
	categories: string[];
	countries: string[];
	languages: string[];
	product_types: string[];
};

export type ThirdPartySource = {
	id: string;
	name: string;
	description?: string;
	icon_url?: string;
	// Template d'URL avec placeholders $code, $lc, $cc à substituer par produit.
	knowledge_panel_url: string;
	provider_name: string;
	provider_website?: string;
	privacy_policy_url?: string;
	scope: string;
	section: string;
	section_title: string;
	user_in_scope: boolean;
	filters: ExternalSourceFilters;
};

export type ExternalSourcesResponse = {
	external_sources: ThirdPartySource[];
	status: string;
	errors: unknown[];
	warnings: unknown[];
};

/**
 * Récupère la liste des fournisseurs tiers de knowledge panels déclarés
 * auprès de Product Opener (GET /api/v3/external_sources).
 */
export async function getExternalSources(fetch: typeof window.fetch): Promise<ThirdPartySource[]> {
	const response = await fetch(EXTERNAL_SOURCES_URL);
	if (!response.ok) {
		throw new Error(`Failed to fetch external sources: ${response.status} ${response.statusText}`);
	}
	const data = (await response.json()) as ExternalSourcesResponse;
	return data.external_sources;
}

/**
 * Ne garde que les sources dont les filtres (catégorie, pays, type de
 * produit) correspondent au produit affiché.
 */
export function filterApplicableSources(
	sources: ThirdPartySource[],
	product: { categories_tags?: string[]; countries_tags?: string[]; product_type?: string }
): ThirdPartySource[] {
	return sources.filter(({ filters }) => {
		if (
			filters.categories.length > 0 &&
			!filters.categories.some((c) => product.categories_tags?.includes(c))
		) {
			return false;
		}
		if (
			filters.countries.length > 0 &&
			!filters.countries.some((c) => product.countries_tags?.includes(c))
		) {
			return false;
		}
		if (
			filters.product_types.length > 0 &&
			product.product_type &&
			!filters.product_types.includes(product.product_type)
		) {
			return false;
		}
		return true;
	});
}

/**
 * Fait passer une URL d'image externe par notre proxy serveur
 * (/api/image-proxy) pour qu'elle respecte la CSP `img-src 'self'` sans
 * avoir à ajouter des domaines tiers imprévisibles à la CSP globale.
 */
export function proxyImageUrl(imageUrl: string): string {
	return `/api/image-proxy?url=${encodeURIComponent(imageUrl)}`;
}

const HTML_IMG_SRC_RE = /(<img[^>]*\ssrc=["'])(https:\/\/[^"']+)(["'])/gi;

// Propriétés CSS de couleur retirées des styles inline du HTML tiers, pour
// que le texte/fond hérite toujours du thème (clair/sombre) de l'explorer
// plutôt que des couleurs codées en dur par le fournisseur.
const COLOR_STYLE_PROP_NAMES = new Set([
	'color',
	'background',
	'background-color',
	'border-color',
	'border-top-color',
	'border-right-color',
	'border-bottom-color',
	'border-left-color'
]);

function stripUncontrolledStyling(html: string): string {
	return (
		html
			// Blocs <style>...</style> entiers : pourraient définir des règles
			// CSS globales (par tag/id) qui débordent du panel.
			.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
			// Neutralise uniquement les propriétés de couleur dans les styles
			// inline, en gardant le reste (dimensions, marges...).
			.replace(/\sstyle\s*=\s*(["'])(.*?)\1/gi, (match, quote, styleContent: string) => {
				const cleaned = styleContent
					.split(';')
					.map((decl) => decl.trim())
					.filter((decl) => {
						if (!decl) return false;
						const prop = decl.split(':')[0]?.trim().toLowerCase();
						return !COLOR_STYLE_PROP_NAMES.has(prop);
					})
					.join('; ');
				return cleaned ? ` style=${quote}${cleaned}${quote}` : '';
			})
			// Attributs HTML legacy de couleur.
			.replace(/\s(?:bgcolor|color)\s*=\s*["'][^"']*["']/gi, '')
			// class/id retirés entièrement : un nom de classe tiers pourrait
			// accidentellement matcher une classe Tailwind/daisyUI déjà
			// présente dans notre bundle CSS (ex: "bg-white") et casser le
			// mode sombre. On ne peut pas se contenter d'une liste noire de
			// noms de classes, donc on retire l'attribut en entier : le
			// contenu tiers doit être stylé uniquement via le `style` inline
			// (hors couleurs) ou hériter du thème par défaut.
			.replace(/\s(?:class|id)\s*=\s*["'][^"']*["']/gi, '')
	);
}

/**
 * Réécrit toutes les URLs d'images externes trouvées dans un dict de
 * knowledge panels tiers (icônes de titre, éléments image, et balises
 * <img> embarquées dans du HTML brut) pour qu'elles passent par le proxy,
 * et neutralise tout ce qui pourrait imposer une couleur/fond codé en dur
 * (styles inline de couleur, attributs bgcolor/color legacy, class/id, et
 * blocs <style>) pour que le contenu tiers hérite toujours du thème
 * clair/sombre de l'explorer plutôt que de celui du fournisseur.
 * Ne modifie jamais l'objet d'origine.
 */
export function sanitizeThirdPartyPanelContent(panels: KnowledgePanels): KnowledgePanels {
	const result: KnowledgePanels = {};

	for (const [id, panel] of Object.entries(panels)) {
		result[id] = {
			...panel,
			title_element: panel.title_element?.icon_url
				? { ...panel.title_element, icon_url: proxyImageUrl(panel.title_element.icon_url) }
				: panel.title_element,
			elements: panel.elements?.map((element) => {
				if (element.element_type === 'image') {
					return {
						...element,
						image_element: {
							...element.image_element,
							url: proxyImageUrl(element.image_element.url)
						}
					};
				}
				if (element.element_type === 'text') {
					const withProxiedImages = element.text_element.html.replace(
						HTML_IMG_SRC_RE,
						(_match, pre, src, post) => `${pre}${proxyImageUrl(src)}${post}`
					);
					return {
						...element,
						text_element: {
							...element.text_element,
							html: stripUncontrolledStyling(withProxiedImages)
						}
					};
				}
				return element;
			})
		};
	}

	return result;
}

/**
 * Remplace l'origine (protocole+host+port) de `knowledge_panel_url`,
 * `icon_url` et `provider_website` par une origine locale, en conservant
 * le chemin/query. Utile pour tester un mock local du JSON tiers sans
 * dépendre du vrai serveur du fournisseur.
 *
 * ⚠️ Réservé au dev : ne jamais appeler ceci en production. L'appelant
 * (+page.ts) doit garder l'appel derrière `if (dev && ...)`.
 */
export function overrideThirdPartySourceOrigin(
	sources: ThirdPartySource[],
	devOrigin: string
): ThirdPartySource[] {
	const replaceOrigin = (value: string | undefined) => {
		if (!value) return value;
		try {
			const original = new URL(value);
			const replaced = new URL(devOrigin);
			original.protocol = replaced.protocol;
			original.host = replaced.host;
			return original.toString();
		} catch {
			return value;
		}
	};

	return sources.map((source) => ({
		...source,
		knowledge_panel_url: replaceOrigin(source.knowledge_panel_url) ?? source.knowledge_panel_url,
		icon_url: replaceOrigin(source.icon_url),
		provider_website: replaceOrigin(source.provider_website)
	}));
}

function buildExternalKnowledgePanelUrl(
	source: ThirdPartySource,
	code: string,
	lc: string,
	cc: string
): string {
	return source.knowledge_panel_url
		.replace('$code', encodeURIComponent(code))
		.replace('$lc', encodeURIComponent(lc))
		.replace('$cc', encodeURIComponent(cc));
}

// Forme réelle de la réponse d'un fournisseur tiers, vérifiée sur
// https://api.lheuredescomptes.org/off/v1/knowledge-panel/{code}?lang=..&country=..
// C'est un dict de panels (comme knowledge_panels sur un produit OFF), avec
// toujours une entrée "root" comme point d'entrée.
export type ThirdPartyKnowledgePanelResponse = {
	panels: KnowledgePanels;
	product?: {
		name?: string;
		image_url?: string;
	};
};

/**
 * Va chercher les panels chez le fournisseur tiers pour un produit donné.
 * Ne doit jamais faire planter la page produit : un fournisseur tiers en
 * panne, injoignable, ou qui répond n'importe quoi renvoie simplement `null`.
 */
export async function getExternalKnowledgePanel(
	fetch: typeof window.fetch,
	source: ThirdPartySource,
	code: string,
	lc: string,
	cc: string
): Promise<ThirdPartyKnowledgePanelResponse | null> {
	const url = buildExternalKnowledgePanelUrl(source, code, lc, cc);
	try {
		const response = await fetch(url);
		if (!response.ok) return null;
		const data = (await response.json()) as ThirdPartyKnowledgePanelResponse;
		if (data.panels?.root == null) return null;
		return { ...data, panels: sanitizeThirdPartyPanelContent(data.panels) };
	} catch {
		return null;
	}
}
