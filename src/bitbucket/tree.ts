import * as path from 'path';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { PrComment, PullRequest, ReviewStatus } from './model';
import { PullRequestWatcher } from './watcher';

export type PullRequestNode =
    | { kind: 'group'; group: 'mine' | 'review' }
    | { kind: 'pullRequest'; pr: PullRequest; threads: PrComment[]; review: boolean }
    | { kind: 'comment'; pr: PullRequest; comment: PrComment };

function oneLine(text: string, max = 120): string {
    const line = text.replace(/\s+/g, ' ').trim();
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function statusLabel(status: ReviewStatus): string {
    switch (status) {
        case 'APPROVED':
            return l10n.t('Approved');
        case 'NEEDS_WORK':
            return l10n.t('Changes requested');
        default:
            return l10n.t('Not reviewed yet');
    }
}

function statusColor(status: ReviewStatus | undefined): vscode.ThemeColor | undefined {
    switch (status) {
        case 'NEEDS_WORK':
            return new vscode.ThemeColor('charts.orange');
        case 'APPROVED':
            return new vscode.ThemeColor('charts.green');
        default:
            return undefined;
    }
}

function pullRequestIcon(pr: PullRequest): vscode.ThemeIcon {
    const statuses = pr.reviewers.map(reviewer => reviewer.status);
    const status = statuses.includes('NEEDS_WORK') ? 'NEEDS_WORK' : statuses.includes('APPROVED') ? 'APPROVED' : undefined;
    return new vscode.ThemeIcon('git-pull-request', statusColor(status));
}

export class PullRequestTreeProvider implements vscode.TreeDataProvider<PullRequestNode> {
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.emitter.event;

    constructor(
        private readonly watcher: PullRequestWatcher,
        private readonly draftCount: (pr: PullRequest) => number,
    ) { }

    refresh(): void {
        this.emitter.fire();
    }

    dispose(): void {
        this.emitter.dispose();
    }

    getChildren(node?: PullRequestNode): PullRequestNode[] {
        if (!node) {
            const { snapshots, reviewRequests } = this.watcher;
            return snapshots.length === 0 && reviewRequests.length === 0
                ? []
                : [{ kind: 'group', group: 'mine' }, { kind: 'group', group: 'review' }];
        }
        switch (node.kind) {
            case 'group':
                return node.group === 'mine'
                    ? this.watcher.snapshots.map(({ pr, threads }) => ({ kind: 'pullRequest', pr, threads, review: false }))
                    : this.watcher.reviewRequests.map(pr => ({ kind: 'pullRequest', pr, threads: this.watcher.reviewThreads.get(pr.key) ?? [], review: true }));
            case 'pullRequest':
                return node.threads.map(comment => ({ kind: 'comment', pr: node.pr, comment }));
            case 'comment':
                return node.comment.replies.map(comment => ({ kind: 'comment', pr: node.pr, comment }));
        }
    }

    getTreeItem(node: PullRequestNode): vscode.TreeItem {
        switch (node.kind) {
            case 'group':
                return this.groupItem(node.group);
            case 'pullRequest':
                return this.pullRequestItem(node.pr, node.threads, node.review);
            case 'comment':
                return this.commentItem(node.pr, node.comment);
        }
    }

    private groupItem(group: 'mine' | 'review'): vscode.TreeItem {
        const count = group === 'mine' ? this.watcher.snapshots.length : this.watcher.reviewRequests.length;
        const item = new vscode.TreeItem(
            group === 'mine' ? l10n.t('Created by me') : l10n.t('Waiting for my review'),
            count > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
        );
        item.id = `group:${group}`;
        item.description = String(count);
        item.iconPath = new vscode.ThemeIcon(group === 'mine' ? 'account' : 'eye');
        return item;
    }

    private pullRequestItem(pr: PullRequest, threads: PrComment[], review: boolean): vscode.TreeItem {
        const unread = this.watcher.unreadCount(pr);
        const drafts = this.draftCount(pr);
        const myStatus = review ? pr.reviewers.find(reviewer => reviewer.user.id === this.watcher.me?.id)?.status : undefined;
        const item = new vscode.TreeItem(
            `#${pr.id} ${pr.title}`,
            threads.length === 0
                ? vscode.TreeItemCollapsibleState.None
                : unread > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.id = `${review ? 'review' : 'mine'}:${pr.key}`;
        item.description = [
            unread > 0 ? l10n.t('{0} new', unread) : undefined,
            review && threads.length > 0 ? l10n.t('{0} comments', threads.length) : undefined,
            drafts > 0 ? l10n.t('{0} AI drafts', drafts) : undefined,
            review ? pr.author?.name : undefined,
            `${pr.repo.slug}: ${pr.sourceBranch} → ${pr.targetBranch}`,
        ]
            .filter(Boolean)
            .join(' · ');
        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown(`**#${pr.id}** `).appendText(pr.title).appendMarkdown('\n\n');
        if (pr.author) {
            tooltip.appendText(l10n.t('Author: {0}', pr.author.name)).appendMarkdown('\n\n');
        }
        tooltip.appendText(`${pr.repo.project}/${pr.repo.slug}: ${pr.sourceBranch} → ${pr.targetBranch}`);
        for (const reviewer of pr.reviewers) {
            tooltip.appendMarkdown('\n\n- ').appendText(`${reviewer.user.name}: ${statusLabel(reviewer.status)}`);
        }
        item.tooltip = tooltip;
        item.iconPath = review ? new vscode.ThemeIcon('git-pull-request', statusColor(myStatus)) : pullRequestIcon(pr);
        item.contextValue = `${review ? 'reviewPullRequest' : 'pullRequest'}${drafts > 0 ? '+drafts' : ''}`;
        return item;
    }

    private commentItem(pr: PullRequest, comment: PrComment): vscode.TreeItem {
        const unread = this.watcher.isUnread(pr, comment.id);
        const item = new vscode.TreeItem(
            comment.author.name,
            comment.replies.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
        );
        item.id = `${pr.key}:${comment.id}`;
        const location = comment.parentId === undefined && comment.path
            ? `${path.posix.basename(comment.path)}${comment.line ? `:${comment.line}` : ''}`
            : undefined;
        item.description = [location, oneLine(comment.text)].filter(Boolean).join(' · ');
        const tooltip = new vscode.MarkdownString(comment.text);
        if (comment.path) {
            tooltip.appendMarkdown('\n\n---\n\n').appendText(`${comment.path}${comment.line ? `:${comment.line}` : ''}`);
        }
        item.tooltip = tooltip;
        item.iconPath = unread
            ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('notificationsInfoIcon.foreground'))
            : new vscode.ThemeIcon(comment.path ? 'comment' : 'comment-discussion');
        item.contextValue = 'comment';
        item.command = {
            command: 'jiraBitbucketFlow.bitbucket.openComment',
            title: l10n.t('Open Comment'),
            arguments: [{ kind: 'comment', pr, comment } satisfies PullRequestNode],
        };
        return item;
    }
}
