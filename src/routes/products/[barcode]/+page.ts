import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';

import { dev } from '$app/environment';
import { env as publicEnv } from '$env/dynamic/public';

import { PricesApi } from '@openfoodfacts/openfoodfacts-nodejs';

import { createProductsApi } from '$lib/api';

import { get } from 'svelte/store';
import { preferences } from '$lib/settings';
import { createFolksonomyApi, isConfigured as isFolksonomyConfigured } from '$lib/api/folksonomy';
import { createPricesApi, isConfigured as isPriceConfigured } from '$lib/api/prices';
import { attributesToDefaultPreferences, type AttributeGroup } from '$lib/stores/preferencesStore';
import {
	ERR_INVALID_BARCODE,
	ERR_PRODUCT_NOT_FOUND,
	type ProductStateResponse
} from '$lib/api/errorUtils';
import {
	getExternalSources,
	filterApplicableSources,
	overrideThirdPartySourceOrigin
} from '$lib/api/knowledgepanels';

async function getPricesCoords(api: PricesApi, code: string) {
	// load all prices coordinates
	const { data, error } = await api.getPrices({ product_code: code });
	if (error != null) throw new Error('Error fetching first page.');

	const { items, pages } = data;

	const prices = [...items.flat()];
	for (let page = 2; page <= pages; page++) {
		const res = await api.getPrices({ product_code: code, page: page });
		if (res.error != null) throw new Error(`Error fetching page ${page}.`);
		prices.push(...res.data.items.flat());
	}

	return prices;
}

function handleProductApiError(apiErrorWrapped: ProductStateResponse | null | undefined) {
	if (!apiErrorWrapped) return;

	const err = apiErrorWrapped as ProductStateResponse;
	const isInvalidFormat = err.errors?.some((e) => e.message?.id === 'invalid_code');
	// FIXME: This is a workaround until the SDK or API returns cleaner data.
	const cleanErrors = err.errors?.map((e) => ({
		...e,
		field: e.field ? { ...e.field, value: e.field.value ?? undefined } : undefined
	}));

	if (isInvalidFormat) {
		error(400, {
			message: ERR_INVALID_BARCODE,
			errors: cleanErrors
		});
	}

	if (err.result?.id === 'product_not_found') {
		error(404, {
			message: ERR_PRODUCT_NOT_FOUND,
			errors: cleanErrors
		});
	}

	error(500, {
		message: 'Server Error',
		errors: cleanErrors
	});
}

export const load: PageLoad = async ({ params, fetch }) => {
	const productsApi = createProductsApi(fetch);
	const folkApi = createFolksonomyApi(fetch);

	const userLang = get(preferences).lang;
	const lc = userLang || 'en';

	const { data: state, error: apiErrorWrapped } = await productsApi.getProductV3(params.barcode, {
		product_type: 'all',
		fields: [
			'all',
			'knowledge_panels',
			`categories_tags_${lc}`,
			`brands_tags_${lc}`,
			`labels_tags_${lc}`,
			`origins_tags_${lc}`,
			`stores_tags_${lc}`,
			`countries_tags_${lc}`
		],
		// @ts-expect-error - This is a temporary workaround until the SDK supports this parameter.
		knowledge_panels_client: 'web',
		lc
	});

	handleProductApiError(apiErrorWrapped);

	if (!state) {
		error(500, {
			message: 'Unable to connect to Open Food Facts API',
			errors: []
		});
	}

	if (state.status === 'failure') {
		error(404, {
			message: 'Failure to load product',
			errors: state.errors
		});
	}

	const folksonomyTags = isFolksonomyConfigured()
		? folkApi.getProductTags(params.barcode).then((it) => it.data ?? [])
		: Promise.resolve([]);

	const folksonomyKeys = isFolksonomyConfigured()
		? folkApi.getKeys().then((it) => it.data)
		: Promise.resolve([]);

	const pricesApi = createPricesApi(fetch);
	const pricesResponse = isPriceConfigured()
		? getPricesCoords(pricesApi, params.barcode)
		: Promise.resolve(null);

	const defaultPreferences = (async () => {
		const { data: attributeGroups } = await productsApi.getAttributeGroups();
		// FIXME: Remove cast when SDK fixes ids type being string | undefined
		const attributeGroupsList = (attributeGroups ?? []) as AttributeGroup[];
		return attributesToDefaultPreferences(attributeGroupsList);
	})();

	// Un fournisseur tiers indisponible ou une réponse inattendue ne doit
	// jamais faire échouer le chargement de la page produit : on retombe sur
	// une liste vide (aucun knowledge panel tiers affiché) en cas d'erreur.
	const thirdPartySources = await getExternalSources(fetch)
		.then((sources) =>
			filterApplicableSources(sources, {
				categories_tags: state.product?.categories_tags,
				countries_tags: state.product?.countries_tags,
				product_type: state.product?.product_type
			})
		)
		.then((sources) => {
			// Dev only: permet de rediriger les sources tierces vers un mock
			// local (ex: PUBLIC_THIRD_PARTY_DEV_ORIGIN=http://127.0.0.1:8000)
			// pour tester une modification du JSON tiers sans dépendre du
			// vrai serveur du fournisseur. Jamais actif en production.
			if (dev && publicEnv.PUBLIC_THIRD_PARTY_DEV_ORIGIN) {
				return overrideThirdPartySourceOrigin(sources, publicEnv.PUBLIC_THIRD_PARTY_DEV_ORIGIN);
			}
			return sources;
		})
		.catch(() => []);

	return {
		state,
		lc,
		thirdPartySources,
		defaultProductPreferences: await defaultPreferences,
		tags: await folksonomyTags,
		keys: await folksonomyKeys,
		prices: await pricesResponse
	};
};
