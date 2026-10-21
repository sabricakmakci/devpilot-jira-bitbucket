import * as fs from 'fs';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { API, findRepository } from '../git';
import { isInside } from '../ipc';
import { BitbucketConnection } from './client';
import { PrComment, PullRequest, flattenComments, repoPaths } from './model';
import { PullRequestSnapshot } from './watcher';

const SCHEME = 'jbf-pr';
const HIDDEN_KEY = 'jiraBitbucketFlow.hiddenCommentThreads';

interface ThreadEntry {
    thread: vscode.CommentThread;
    signature: string;
    pr: PullRequest;
    rootId: number;
}

/** Hidden threads, keyed by `${pr.key}:${rootId}` and holding the newest comment id at the time they were hidden. */
type HiddenThreads = Record<string, number>;

function threadKey(pr: PullRequest, rootId: number): string {
    return `${pr.key}:${rootId}`;
}

/** A hidden thread comes back when someone adds a comment to it. */
function newestCommentId(root: PrComment): number {
    return Math.max(...flattenComments([root]).map(comment => comment.id));
}

export interface CommentLocation {
    uri: vscode.Uri;
    /** Zero-based. */
    line: number;
}

/** Resolves the local file of a file comment, if the repository is open and the file exists in it. */
function localFile(git: API | undefined, pr: PullRequest, comment: PrComment): vscode.Uri | undefined {
    if (!git || !comment.path || comment.line === undefined || !comment.onNewSide || comment.outdated) {
        return undefined;
    }
    const repo = findRepository(git, pr.host, repoPaths(pr));
    if (!repo) {
        return undefined;
    }
    const uri = vscode.Uri.joinPath(repo.rootUri, comment.path);
    return isInside(uri.fsPath, repo.rootUri.fsPath) && fs.existsSync(uri.fsPath) ? uri : undefined;
}

/** A read-only pull request file from Bitbucket, or the pull request overview when `filePath` is missing. */
function remoteUri(pr: PullRequest, filePath?: string): vscode.Uri {
    return vscode.Uri.from({
        scheme: SCHEME,
        path: filePath ? `/${filePath}` : `/PR-${pr.id}.md`,
        query: new URLSearchParams({ pr: pr.key, ...(filePath ? {} : { overview: '1' }) }).toString(),
    });
}

function toComment(comment: PrComment): vscode.Comment {
    return {
        body: new vscode.MarkdownString(comment.text),
        mode: vscode.CommentMode.Preview,
        author: { name: comment.author.name },
        timestamp: new Date(comment.created),
    };
}

/** Shows pull request comments in VS Code: in the local file, in a read-only copy of the pull request file, or in the pull request overview. */
export class PullRequestComments implements vscode.Disposable, vscode.TextDocumentContentProvider {
    private readonly controller = vscode.comments.createCommentController('jiraBitbucketFlow.prComments', l10n.t('Bitbucket Pull Requests'));
    private readonly registration = vscode.workspace.registerTextDocumentContentProvider(SCHEME, this);
    private readonly threads = new Map<string, ThreadEntry>();
    private readonly pullRequests = new Map<string, PullRequest>();
    private lastSnapshots: PullRequestSnapshot[] = [];

    constructor(
        private readonly git: API | undefined,
        private readonly connection: BitbucketConnection,
        private readonly storage: vscode.Memento,
        /** Unread threads open expanded, the rest stay collapsed. */
        private readonly isUnread: (pr: PullRequest, commentId: number) => boolean,
    ) { }

    /** Where a comment (or the thread of a reply) is shown. */
    location(pr: PullRequest, comment: PrComment): CommentLocation {
        const line = Math.max(0, (comment.line ?? 1) - 1);
        const local = localFile(this.git, pr, comment);
        if (local) {
            return { uri: local, line };
        }
        if (comment.path && comment.line !== undefined && comment.onNewSide && !comment.outdated) {
            return { uri: remoteUri(pr, comment.path), line };
        }
        return { uri: remoteUri(pr), line: 0 };
    }

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const query = new URLSearchParams(uri.query);
        const pr = this.pullRequests.get(query.get('pr') ?? '');
        if (!pr) {
            throw new Error(l10n.t('The pull request is no longer open.'));
        }
        if (query.has('overview')) {
            return [
                `# #${pr.id} ${pr.title}`,
                '',
                [pr.author?.name, `${pr.repo.slug}: ${pr.sourceBranch} → ${pr.targetBranch}`].filter(Boolean).join(' · '),
                pr.url,
                '',
                pr.description?.trim() || '',
                '',
            ].join('\n');
        }
        const api = await this.connection.api();
        if (!api) {
            throw new Error(l10n.t('The Bitbucket connection is not set up.'));
        }
        return api.fileContent(pr, uri.path.slice(1));
    }

    update(snapshots: PullRequestSnapshot[]): void {
        this.lastSnapshots = snapshots;
        const wanted = new Set<string>();
        const hidden = this.hidden();
        this.pullRequests.clear();
        for (const { pr, threads } of snapshots) {
            this.pullRequests.set(pr.key, pr);
            for (const root of threads) {
                const key = threadKey(pr, root.id);
                if (hidden[key] !== undefined && newestCommentId(root) <= hidden[key]) {
                    continue;
                }
                const { uri, line } = this.location(pr, root);
                const comments = flattenComments([root]);
                const signature = JSON.stringify([uri.toString(), line, comments.map(comment => [comment.id, comment.text])]);
                wanted.add(key);

                const existing = this.threads.get(key);
                if (existing) {
                    existing.pr = pr;
                    if (existing.signature === signature) {
                        continue;
                    }
                    if (existing.thread.uri.toString() === uri.toString() && existing.thread.range?.start.line === line) {
                        existing.thread.comments = comments.map(toComment);
                        existing.signature = signature;
                        continue;
                    }
                    existing.thread.dispose();
                }
                const thread = this.controller.createCommentThread(uri, new vscode.Range(line, 0, line, 0), comments.map(toComment));
                thread.label = uri.scheme === SCHEME && root.path && !uri.path.endsWith(root.path)
                    ? `${root.path}${root.line ? `:${root.line}` : ''}`
                    : `#${pr.id} ${pr.title}`;
                thread.canReply = true;
                thread.collapsibleState = comments.some(comment => this.isUnread(pr, comment.id))
                    ? vscode.CommentThreadCollapsibleState.Expanded
                    : vscode.CommentThreadCollapsibleState.Collapsed;
                this.threads.set(key, { thread, signature, pr, rootId: root.id });
            }
        }
        for (const [key, entry] of this.threads) {
            if (!wanted.has(key)) {
                entry.thread.dispose();
                this.threads.delete(key);
            }
        }
        this.forgetClosed(hidden);
    }

    /** Drops hidden threads of pull requests that are no longer listed, e.g. merged ones. */
    private forgetClosed(hidden: HiddenThreads): void {
        if (this.pullRequests.size === 0) {
            return;
        }
        const keys = Object.keys(hidden).filter(key => !this.pullRequests.has(key.slice(0, key.lastIndexOf(':'))));
        if (keys.length > 0) {
            keys.forEach(key => delete hidden[key]);
            void this.storage.update(HIDDEN_KEY, hidden);
        }
    }

    find(thread: vscode.CommentThread): ThreadEntry | undefined {
        return [...this.threads.values()].find(entry => entry.thread === thread);
    }

    /** Hides one thread, or every thread of its pull request, until it gets a new comment. */
    async hide(thread: vscode.CommentThread, wholePullRequest = false): Promise<{ pr: PullRequest; threads: number; commentIds: number[] } | undefined> {
        const entry = this.find(thread);
        if (!entry) {
            return undefined;
        }
        const hidden = this.hidden();
        const roots = this.lastSnapshots
            .filter(snapshot => snapshot.pr.key === entry.pr.key)
            .flatMap(snapshot => snapshot.threads)
            .filter(root => wholePullRequest || root.id === entry.rootId);
        for (const root of roots) {
            hidden[threadKey(entry.pr, root.id)] = newestCommentId(root);
        }
        await this.storage.update(HIDDEN_KEY, hidden);
        this.update(this.lastSnapshots);
        return { pr: entry.pr, threads: roots.length, commentIds: flattenComments(roots).map(comment => comment.id) };
    }

    hiddenCount(): number {
        return Object.keys(this.hidden()).length;
    }

    async unhideAll(): Promise<void> {
        await this.storage.update(HIDDEN_KEY, undefined);
        this.update(this.lastSnapshots);
    }

    private hidden(): HiddenThreads {
        return { ...this.storage.get<HiddenThreads>(HIDDEN_KEY, {}) };
    }

    dispose(): void {
        this.threads.forEach(entry => entry.thread.dispose());
        this.threads.clear();
        this.controller.dispose();
        this.registration.dispose();
    }
}
