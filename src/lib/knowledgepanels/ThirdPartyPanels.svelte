<script lang="ts">
	import type { ThirdPartySource } from '$lib/api';
	import ThirdPartyPanel from './ThirdPartyPanel.svelte';

	type Props = {
		sources: ThirdPartySource[];
		code: string;
		lc: string;
		cc: string;
	};

	let { sources, code, lc, cc }: Props = $props();
</script>

{#each sources as source (source.id)}
	<div class="mt-4">
		<ThirdPartyPanel {source} {code} {lc} {cc} id={`kp-third-party-${source.id}`} />
	</div>
{/each}
