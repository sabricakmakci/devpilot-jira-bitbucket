import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { HttpError, errorMessage, normalizeBaseUrl, request } from './http';

export interface JiraUser {
    accountId?: string;
    name?: string;
    key?: string;
    displayName?: string;
}

export interface JiraIssue {
    key: string;
    fields: {
        summary?: string;
        status?: { name: string; statusCategory?: { key: string } };
        issuetype?: { name: string; subtask: boolean };
        assignee?: JiraUser | null;
        parent?: { key: string; fields?: { summary?: string } };
        [field: string]: unknown;
    };
}

export interface JiraTransition {
    id: string;
    name: string;
    to?: { name: string; statusCategory?: { key: string } };
}

export interface JiraField {
    id: string;
    name: string;
}

export interface JiraVersion {
    name: string;
    released?: boolean;
    archived?: boolean;
}

export const JIRA_TOKEN_SECRET = 'jiraBitbucketFlow.jiraToken';
const ISSUE_FIELDS = ['summary', 'status', 'issuetype', 'assignee', 'parent'];

/** Jira Cloud identifies users by accountId, Server/Data Center by name. */
export function userId(user: JiraUser | null | undefined): string | undefined {
    return user?.accountId ?? user?.name ?? user?.key;
}

function isAtlassianCloud(baseUrl: string): boolean {
    return new URL(baseUrl).hostname.endsWith('.atlassian.net');
}

export class JiraClient {
    private myself?: JiraUser;
    private fields?: Promise<JiraField[]>;
    private readonly projects = new Map<string, boolean>();

    constructor(private readonly secrets: vscode.SecretStorage) { }

    private get config(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration('jiraBitbucketFlow.jira');
    }

    get baseUrl(): string {
        return normalizeBaseUrl(this.config.get<string>('baseUrl', '')) ?? '';
    }

    private get email(): string {
        return this.config.get<string>('email', '').trim();
    }

    browseUrl(key: string): vscode.Uri {
        return vscode.Uri.parse(`${this.baseUrl}/browse/${encodeURIComponent(key)}`);
    }

    reset(): void {
        this.myself = undefined;
        this.fields = undefined;
        this.projects.clear();
    }

    async isConfigured(): Promise<boolean> {
        return this.baseUrl !== '' && (await this.secrets.get(JIRA_TOKEN_SECRET)) !== undefined;
    }

    async logout(): Promise<void> {
        await this.secrets.delete(JIRA_TOKEN_SECRET);
        this.reset();
    }

    async ensureConfigured(): Promise<boolean> {
        return (await this.isConfigured()) || this.configure();
    }

    async configure(): Promise<boolean> {
        const title = l10n.t('Jira: Set Up Connection');
        const url = await vscode.window.showInputBox({
            title,
            prompt: l10n.t('Jira base URL'),
            placeHolder: 'https://jira.example.com',
            value: this.baseUrl,
            ignoreFocusOut: true,
            validateInput: value => (normalizeBaseUrl(value) ? undefined : l10n.t('Enter a valid https:// URL.')),
        });
        if (url === undefined) {
            return false;
        }
        const baseUrl = normalizeBaseUrl(url)!;

        let email = '';
        if (isAtlassianCloud(baseUrl)) {
            const input = await vscode.window.showInputBox({
                title,
                prompt: l10n.t('Atlassian account email'),
                value: this.email,
                ignoreFocusOut: true,
                validateInput: value => (value.includes('@') ? undefined : l10n.t('Enter a valid email address.')),
            });
            if (input === undefined) {
                return false;
            }
            email = input.trim();
        }

        const token = await vscode.window.showInputBox({
            title,
            prompt: email ? l10n.t('Atlassian API token') : l10n.t('Jira personal access token'),
            password: true,
            ignoreFocusOut: true,
            validateInput: value => (value.trim() ? undefined : l10n.t('The token cannot be empty.')),
        });
        if (token === undefined) {
            return false;
        }

        await this.config.update('baseUrl', baseUrl, vscode.ConfigurationTarget.Global);
        await this.config.update('email', email || undefined, vscode.ConfigurationTarget.Global);
        await this.secrets.store(JIRA_TOKEN_SECRET, token.trim());
        this.reset();

        try {
            const me = await this.getMyself();
            vscode.window.showInformationMessage(l10n.t('Connected to Jira as {0}.', me.displayName ?? userId(me) ?? '?'));
            return true;
        } catch (error) {
            vscode.window.showErrorMessage(l10n.t('Could not connect to Jira: {0}', errorMessage(error)));
            return false;
        }
    }

    async getMyself(): Promise<JiraUser> {
        this.myself ??= await this.request<JiraUser>('GET', '/rest/api/2/myself');
        return this.myself;
    }

    getIssue(key: string): Promise<JiraIssue> {
        return this.request('GET', `/rest/api/2/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS.join(',')}`);
    }

    /** Used to ignore look-alike tokens such as "UTF-8" in commit messages. */
    async projectExists(projectKey: string): Promise<boolean> {
        let exists = this.projects.get(projectKey);
        if (exists === undefined) {
            try {
                await this.request('GET', `/rest/api/2/project/${encodeURIComponent(projectKey)}`);
                exists = true;
            } catch (error) {
                if (!(error instanceof HttpError && error.status === 404)) {
                    throw error;
                }
                exists = false;
            }
            this.projects.set(projectKey, exists);
        }
        return exists;
    }

    async searchIssues(jql: string, fields: string[] = ISSUE_FIELDS, maxResults = 50): Promise<JiraIssue[]> {
        // Jira Cloud removed /search in favour of /search/jql.
        const path = this.email ? '/rest/api/2/search/jql' : '/rest/api/2/search';
        const result = await this.request<{ issues?: JiraIssue[] }>('POST', path, { jql, fields, maxResults });
        return result.issues ?? [];
    }

    /** Maps lower-case field names and ids (e.g. "fix version/s", "fixversions") to field ids. System fields win over custom fields with the same name. */
    async fieldIds(): Promise<Map<string, string>> {
        const isCustom = (field: JiraField) => Number(field.id.startsWith('customfield_'));
        const fields = [...(await this.listFields())].sort((a, b) => isCustom(a) - isCustom(b));
        const ids = new Map<string, string>();
        for (const field of fields) {
            for (const key of [field.name.toLowerCase(), field.id.toLowerCase()]) {
                if (!ids.has(key)) {
                    ids.set(key, field.id);
                }
            }
        }
        return ids;
    }

    listFields(): Promise<JiraField[]> {
        this.fields ??= this.request<JiraField[]>('GET', '/rest/api/2/field').catch(error => {
            this.fields = undefined;
            throw error;
        });
        return this.fields;
    }

    issueTypes(): Promise<{ name: string; subtask: boolean }[]> {
        return this.request('GET', '/rest/api/2/issuetype');
    }

    projectVersions(project: string): Promise<JiraVersion[]> {
        return this.request('GET', `/rest/api/2/project/${encodeURIComponent(project)}/versions`);
    }

    async getTransitions(key: string): Promise<JiraTransition[]> {
        const result = await this.request<{ transitions?: JiraTransition[] }>('GET', `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`);
        return result.transitions ?? [];
    }

    async transition(key: string, transitionId: string): Promise<void> {
        await this.request('POST', `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: transitionId } });
    }

    private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
        const token = await this.secrets.get(JIRA_TOKEN_SECRET);
        if (!this.baseUrl || !token) {
            throw new Error(l10n.t('The Jira connection is not set up.'));
        }
        const authorization = this.email
            ? `Basic ${Buffer.from(`${this.email}:${token}`).toString('base64')}`
            : `Bearer ${token}`;
        return (await request<T>('Jira', this.baseUrl + path, authorization, { method, body })).data;
    }
}
