import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { HttpError, errorMessage } from '../http';
import { BitbucketConnection } from './client';
import { BbUser, PrComment, PrEvent, PullRequest, RepoRef, flattenComments } from './model';

const TRACKED_KEY = 'jiraBitbucketFlow.trackedPullRequests';
const UNREAD_KEY = 'jiraBitbucketFlow.unreadComments';
const LEASE_KEY = 'jiraBitbucketFlow.pollLease';
const MIN_INTERVAL_SECONDS = 15;
const FOCUS_REFRESH_MS = 10_000;
const MAX_CLOSED_TRACKED = 50;

interface TrackedPullRequest {
    pr: PullRequest;
    /** Event ids that were present at the last poll. */
    seen: string[];
    closed?: boolean;
}

/** Only one window polls at a time; the focused window always takes over. */
interface Lease {
    owner: string;
    until: number;
}

export interface PullRequestSnapshot {
    pr: PullRequest;
    threads: PrComment[];
}

export interface PullRequestUpdate {
    pr: PullRequest;
    event: PrEvent;
    comment?: PrComment;
}

export type WatcherState =
    | { kind: 'notConfigured' }
    | { kind: 'loading' }
    | { kind: 'ready' }
    | { kind: 'error'; message: string };

function commentKey(pr: PullRequest, commentId: number): string {
    return `${pr.key}:${commentId}`;
}

function commentEvents(comments: PrComment[], me: BbUser): PrEvent[] {
    const byId = new Map(comments.map(comment => [comment.id, comment]));
    return comments
        .filter(comment => comment.author.id !== me.id)
        .map(comment => ({
            id: `comment:${comment.id}`,
            kind: comment.parentId !== undefined && byId.get(comment.parentId)?.author.id === me.id ? 'reply' : 'comment',
            user: comment.author,
            created: comment.created,
            commentId: comment.id,
            text: comment.text,
        }));
}

export class PullRequestWatcher implements vscode.Disposable {
    private readonly id = randomUUID();
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    private readonly updateEmitter = new vscode.EventEmitter<PullRequestUpdate[]>();
    private readonly disposables: vscode.Disposable[] = [this.changeEmitter, this.updateEmitter];
    private timer?: NodeJS.Timeout;
    private polling?: Promise<void>;
    private lastPoll = 0;

    readonly onDidChange = this.changeEmitter.event;
    readonly onDidReceiveUpdates = this.updateEmitter.event;
    snapshots: PullRequestSnapshot[] = [];
    /** Open pull requests where the user is a reviewer; listed only, never notified. */
    reviewRequests: PullRequest[] = [];
    /** Comment threads of `reviewRequests`, keyed by pull request key. */
    reviewThreads = new Map<string, PrComment[]>();
    me?: BbUser;
    state: WatcherState = { kind: 'loading' };

    constructor(
        private readonly connection: BitbucketConnection,
        private readonly storage: vscode.Memento,
        private readonly log: vscode.LogOutputChannel,
        private readonly localRepos: (host: string) => RepoRef[],
    ) {
        this.disposables.push(
            vscode.window.onDidChangeWindowState(state => {
                if (state.focused && Date.now() - this.lastPoll > FOCUS_REFRESH_MS) {
                    void this.poll();
                }
            }),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('jiraBitbucketFlow.bitbucket.pollInterval')) {
                    this.schedule();
                }
            }),
        );
        this.schedule();
    }

    private get intervalMs(): number {
        const seconds = vscode.workspace.getConfiguration('jiraBitbucketFlow.bitbucket').get<number>('pollInterval', 30);
        return Math.max(MIN_INTERVAL_SECONDS, seconds) * 1000;
    }

    private schedule(): void {
        clearInterval(this.timer);
        this.timer = setInterval(() => void this.poll(), this.intervalMs);
    }

    /** Call after the connection settings changed. */
    reset(): void {
        this.snapshots = [];
        this.reviewRequests = [];
        this.reviewThreads = new Map();
        this.me = undefined;
        this.state = { kind: 'loading' };
        this.changeEmitter.fire();
        void this.poll(true);
    }

    /** `force` skips the single-poller lease, e.g. for a manual refresh. */
    poll(force = false): Promise<void> {
        this.polling ??= this.doPoll(force).finally(() => (this.polling = undefined));
        return this.polling;
    }

    isUnread(pr: PullRequest, commentId: number): boolean {
        return this.unread().has(commentKey(pr, commentId));
    }

    unreadCount(pr?: PullRequest): number {
        const unread = this.unread();
        return this.snapshots
            .filter(snapshot => !pr || snapshot.pr.key === pr.key)
            .flatMap(snapshot => flattenComments(snapshot.threads).map(comment => commentKey(snapshot.pr, comment.id)))
            .filter(key => unread.has(key)).length;
    }

    async markRead(pr: PullRequest, commentIds: number[]): Promise<void> {
        const unread = this.unread();
        const before = unread.size;
        commentIds.forEach(id => unread.delete(commentKey(pr, id)));
        if (unread.size !== before) {
            await this.storage.update(UNREAD_KEY, [...unread]);
            this.changeEmitter.fire();
        }
    }

    async markAllRead(): Promise<void> {
        await this.storage.update(UNREAD_KEY, []);
        this.changeEmitter.fire();
    }

    dispose(): void {
        clearInterval(this.timer);
        if (this.storage.get<Lease>(LEASE_KEY)?.owner === this.id) {
            void this.storage.update(LEASE_KEY, undefined);
        }
        this.disposables.forEach(disposable => disposable.dispose());
    }

    private unread(): Set<string> {
        return new Set(this.storage.get<string[]>(UNREAD_KEY, []));
    }

    private setState(state: WatcherState, snapshots: PullRequestSnapshot[], reviewRequests = this.reviewRequests): void {
        this.state = state;
        this.snapshots = snapshots;
        this.reviewRequests = reviewRequests;
        this.changeEmitter.fire();
    }

    private async acquireLease(): Promise<boolean> {
        const lease = this.storage.get<Lease>(LEASE_KEY);
        const now = Date.now();
        if (!vscode.window.state.focused && lease && lease.owner !== this.id && lease.until > now) {
            return false;
        }
        await this.storage.update(LEASE_KEY, { owner: this.id, until: now + 3 * this.intervalMs });
        return true;
    }

    private async doPoll(force: boolean): Promise<void> {
        const api = await this.connection.api();
        if (!api) {
            this.setState({ kind: 'notConfigured' }, [], []);
            return;
        }
        if (!force && !(await this.acquireLease())) {
            return;
        }
        this.lastPoll = Date.now();
        try {
            const me = (await this.connection.user())!;
            this.me = me;
            const open = await api.myOpenPullRequests();
            const tracked = { ...this.storage.get<Record<string, TrackedPullRequest>>(TRACKED_KEY, {}) };
            const updates: PullRequestUpdate[] = [];
            const snapshots: PullRequestSnapshot[] = [];

            for (const pr of open) {
                const details = await api.details(pr);
                const comments = flattenComments(details.threads);
                const events = [
                    ...commentEvents(comments, me),
                    ...details.reviews.filter(event => event.user?.id !== me.id),
                ];
                const previous = tracked[pr.key];
                // A pull request seen for the first time is recorded silently.
                if (previous && !previous.closed) {
                    const seen = new Set(previous.seen);
                    for (const event of events.filter(event => !seen.has(event.id))) {
                        updates.push({ pr, event, comment: comments.find(comment => comment.id === event.commentId) });
                    }
                }
                tracked[pr.key] = { pr, seen: events.map(event => event.id) };
                snapshots.push({ pr, threads: details.threads });
            }

            const openKeys = new Set(open.map(pr => pr.key));
            for (const [key, entry] of Object.entries(tracked)) {
                if (openKeys.has(key) || entry.closed) {
                    continue;
                }
                if (entry.pr.host === api.host) {
                    try {
                        const latest = await api.getPullRequest(entry.pr);
                        if (latest.state === 'OPEN') {
                            continue;
                        }
                        if (latest.state === 'MERGED' || latest.state === 'DECLINED') {
                            updates.push({
                                pr: latest,
                                event: { id: `state:${latest.state}`, kind: latest.state === 'MERGED' ? 'merged' : 'declined', created: Date.now() },
                            });
                        }
                    } catch (error) {
                        if (!(error instanceof HttpError && error.status === 404)) {
                            throw error;
                        }
                    }
                }
                tracked[key] = { ...entry, seen: [], closed: true };
            }

            const closedKeys = Object.keys(tracked).filter(key => tracked[key].closed);
            closedKeys.slice(0, Math.max(0, closedKeys.length - MAX_CLOSED_TRACKED)).forEach(key => delete tracked[key]);
            await this.storage.update(TRACKED_KEY, tracked);

            const existing = new Set(snapshots.flatMap(({ pr, threads }) => flattenComments(threads).map(comment => commentKey(pr, comment.id))));
            const unread = [...this.unread()].filter(key => existing.has(key));
            updates.forEach(({ pr, comment }) => comment && unread.push(commentKey(pr, comment.id)));
            await this.storage.update(UNREAD_KEY, [...new Set(unread)]);

            let reviewRequests = this.reviewRequests;
            try {
                reviewRequests = await api.reviewPullRequests(this.localRepos(api.host));
            } catch (error) {
                this.log.warn(`Could not load pull requests to review: ${errorMessage(error)}`);
            }
            const reviewThreads = new Map<string, PrComment[]>();
            for (const pr of reviewRequests) {
                try {
                    reviewThreads.set(pr.key, (await api.details(pr)).threads);
                } catch (error) {
                    this.log.warn(`Could not load comments of #${pr.id}: ${errorMessage(error)}`);
                    const previous = this.reviewThreads.get(pr.key);
                    if (previous) {
                        reviewThreads.set(pr.key, previous);
                    }
                }
            }
            this.reviewThreads = reviewThreads;

            this.setState({ kind: 'ready' }, snapshots, reviewRequests);
            if (updates.length > 0) {
                this.updateEmitter.fire(updates);
            }
        } catch (error) {
            const message = errorMessage(error);
            this.log.warn(`Could not refresh pull requests: ${message}`);
            this.setState({ kind: 'error', message }, this.snapshots);
        }
    }
}
