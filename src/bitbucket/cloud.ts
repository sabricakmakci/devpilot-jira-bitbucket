// Bitbucket Cloud REST API 2.0.
import { l10n } from 'vscode';
import { HttpError, RequestOptions, request } from '../http';
import { FileDiff, parseDiff } from './diff';
import { BbUser, BitbucketApi, InlineComment, PrComment, PrDetails, PrEvent, PullRequest, RepoRef } from './model';

const API = 'https://api.bitbucket.org/2.0';
const MAX_PAGES = 5;

interface RawUser {
    uuid: string;
    display_name?: string;
    nickname?: string;
    type?: string;
}

interface RawPullRequest {
    id: number;
    title: string;
    description?: string;
    author?: RawUser;
    state: PullRequest['state'];
    links: { html: { href: string } };
    source: { branch: { name: string }; commit?: { hash: string }; repository?: { full_name: string } };
    destination: { branch: { name: string }; repository: { full_name: string } };
    participants?: { user: RawUser; role: string; approved: boolean; state?: string | null }[];
}

interface RawComment {
    id: number;
    content: { raw: string };
    user?: RawUser;
    created_on: string;
    deleted?: boolean;
    pending?: boolean;
    parent?: { id: number };
    resolution?: unknown;
    inline?: { path: string; from?: number | null; to?: number | null; outdated?: boolean };
}

interface RawActivity {
    approval?: { date: string; user: RawUser };
    changes_requested?: { date: string; user: RawUser };
}

interface Page<T> {
    values: T[];
    next?: string;
}

function toUser(raw: RawUser | undefined): BbUser {
    return raw
        ? { id: raw.uuid, name: raw.display_name ?? raw.nickname ?? raw.uuid, ...(raw.type === 'app_user' ? { bot: true } : {}) }
        : { id: '', name: l10n.t('Unknown user') };
}

function toRepoRef(fullName: string): RepoRef {
    const [project, slug] = fullName.split('/');
    return { project, slug };
}

export class BitbucketCloudApi implements BitbucketApi {
    readonly host = 'bitbucket.org';
    private readonly authorization: string;
    private myself?: BbUser;

    constructor(email: string, token: string) {
        this.authorization = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
    }

    async me(): Promise<BbUser> {
        this.myself ??= toUser((await this.call<RawUser>(`${API}/user`)).data);
        return this.myself;
    }

    async myOpenPullRequests(): Promise<PullRequest[]> {
        const me = await this.me();
        const prs = await this.getAll<RawPullRequest>(`${API}/pullrequests/${encodeURIComponent(me.id)}?state=OPEN&pagelen=50`);
        return prs.map(pr => this.toPullRequest(pr));
    }

    async reviewPullRequests(repos: RepoRef[]): Promise<PullRequest[]> {
        const me = await this.me();
        const query = encodeURIComponent(`state="OPEN" AND reviewers.uuid="${me.id}"`);
        const unique = [...new Map(repos.map(repo => [`${repo.project}/${repo.slug}`.toLowerCase(), repo])).values()];
        const results = await Promise.all(unique.map(async repo => {
            try {
                return await this.getAll<RawPullRequest>(`${this.repoUrl(repo)}/pullrequests?q=${query}&pagelen=50`);
            } catch (error) {
                if (error instanceof HttpError && (error.status === 403 || error.status === 404)) {
                    return [];
                }
                throw error;
            }
        }));
        return results.flat().map(pr => this.toPullRequest(pr));
    }

    async getPullRequest(pr: PullRequest): Promise<PullRequest> {
        return this.toPullRequest((await this.call<RawPullRequest>(this.prUrl(pr))).data);
    }

    async diff(pr: PullRequest): Promise<FileDiff[]> {
        return parseDiff((await this.call<string>(`${this.prUrl(pr)}/diff`, { text: true })).data);
    }

    async fileContent(pr: PullRequest, path: string): Promise<string> {
        const file = path.split('/').map(encodeURIComponent).join('/');
        const at = encodeURIComponent(pr.sourceCommit ?? pr.sourceBranch);
        return (await this.call<string>(`${this.repoUrl(pr.sourceRepo ?? pr.repo)}/src/${at}/${file}`, { text: true })).data;
    }

    async addComment(pr: PullRequest, comment: InlineComment): Promise<void> {
        await this.call(`${this.prUrl(pr)}/comments`, {
            method: 'POST',
            body: { content: { raw: comment.text }, inline: { path: comment.path, to: comment.line } },
        });
    }

    async setReviewStatus(pr: PullRequest, _me: BbUser, status: 'APPROVED' | 'NEEDS_WORK'): Promise<void> {
        await this.call(`${this.prUrl(pr)}/${status === 'APPROVED' ? 'approve' : 'request-changes'}`, { method: 'POST' });
    }

    async details(pr: PullRequest): Promise<PrDetails> {
        const raw = await this.getAll<RawComment>(`${this.prUrl(pr)}/comments?pagelen=100`);
        const comments = new Map<number, PrComment>();
        for (const comment of raw) {
            if (comment.deleted || comment.pending) {
                continue;
            }
            const inline = comment.inline;
            comments.set(comment.id, {
                id: comment.id,
                parentId: comment.parent?.id,
                author: toUser(comment.user),
                text: comment.content.raw,
                created: Date.parse(comment.created_on),
                path: inline?.path,
                line: inline?.to ?? inline?.from ?? undefined,
                onNewSide: inline?.to != null,
                outdated: inline?.outdated === true,
                resolved: comment.resolution != null,
                replies: [],
            });
        }

        const threads: PrComment[] = [];
        for (const comment of comments.values()) {
            const parent = comment.parentId === undefined ? undefined : comments.get(comment.parentId);
            (parent ? parent.replies : threads).push(comment);
        }
        const inherit = (comment: PrComment, from?: PrComment): void => {
            if (from && !comment.path) {
                Object.assign(comment, { path: from.path, line: from.line, onNewSide: from.onNewSide, outdated: from.outdated });
            }
            comment.replies.sort((a, b) => a.created - b.created);
            comment.replies.forEach(reply => inherit(reply, comment));
        };
        threads.forEach(thread => inherit(thread));
        threads.sort((a, b) => a.created - b.created);

        const { data } = await this.call<Page<RawActivity>>(`${this.prUrl(pr)}/activity?pagelen=50`);
        const reviews: PrEvent[] = data.values.flatMap((activity): PrEvent[] => {
            const review = activity.approval ?? activity.changes_requested;
            if (!review) {
                return [];
            }
            const kind = activity.approval ? 'approved' : 'needsWork';
            const user = toUser(review.user);
            return [{ id: `${kind}:${user.id}:${review.date}`, kind, user, created: Date.parse(review.date) }];
        });
        return { threads, reviews };
    }

    async reply(pr: PullRequest, parentId: number, text: string): Promise<void> {
        await this.call(`${this.prUrl(pr)}/comments`, { method: 'POST', body: { content: { raw: text }, parent: { id: parentId } } });
    }

    commentUrl(pr: PullRequest, commentId: number): string {
        return `${pr.url}#comment-${commentId}`;
    }

    private call<T = unknown>(url: string, options?: RequestOptions) {
        return request<T>('Bitbucket', url, this.authorization, options);
    }

    private async getAll<T>(url: string): Promise<T[]> {
        const values: T[] = [];
        let next: string | undefined = url;
        for (let page = 0; next && page < MAX_PAGES; page++) {
            const { data }: { data: Page<T> } = await this.call<Page<T>>(next);
            values.push(...data.values);
            // Only follow links back to the API so credentials are never sent elsewhere.
            next = data.next?.startsWith(`${API}/`) ? data.next : undefined;
        }
        return values;
    }

    private repoUrl(repo: RepoRef): string {
        return `${API}/repositories/${encodeURIComponent(repo.project)}/${encodeURIComponent(repo.slug)}`;
    }

    private prUrl(pr: PullRequest): string {
        return `${this.repoUrl(pr.repo)}/pullrequests/${pr.id}`;
    }

    private toPullRequest(raw: RawPullRequest): PullRequest {
        const repo = toRepoRef(raw.destination.repository.full_name);
        return {
            key: `${this.host}/${repo.project}/${repo.slug}#${raw.id}`.toLowerCase(),
            id: raw.id,
            title: raw.title,
            url: raw.links.html.href,
            state: raw.state,
            host: this.host,
            repo,
            sourceRepo: raw.source.repository && toRepoRef(raw.source.repository.full_name),
            sourceBranch: raw.source.branch.name,
            targetBranch: raw.destination.branch.name,
            sourceCommit: raw.source.commit?.hash,
            description: raw.description,
            author: raw.author && toUser(raw.author),
            reviewers: (raw.participants ?? [])
                .filter(participant => participant.role === 'REVIEWER' || participant.approved || participant.state)
                .map(participant => ({
                    user: toUser(participant.user),
                    status: participant.approved ? 'APPROVED' : participant.state === 'changes_requested' ? 'NEEDS_WORK' : 'UNAPPROVED',
                })),
        };
    }
}
