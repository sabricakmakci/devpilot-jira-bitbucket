import { FileDiff } from './diff';

export interface BbUser {
    /** Server: lower-case user name, Cloud: account UUID. */
    id: string;
    name: string;
    /** Service account or app user. */
    bot?: boolean;
}

export type ReviewStatus = 'APPROVED' | 'NEEDS_WORK' | 'UNAPPROVED';

export interface RepoRef {
    /** Server: project key, Cloud: workspace slug. */
    project: string;
    slug: string;
}

export interface PullRequest {
    /** Unique across servers: `host/project/slug#id`, lower case. */
    key: string;
    id: number;
    title: string;
    url: string;
    state: 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED';
    host: string;
    repo: RepoRef;
    sourceRepo?: RepoRef;
    sourceBranch: string;
    targetBranch: string;
    /** Latest commit of the source branch. */
    sourceCommit?: string;
    description?: string;
    author?: BbUser;
    reviewers: { user: BbUser; status: ReviewStatus }[];
}

export interface PrComment {
    id: number;
    parentId?: number;
    author: BbUser;
    text: string;
    created: number;
    /** File comments only; replies inherit the location of their thread. */
    path?: string;
    line?: number;
    /** False when the comment is anchored to the old (removed) side of the diff. */
    onNewSide: boolean;
    outdated: boolean;
    /** Set on the first comment of a resolved thread. */
    resolved?: boolean;
    replies: PrComment[];
}

export type PrEventKind = 'comment' | 'reply' | 'approved' | 'needsWork' | 'merged' | 'declined';

export interface PrEvent {
    /** Stable id used to detect what has already been notified. */
    id: string;
    kind: PrEventKind;
    user?: BbUser;
    created: number;
    commentId?: number;
    text?: string;
}

export interface PrDetails {
    threads: PrComment[];
    /** Approvals and change requests. */
    reviews: PrEvent[];
}

export interface InlineComment {
    path: string;
    /** Line in the new version of the file. */
    line: number;
    lineType: 'ADDED' | 'CONTEXT';
    text: string;
}

export interface BitbucketApi {
    readonly host: string;
    me(): Promise<BbUser>;
    myOpenPullRequests(): Promise<PullRequest[]>;
    /** Cloud has no global reviewer query, so it only searches the given repositories. */
    reviewPullRequests(repos: RepoRef[]): Promise<PullRequest[]>;
    getPullRequest(pr: PullRequest): Promise<PullRequest>;
    details(pr: PullRequest): Promise<PrDetails>;
    diff(pr: PullRequest): Promise<FileDiff[]>;
    /** File content at the latest commit of the source branch. */
    fileContent(pr: PullRequest, path: string): Promise<string>;
    reply(pr: PullRequest, parentId: number, text: string): Promise<void>;
    addComment(pr: PullRequest, comment: InlineComment): Promise<void>;
    setReviewStatus(pr: PullRequest, me: BbUser, status: 'APPROVED' | 'NEEDS_WORK'): Promise<void>;
    commentUrl(pr: PullRequest, commentId: number): string;
}

export function repoPaths(pr: PullRequest): string[] {
    return [pr.repo, pr.sourceRepo].flatMap(repo => (repo ? [`${repo.project}/${repo.slug}`] : []));
}

export function flattenComments(comments: PrComment[]): PrComment[] {
    return comments.flatMap(comment => [comment, ...flattenComments(comment.replies)]);
}
