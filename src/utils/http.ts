import { requestUrl } from 'obsidian';

// fetch() replacement for API SDKs. Goes through Obsidian's requestUrl, which is not
// subject to browser CORS rules (the renderer's fetch can be blocked for API hosts).
export async function obsidianFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
        if (key !== 'content-length') headers[key] = value;
    });
    const res = await requestUrl({
        url,
        method: init?.method ?? 'GET',
        headers,
        body: typeof init?.body === 'string' ? init.body : undefined,
        throw: false,
    });
    return new Response(res.arrayBuffer, { status: res.status, headers: res.headers });
}
