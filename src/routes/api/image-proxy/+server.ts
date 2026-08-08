import { error } from '@sveltejs/kit';
import { dev } from '$app/environment';
import type { RequestHandler } from './$types';

const ALLOWED_CONTENT_TYPES = new Set([
	'image/png',
	'image/jpeg',
	'image/gif',
	'image/webp',
	'image/svg+xml',
	'image/avif'
]);

const MAX_BYTES = 5 * 1024 * 1024; // 5 Mo

// Bloque les hôtes privés/locaux pour éviter le SSRF via ce proxy.
function isDisallowedHostname(hostname: string): boolean {
	if (hostname === 'localhost' || hostname === '0.0.0.0') return true;

	const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (ipv4) {
		const [a, b] = ipv4.slice(1).map(Number);
		if (a === 10 || a === 127 || a === 0) return true;
		if (a === 169 && b === 254) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 168) return true;
	}

	return false;
}

/**
 * Sert une image externe (icône de fournisseur tiers, image embarquée dans
 * un knowledge panel tiers...) depuis notre propre domaine, pour qu'elle
 * respecte la Content-Security-Policy `img-src 'self'` sans avoir à
 * l'élargir à des domaines tiers imprévisibles.
 *
 * GET /api/image-proxy?url=https://example.com/logo.svg
 */
export const GET: RequestHandler = async ({ url, fetch }) => {
	const target = url.searchParams.get('url');
	if (!target) {
		error(400, 'Missing url parameter');
	}

	let parsed: URL;
	try {
		parsed = new URL(target);
	} catch {
		error(400, 'Invalid url parameter');
	}

	if (parsed.protocol !== 'https:' && !(dev && parsed.protocol === 'http:')) {
		error(400, 'Only https:// URLs are allowed');
	}
	// En dev, on autorise les hôtes locaux/privés pour pouvoir mocker un
	// fournisseur tiers en local (voir PUBLIC_THIRD_PARTY_DEV_ORIGIN). Cette
	// protection anti-SSRF reste stricte en production.
	if (!dev && isDisallowedHostname(parsed.hostname)) {
		error(400, 'This host is not allowed');
	}

	let response: Response;
	try {
		response = await fetch(parsed.toString(), {
			headers: { 'User-Agent': 'openfoodfacts-explorer-image-proxy' }
		});
	} catch {
		error(502, 'Unable to reach the remote image');
	}

	if (!response.ok) {
		error(502, `Remote image responded with ${response.status}`);
	}

	const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
	if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
		error(415, `Unsupported content type: ${contentType || 'unknown'}`);
	}

	const body = await response.arrayBuffer();
	if (body.byteLength > MAX_BYTES) {
		error(413, 'Image too large');
	}

	return new Response(body, {
		headers: {
			'Content-Type': contentType,
			'Cache-Control': 'public, max-age=3600',
			'Content-Length': String(body.byteLength)
		}
	});
};
