import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { errorMessage, normalizeBaseUrl } from '../http';
import { BitbucketCloudApi } from './cloud';
import { BbUser, BitbucketApi } from './model';
import { BitbucketServerApi } from './server';

export const BITBUCKET_TOKEN_SECRET = 'jiraBitbucketFlow.bitbucketToken';
const CLOUD_URL = 'https://bitbucket.org';
/** Pasted repository or pull request links are cut at the first of these. */
const URL_MARKERS = ['/projects/', '/scm/', '/users/', '/dashboard', '/plugins/', '/rest/'];

function isCloudUrl(baseUrl: string): boolean {
    return ['bitbucket.org', 'www.bitbucket.org', 'api.bitbucket.org'].includes(new URL(baseUrl).hostname);
}

function normalize(input: string): string | undefined {
    const url = normalizeBaseUrl(input, URL_MARKERS);
    return url && isCloudUrl(url) ? CLOUD_URL : url;
}

export class BitbucketConnection {
    private cached?: BitbucketApi;
    private cachedUser?: Promise<BbUser>;

    constructor(private readonly secrets: vscode.SecretStorage) { }

    private get config(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration('jiraBitbucketFlow.bitbucket');
    }

    get baseUrl(): string | undefined {
        return normalize(this.config.get<string>('baseUrl', ''));
    }

    reset(): void {
        this.cached = undefined;
        this.cachedUser = undefined;
    }

    /** The signed-in user, or undefined while the connection is not set up. */
    async user(): Promise<BbUser | undefined> {
        const api = await this.api();
        if (!api) {
            return undefined;
        }
        this.cachedUser ??= api.me().catch(error => {
            this.cachedUser = undefined;
            throw error;
        });
        return this.cachedUser;
    }

    async logout(): Promise<void> {
        await this.secrets.delete(BITBUCKET_TOKEN_SECRET);
        this.reset();
    }

    /** Returns undefined while the connection is not set up. */
    async api(): Promise<BitbucketApi | undefined> {
        if (!this.cached) {
            const baseUrl = this.baseUrl;
            const token = await this.secrets.get(BITBUCKET_TOKEN_SECRET);
            if (!baseUrl || !token) {
                return undefined;
            }
            this.cached = baseUrl === CLOUD_URL
                ? new BitbucketCloudApi(this.config.get<string>('email', '').trim(), token)
                : new BitbucketServerApi(baseUrl, token);
        }
        return this.cached;
    }

    async configure(suggestedUrl?: string): Promise<boolean> {
        const title = l10n.t('Bitbucket: Set Up Connection');
        const url = await vscode.window.showInputBox({
            title,
            prompt: l10n.t('Bitbucket URL (Server/Data Center, or https://bitbucket.org for Cloud)'),
            placeHolder: 'https://bitbucket.example.com',
            value: this.config.get<string>('baseUrl') || suggestedUrl,
            ignoreFocusOut: true,
            validateInput: value => (normalize(value) ? undefined : l10n.t('Enter a valid https:// URL.')),
        });
        if (url === undefined) {
            return false;
        }
        const baseUrl = normalize(url)!;
        const cloud = baseUrl === CLOUD_URL;

        let email = '';
        if (cloud) {
            const input = await vscode.window.showInputBox({
                title,
                prompt: l10n.t('Atlassian account email'),
                value: this.config.get<string>('email', ''),
                ignoreFocusOut: true,
                validateInput: value => (/^\S+@\S+$/.test(value.trim()) ? undefined : l10n.t('Enter a valid email address.')),
            });
            if (input === undefined) {
                return false;
            }
            email = input.trim();
        }

        const token = await vscode.window.showInputBox({
            title,
            prompt: cloud
                ? l10n.t('Bitbucket API token with pull request read and write scopes')
                : l10n.t('Bitbucket HTTP access token'),
            password: true,
            ignoreFocusOut: true,
            validateInput: value => (value.trim() ? undefined : l10n.t('The token cannot be empty.')),
        });
        if (token === undefined) {
            return false;
        }

        await this.config.update('baseUrl', baseUrl, vscode.ConfigurationTarget.Global);
        await this.config.update('email', email || undefined, vscode.ConfigurationTarget.Global);
        await this.secrets.store(BITBUCKET_TOKEN_SECRET, token.trim());
        this.reset();

        try {
            const me = (await this.user())!;
            vscode.window.showInformationMessage(l10n.t('Connected to Bitbucket as {0}.', me.name));
            return true;
        } catch (error) {
            vscode.window.showErrorMessage(l10n.t('Could not connect to Bitbucket: {0}', errorMessage(error)));
            return false;
        }
    }
}
