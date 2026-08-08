import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockEnv = { dev: true };

vi.mock('$app/environment', () => ({
	get dev() {
		return mockEnv.dev;
	}
}));

async function callGet(targetUrl: string | null, fetchImpl: typeof fetch) {
	const { GET } = await import('./+server');

	const requestUrl = new URL(
		targetUrl != null
			? `http://localhost/api/image-proxy?url=${encodeURIComponent(targetUrl)}`
			: 'http://localhost/api/image-proxy'
	);

	const event = {
		url: requestUrl,
		fetch: fetchImpl
	} as unknown as Parameters<typeof GET>[0];

	try {
		const response = await GET(event);
		return { response, thrown: null as unknown };
	} catch (thrown) {
		return { response: null, thrown };
	}
}

function svgResponse(body: string, contentType = 'image/svg+xml') {
	return {
		ok: true,
		status: 200,
		headers: {
			get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null)
		},
		arrayBuffer: async () => new TextEncoder().encode(body).buffer
	} as unknown as Response;
}

describe('GET /api/image-proxy', () => {
	beforeEach(() => {
		vi.resetModules();
		mockEnv.dev = true;
	});

	it('rejects a missing url parameter', async () => {
		const fetchMock = vi.fn();
		const { thrown } = await callGet(null, fetchMock as unknown as typeof fetch);
		expect(thrown).toMatchObject({ status: 400 });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('proxies a valid https image and forwards content-type', async () => {
		const fetchMock = vi.fn().mockResolvedValue(svgResponse('<svg></svg>'));
		const { response, thrown } = await callGet(
			'https://lheuredescomptes.org/logo_ES_alpha.svg',
			fetchMock as unknown as typeof fetch
		);

		expect(thrown).toBeNull();
		expect(fetchMock).toHaveBeenCalledWith(
			'https://lheuredescomptes.org/logo_ES_alpha.svg',
			expect.any(Object)
		);
		expect(response?.status).toBe(200);
		expect(response?.headers.get('content-type')).toBe('image/svg+xml');
		expect(await response?.text()).toBe('<svg></svg>');
	});

	it('rejects a disallowed content type', async () => {
		const fetchMock = vi.fn().mockResolvedValue(svgResponse('<html></html>', 'text/html'));
		const { thrown } = await callGet(
			'https://lheuredescomptes.org/not-an-image',
			fetchMock as unknown as typeof fetch
		);
		expect(thrown).toMatchObject({ status: 415 });
	});

	it('rejects an oversized image', async () => {
		const bigBody = 'x'.repeat(6 * 1024 * 1024);
		const fetchMock = vi.fn().mockResolvedValue(svgResponse(bigBody));
		const { thrown } = await callGet(
			'https://lheuredescomptes.org/huge.svg',
			fetchMock as unknown as typeof fetch
		);
		expect(thrown).toMatchObject({ status: 413 });
	});

	it('returns 502 when the upstream host is unreachable', async () => {
		const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
		const { thrown } = await callGet(
			'https://lheuredescomptes.org/logo.svg',
			fetchMock as unknown as typeof fetch
		);
		expect(thrown).toMatchObject({ status: 502 });
	});

	it('returns 502 when the upstream responds with an error status', async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
		const { thrown } = await callGet(
			'https://lheuredescomptes.org/missing.svg',
			fetchMock as unknown as typeof fetch
		);
		expect(thrown).toMatchObject({ status: 502 });
	});

	describe('production (dev = false)', () => {
		beforeEach(() => {
			mockEnv.dev = false;
		});

		it('rejects a non-https url', async () => {
			const fetchMock = vi.fn();
			const { thrown } = await callGet(
				'http://lheuredescomptes.org/logo.svg',
				fetchMock as unknown as typeof fetch
			);
			expect(thrown).toMatchObject({ status: 400 });
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it('rejects private/local hostnames (SSRF protection)', async () => {
			const fetchMock = vi.fn();
			for (const target of [
				'https://localhost/secret',
				'https://127.0.0.1/secret',
				'https://192.168.1.1/secret',
				'https://10.0.0.5/secret'
			]) {
				const { thrown } = await callGet(target, fetchMock as unknown as typeof fetch);
				expect(thrown, target).toMatchObject({ status: 400 });
			}
			expect(fetchMock).not.toHaveBeenCalled();
		});
	});

	describe('development (dev = true)', () => {
		it('allows http:// and localhost, to support a local mock third-party server', async () => {
			const fetchMock = vi.fn().mockResolvedValue(svgResponse('<svg></svg>'));
			const { thrown } = await callGet(
				'http://127.0.0.1:8000/logo.svg',
				fetchMock as unknown as typeof fetch
			);
			expect(thrown).toBeNull();
			expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8000/logo.svg', expect.any(Object));
		});
	});
});
