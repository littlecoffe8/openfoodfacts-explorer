<script lang="ts">
	import { dev, browser } from '$app/environment';
	import { _ } from '$lib/i18n';

	import {
		getExternalKnowledgePanel,
		proxyImageUrl,
		type ThirdPartySource,
		type ThirdPartyKnowledgePanelResponse
	} from '$lib/api';

	import Card from '$lib/ui/Card.svelte';
	import Panel from './Panel.svelte';

	type Props = {
		source: ThirdPartySource;
		code: string;
		lc: string;
		cc: string;
		id: string;
	};

	let { source, code, lc, cc, id }: Props = $props();

	// Chaque fournisseur tiers est fetché indépendamment côté client, après
	// hydratation : un fournisseur lent ou en panne ne doit jamais bloquer
	// le SSR ni le rendu du reste de la page produit.
	let dataPromise: Promise<ThirdPartyKnowledgePanelResponse | null> = $derived(
		browser ? getExternalKnowledgePanel(fetch, source, code, lc, cc) : Promise.resolve(null)
	);
</script>

{#await dataPromise then data}
	{#if data != null}
		{@const panel = data.panels.root}
		<div {id} data-third-party-source={source.id}>
			<Card>
				<div class="mb-3 flex items-center gap-2 border-b border-base-300 pb-2">
					{#if source.icon_url}
						<img
							src={proxyImageUrl(source.icon_url)}
							alt={source.provider_name}
							class="h-5 w-5 shrink-0 rounded-full object-contain"
							loading="lazy"
						/>
					{/if}
					<span class="text-xs text-secondary italic">
						{$_('knowledge_panel.provided_by', { values: { name: source.provider_name } })}
					</span>
					{#if source.provider_website}
						<a
							href={source.provider_website}
							target="_blank"
							rel="noopener noreferrer nofollow"
							class="ml-auto link text-xs"
						>
							{$_('knowledge_panel.view_source')}
						</a>
					{/if}
				</div>

				<Panel panels={data.panels} {panel} id={`${id}-content`} productCode={code} />
			</Card>
		</div>
	{:else if dev}
		<div class="alert alert-warning">Third party source unavailable: {source.id}</div>
	{/if}
{/await}
