import * as fs from 'fs';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { API, findRepository } from '../git';
import { isInside } from '../ipc';
import { BitbucketConnection } from './client';
import { PrComment, PullRequest, flattenComments, repoPaths } from './model';
import { PullRequestSnapshot } from './watcher';

const SCHEME = 'jbf-pr';

interface ThreadEntry {
    thread: vscode.CommentThread;
    signature: string;
    pr: PullRequest;
    rootId: number;
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

    constructor(
        private readonly git: API | undefined,
        private readonly connection: BitbucketConnection,
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
        const wanted = new Set<string>();
        this.pullRequests.clear();
        for (const { pr, threads } of snapshots) {
            this.pullRequests.set(pr.key, pr);
            for (const root of threads) {
                const { uri, line } = this.location(pr, root);
                const key = `${pr.key}:${root.id}`;
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
                thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
                this.threads.set(key, { thread, signature, pr, rootId: root.id });
            }
        }
        for (const [key, entry] of this.threads) {
            if (!wanted.has(key)) {
                entry.thread.dispose();
                this.threads.delete(key);
            }
        }
    }

    find(thread: vscode.CommentThread): ThreadEntry | undefined {
        return [...this.threads.values()].find(entry => entry.thread === thread);
    }

    dispose(): void {
        this.threads.forEach(entry => entry.thread.dispose());
        this.threads.clear();
        this.controller.dispose();
        this.registration.dispose();
    }
}
