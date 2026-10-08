// Bitbucket Server / Data Center REST API 1.0.
import { l10n } from 'vscode';
import { RequestOptions, request } from '../http';
import { FileDiff, LineType } from './diff';
import { BbUser, BitbucketApi, InlineComment, PrComment, PrDetails, PrEvent, PullRequest, ReviewStatus } from './model';

const MAX_PAGES = 5;

interface RawUser {
    name: string;
    displayName?: string;
    type?: string;
}

interface RawRef {
    displayId: string;
    latestCommit?: string;
    repository: { slug: string; project: { key: string } };
}

interface RawPullRequest {
    id: number;
    title: string;
    description?: string;
    author?: { user: RawUser };
    state: PullRequest['state'];
    links?: { self?: { href: string }[] };
    fromRef: RawRef;
    toRef: RawRef;
    reviewers?: { user: RawUser; status: ReviewStatus }[];
}

interface RawAnchor {
    path?: string;
    line?: number;
    fileType?: 'FROM' | 'TO';
    orphaned?: boolean;
}

interface RawComment {
    id: number;
    text: string;
    author: RawUser;
    createdDate: number;
    state?: string;
    threadResolved?: boolean;
    anchor?: RawAnchor;
    comments?: RawComment[];
}

interface RawActivity {
    id: number;
    action: string;
    commentAction?: string;
    createdDate: number;
    user: RawUser;
    comment?: RawComment;
    commentAnchor?: RawAnchor;
}

interface RawPath {
    toString: string;
}

interface RawDiff {
    source?: RawPath | null;
    destination?: RawPath | null;
    binary?: boolean;
    hunks?: {
        destinationLine: number;
        destinationSpan: number;
        segments: { type: LineType; lines: { destination: number; line: string }[] }[];
    }[];
}

interface Page<T> {
    values: T[];
    isLastPage: boolean;
    nextPageStart?: number;
}

function toUser(raw: RawUser): BbUser {
    return { id: raw.name.toLowerCase(), name: raw.displayName ?? raw.name, ...(raw.type === 'SERVICE' ? { bot: true } : {}) };
}

export class BitbucketServerApi implements BitbucketApi {
    readonly host: string;

    constructor(private readonly baseUrl: string, private readonly token: string) {
        this.host = new URL(baseUrl).hostname.toLowerCase();
    }

    async me(): Promise<BbUser> {
        const { headers } = await this.call('/rest/api/1.0/dashboard/pull-requests?limit=1');
        let name = headers.get('x-ausername') ?? '';
        if (!name) {
            name = (await this.call<string>('/plugins/servlet/applinks/whoami', { text: true })).data.trim();
        }
        if (!name) {
            throw new Error(l10n.t('Could not determine the Bitbucket user.'));
        }
        try {
            return toUser((await this.call<RawUser>(`/rest/api/1.0/users/${encodeURIComponent(name.toLowerCase())}`)).data);
        } catch {
            return { id: name.toLowerCase(), name };
        }
    }

    async myOpenPullRequests(): Promise<PullRequest[]> {
        const prs = await this.getAll<RawPullRequest>('/rest/api/1.0/dashboard/pull-requests?state=OPEN&role=AUTHOR&limit=50');
        return prs.map(pr => this.toPullRequest(pr));
    }

    async reviewPullRequests(): Promise<PullRequest[]> {
        const prs = await this.getAll<RawPullRequest>('/rest/api/1.0/dashboard/pull-requests?state=OPEN&role=REVIEWER&limit=50');
        return prs.map(pr => this.toPullRequest(pr));
    }

    async getPullRequest(pr: PullRequest): Promise<PullRequest> {
        return this.toPullRequest((await this.call<RawPullRequest>(this.prPath(pr))).data);
    }

    async diff(pr: PullRequest): Promise<FileDiff[]> {
        const { data } = await this.call<{ diffs: RawDiff[] }>(`${this.prPath(pr)}/diff?withComments=false`);
        return data.diffs.map(diff => ({
            oldPath: diff.source?.toString,
            newPath: diff.destination?.toString,
            binary: diff.binary === true,
            hunks: (diff.hunks ?? []).map(hunk => ({
                newStart: hunk.destinationLine,
                newCount: hunk.destinationSpan,
                lines: hunk.segments.flatMap(segment => segment.lines.map(line => ({
                    type: segment.type,
                    text: line.line,
                    newLine: segment.type === 'REMOVED' ? undefined : line.destination,
                }))),
            })),
        }));
    }

    async fileContent(pr: PullRequest, path: string): Promise<string> {
        const { project, slug } = pr.repo;
        const file = path.split('/').map(encodeURIComponent).join('/');
        const at = encodeURIComponent(pr.sourceCommit ?? `refs/heads/${pr.sourceBranch}`);
        const url = `/rest/api/1.0/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(slug)}/raw/${file}?at=${at}`;
        return (await this.call<string>(url, { text: true })).data;
    }

    async addComment(pr: PullRequest, comment: InlineComment): Promise<void> {
        await this.call(`${this.prPath(pr)}/comments`, {
            method: 'POST',
            body: {
                text: comment.text,
                anchor: { path: comment.path, line: comment.line, lineType: comment.lineType, fileType: 'TO', diffType: 'EFFECTIVE' },
            },
        });
    }

    async setReviewStatus(pr: PullRequest, me: BbUser, status: 'APPROVED' | 'NEEDS_WORK'): Promise<void> {
        await this.call(`${this.prPath(pr)}/participants/${encodeURIComponent(me.id)}`, { method: 'PUT', body: { status } });
    }

    async details(pr: PullRequest): Promise<PrDetails> {
        const activities = await this.getAll<RawActivity>(`${this.prPath(pr)}/activities?limit=100`);

        // Each COMMENTED activity carries a comment with its current reply tree.
        const comments = new Map<number, RawComment>();
        const parentOf = new Map<number, number>();
        const anchors = new Map<number, RawAnchor>();
        const deleted = new Set<number>();
        const walk = (comment: RawComment, parentId?: number): void => {
            if (!comments.has(comment.id)) {
                comments.set(comment.id, comment);
            }
            if (parentId !== undefined) {
                parentOf.set(comment.id, parentId);
            }
            comment.comments?.forEach(reply => walk(reply, comment.id));
        };

        const reviews: PrEvent[] = [];
        for (const activity of activities) {
            if (activity.action === 'COMMENTED' && activity.comment) {
                if (activity.commentAction === 'DELETED') {
                    deleted.add(activity.comment.id);
                }
                walk(activity.comment);
                if (activity.commentAnchor) {
                    anchors.set(activity.comment.id, activity.commentAnchor);
                }
            } else if (activity.action === 'APPROVED' || activity.action === 'REVIEWED') {
                reviews.push({
                    id: `activity:${activity.id}`,
                    kind: activity.action === 'APPROVED' ? 'approved' : 'needsWork',
                    user: toUser(activity.user),
                    created: activity.createdDate,
                });
            }
        }

        const visible = (comment: RawComment) => !deleted.has(comment.id) && comment.state !== 'PENDING';
        const convert = (comment: RawComment, anchor: RawAnchor | undefined, parentId?: number): PrComment => ({
            id: comment.id,
            parentId,
            author: toUser(comment.author),
            text: comment.text,
            created: comment.createdDate,
            path: anchor?.path,
            line: anchor?.line,
            onNewSide: anchor?.fileType !== 'FROM',
            outdated: anchor?.orphaned === true,
            resolved: comment.state === 'RESOLVED' || comment.threadResolved === true,
            replies: (comment.comments ?? []).filter(visible).map(reply => convert(reply, anchor, comment.id)),
        });
        const threads = [...comments.values()]
            .filter(comment => !parentOf.has(comment.id) && visible(comment))
            .map(comment => convert(comment, anchors.get(comment.id) ?? comment.anchor))
            .sort((a, b) => a.created - b.created);
        return { threads, reviews };
    }

    async reply(pr: PullRequest, parentId: number, text: string): Promise<void> {
        await this.call(`${this.prPath(pr)}/comments`, { method: 'POST', body: { text, parent: { id: parentId } } });
    }

    commentUrl(pr: PullRequest, commentId: number): string {
        return `${pr.url}/overview?commentId=${commentId}`;
    }

    private call<T = unknown>(path: string, options?: RequestOptions) {
        return request<T>('Bitbucket', this.baseUrl + path, `Bearer ${this.token}`, options);
    }

    private async getAll<T>(path: string): Promise<T[]> {
        const values: T[] = [];
        let start = 0;
        for (let page = 0; page < MAX_PAGES; page++) {
            const { data } = await this.call<Page<T>>(`${path}&start=${start}`);
            values.push(...data.values);
            if (data.isLastPage || data.nextPageStart === undefined) {
                break;
            }
            start = data.nextPageStart;
        }
        return values;
    }

    private prPath(pr: PullRequest): string {
        const { project, slug } = pr.repo;
        return `/rest/api/1.0/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(slug)}/pull-requests/${pr.id}`;
    }

    private toPullRequest(raw: RawPullRequest): PullRequest {
        const repoRef = (ref: RawRef) => ({ project: ref.repository.project.key, slug: ref.repository.slug });
        const repo = repoRef(raw.toRef);
        return {
            key: `${this.host}/${repo.project}/${repo.slug}#${raw.id}`.toLowerCase(),
            id: raw.id,
            title: raw.title,
            url: raw.links?.self?.[0]?.href
                ?? `${this.baseUrl}/projects/${encodeURIComponent(repo.project)}/repos/${encodeURIComponent(repo.slug)}/pull-requests/${raw.id}`,
            state: raw.state,
            host: this.host,
            repo,
            sourceRepo: repoRef(raw.fromRef),
            sourceBranch: raw.fromRef.displayId,
            targetBranch: raw.toRef.displayId,
            sourceCommit: raw.fromRef.latestCommit,
            description: raw.description,
            author: raw.author && toUser(raw.author.user),
            reviewers: (raw.reviewers ?? []).map(reviewer => ({ user: toUser(reviewer.user), status: reviewer.status })),
        };
    }
}
