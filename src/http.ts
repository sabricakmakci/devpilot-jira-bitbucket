import { l10n } from 'vscode';

const REQUEST_TIMEOUT_MS = 10000;

export class HttpError extends Error {
    constructor(readonly service: string, readonly status: number) {
        super(`${service}: HTTP ${status}`);
    }
}

export interface HttpResponse<T> {
    data: T;
    headers: Headers;
}

export interface RequestOptions {
    method?: 'GET' | 'POST' | 'PUT';
    body?: unknown;
    /** Return the body as plain text instead of parsing JSON. */
    text?: boolean;
}

export async function request<T>(
    service: string,
    url: string,
    authorization: string,
    options: RequestOptions = {},
): Promise<HttpResponse<T>> {
    const { method = 'GET', body, text = false } = options;
    const response = await fetch(url, {
        method,
        headers: {
            Authorization: authorization,
            Accept: text ? 'text/plain, */*' : 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new HttpError(service, response.status);
    }
    const content = await response.text();
    const data = text ? content : content ? JSON.parse(content) : undefined;
    return { data: data as T, headers: response.headers };
}

/**
 * Returns the https origin (plus context path) of a pasted URL. Everything from the
 * first path marker on is dropped, e.g. https://jira.example.com/browse/ABC-1.
 */
export function normalizeBaseUrl(input: string, pathMarkers: string[] = ['/browse/']): string | undefined {
    let url: URL;
    try {
        url = new URL(input.trim());
    } catch {
        return undefined;
    }
    if (url.protocol !== 'https:') {
        return undefined;
    }
    let contextPath = url.pathname;
    for (const marker of pathMarkers) {
        const index = contextPath.indexOf(marker);
        if (index >= 0) {
            contextPath = contextPath.slice(0, index);
        }
    }
    return `${url.origin}${contextPath.replace(/\/+$/, '')}`;
}

export function errorMessage(error: unknown): string {
    if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
        return l10n.t('{0} rejected the credentials (HTTP {1}). Run "{0}: Set Up Connection".', error.service, error.status);
    }
    if (error instanceof Error) {
        if (error.name === 'TimeoutError') {
            return l10n.t('The request timed out.');
        }
        return describeCauses(error);
    }
    return String(error);
}

/** fetch wraps the real failure (TLS, proxy, reset) several levels deep, so list the whole chain. */
function describeCauses(error: Error): string {
    const parts: string[] = [];
    let current: unknown = error.cause ?? error;
    for (let depth = 0; current instanceof Error && depth < 5; depth++) {
        const code = (current as { code?: unknown }).code;
        const part = typeof code === 'string' && !current.message.includes(code) ? `${current.message} [${code}]` : current.message;
        if (!parts.includes(part)) {
            parts.push(part);
        }
        current = current.cause;
    }
    return parts.join(' <- ');
}
