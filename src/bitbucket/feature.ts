import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { API, remoteLocations } from '../git';
import { errorMessage } from '../http';
import { BITBUCKET_TOKEN_SECRET, BitbucketConnection } from './client';
import { CommentFixer } from './commentFix';
import { PullRequestComments } from './comments';
import { PrComment, PullRequest, RepoRef } from './model';
import { DraftComment, PullRequestReviewer } from './review';
import { PullRequestNode, PullRequestTreeProvider } from './tree';
import { PullRequestUpdate, PullRequestWatcher } from './watcher';

const VIEW_IDS = ['jiraBitbucketFlow.pullRequestsPanel'];
const MAX_SEPARATE_NOTIFICATIONS = 3;

function snippet(text: string, max = 100): string {
    const line = text.replace(/\s+/g, ' ').trim();
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function registerPullRequests(
    context: vscode.ExtensionContext,
    git: API | undefined,
    log: vscode.LogOutputChannel,
): BitbucketConnection {
    const connection = new BitbucketConnection(context.secrets);
    const localRepos = (host: string): RepoRef[] =>
        !git
            ? []
            : remoteLocations(git)
                .filter(location => location.host === host)
                .map(location => {
                    const [project, slug] = location.path.split('/');
                    return { project, slug };
                });
    const watcher = new PullRequestWatcher(connection, context.globalState, log, localRepos);
    const reviewer = new PullRequestReviewer(connection, git, log);
    const tree = new PullRequestTreeProvider(watcher, pr => reviewer.draftCount(pr));
    const views = VIEW_IDS.map(id => vscode.window.createTreeView(id, { treeDataProvider: tree, showCollapseAll: true }));
    const editorComments = new PullRequestComments(git, connection);
    const fixer = new CommentFixer(connection, watcher, git);

    const allThreads = () => [
        ...watcher.snapshots,
        ...watcher.reviewRequests.map(pr => ({ pr, threads: watcher.reviewThreads.get(pr.key) ?? [] })),
    ];

    const updateView = () => {
        const { state } = watcher;
        void vscode.commands.executeCommand('setContext', 'jiraBitbucketFlow.bitbucketConfigured', state.kind !== 'notConfigured');
        const unread = watcher.unreadCount();
        for (const view of views) {
            view.message = state.kind === 'error' ? l10n.t('Could not refresh pull requests: {0}', state.message) : undefined;
            view.badge = unread > 0 ? { value: unread, tooltip: l10n.t('{0} unread comments', unread) } : undefined;
        }
        tree.refresh();
        editorComments.update(allThreads());
    };

    const suggestedUrl = () => {
        const host = git && remoteLocations(git).find(location => location.host.includes('bitbucket'))?.host;
        return host && `https://${host}`;
    };

    const openPullRequest = (pr: PullRequest) => vscode.env.openExternal(vscode.Uri.parse(pr.url));

    const isReviewer = (pr: PullRequest) => watcher.reviewRequests.some(item => item.key === pr.key);

    const setReviewStatus = async (pr: PullRequest, status: 'APPROVED' | 'NEEDS_WORK') => {
        const api = await connection.api();
        const me = await connection.user();
        if (!api || !me) {
            throw new Error(l10n.t('The Bitbucket connection is not set up.'));
        }
        await api.setReviewStatus(pr, me, status);
        vscode.window.setStatusBarMessage(
            status === 'APPROVED' ? l10n.t('#{0} approved.', pr.id) : l10n.t('#{0} marked as needs work.', pr.id),
            4000,
        );
        await watcher.poll(true);
    };

    /** Offers to approve or request changes after a review, for pull requests the user reviews. */
    const offerReviewStatus = async (pr: PullRequest, message: string) => {
        const approve = l10n.t('Approve');
        const needsWork = l10n.t('Needs Work');
        const choice = await vscode.window.showInformationMessage(message, ...(isReviewer(pr) ? [approve, needsWork] : []));
        if (choice === approve || choice === needsWork) {
            await setReviewStatus(pr, choice === approve ? 'APPROVED' : 'NEEDS_WORK');
        }
    };

    const pickPullRequest = async (candidates: PullRequest[], placeHolder: string) => {
        if (candidates.length <= 1) {
            return candidates[0];
        }
        const pick = await vscode.window.showQuickPick(
            candidates.map(pr => ({ label: `#${pr.id} ${pr.title}`, description: `${pr.repo.slug}: ${pr.sourceBranch} → ${pr.targetBranch}`, pr })),
            { placeHolder, matchOnDescription: true },
        );
        return pick?.pr;
    };

    const sendAllDrafts = async (pr: PullRequest) => {
        const count = reviewer.draftCount(pr);
        const send = l10n.t('Send');
        const choice = await vscode.window.showWarningMessage(
            l10n.t('Send {0} AI draft comments to #{1}?', count, pr.id),
            { modal: true, detail: l10n.t('They are posted to Bitbucket under your name.') },
            send,
        );
        if (choice !== send) {
            return;
        }
        const sent = await reviewer.sendAll(pr);
        await watcher.poll(true);
        await offerReviewStatus(pr, l10n.t('{0} comments sent to #{1}.', sent, pr.id));
    };

    let lastReviewInstructions = '';
    const startReview = async (pr: PullRequest, extra?: string) => {
        const result = await reviewer.review(pr, extra);
        if (!result) {
            return;
        }
        if (result.drafts === 0) {
            await offerReviewStatus(pr, l10n.t('The AI review found no problems in #{0}.', pr.id));
            return;
        }
        const sendAll = l10n.t('Send All');
        const showAll = l10n.t('Show All');
        const choice = await vscode.window.showInformationMessage(
            l10n.t('The AI review left {0} draft comments in {1} files of #{2}. Edit or discard them, then send the ones you agree with.', result.drafts, result.files, pr.id),
            showAll,
            sendAll,
        );
        if (choice === showAll) {
            await vscode.commands.executeCommand('workbench.panel.comments.focus');
        } else if (choice === sendAll) {
            await sendAllDrafts(pr);
        }
    };

    const nodePullRequest = (node?: PullRequestNode) => (node && node.kind !== 'group' ? node.pr : undefined);

    const openComment = async (pr: PullRequest, comment: PrComment) => {
        await watcher.markRead(pr, [comment.id]);
        const { uri, line } = editorComments.location(pr, comment);
        await vscode.window.showTextDocument(uri, { selection: new vscode.Range(line, 0, line, 0), preview: true });
    };

    const openCommentInBrowser = async (pr: PullRequest, commentId: number) => {
        await watcher.markRead(pr, [commentId]);
        const api = await connection.api();
        await vscode.env.openExternal(vscode.Uri.parse(api ? api.commentUrl(pr, commentId) : pr.url));
    };

    const sendReply = async (pr: PullRequest, parentId: number, text: string) => {
        const api = await connection.api();
        if (!api) {
            throw new Error(l10n.t('The Bitbucket connection is not set up.'));
        }
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: l10n.t('Sending reply…') },
            () => api.reply(pr, parentId, text),
        );
        vscode.window.setStatusBarMessage(l10n.t('Reply sent.'), 4000);
        await watcher.poll(true);
    };

    const replyTo = async (pr: PullRequest, comment: PrComment) => {
        const text = await vscode.window.showInputBox({
            title: l10n.t('Reply to {0} on #{1}', comment.author.name, pr.id),
            prompt: snippet(comment.text, 200),
            placeHolder: l10n.t('Write a reply'),
            ignoreFocusOut: true,
            validateInput: value => (value.trim() ? undefined : l10n.t('The reply cannot be empty.')),
        });
        if (!text) {
            return;
        }
        await watcher.markRead(pr, [comment.id]);
        await sendReply(pr, comment.id, text.trim());
    };

    const notifyOne = async ({ pr, event, comment }: PullRequestUpdate) => {
        const who = event.user?.name ?? '';
        const ref = `#${pr.id} ${pr.title}`;
        const text = event.text ? snippet(event.text) : '';
        const message = {
            comment: () => l10n.t('{0} commented on {1}: {2}', who, ref, text),
            reply: () => l10n.t('{0} replied to your comment on {1}: {2}', who, ref, text),
            approved: () => l10n.t('{0} approved {1}.', who, ref),
            needsWork: () => l10n.t('{0} requested changes on {1}.', who, ref),
            merged: () => l10n.t('{0} was merged.', ref),
            declined: () => l10n.t('{0} was declined.', ref),
        }[event.kind]();
        const reply = l10n.t('Reply');
        const open = l10n.t('Open');
        const actions = comment ? [reply, open] : [open];
        const warn = event.kind === 'needsWork' || event.kind === 'declined';
        const choice = await (warn ? vscode.window.showWarningMessage : vscode.window.showInformationMessage)(message, ...actions);
        if (choice === reply && comment) {
            await replyTo(pr, comment);
        } else if (choice === open) {
            await (comment ? openComment(pr, comment) : openPullRequest(pr));
        }
    };

    const notify = async (updates: PullRequestUpdate[]) => {
        if (updates.length > MAX_SEPARATE_NOTIFICATIONS) {
            const show = l10n.t('Show');
            const choice = await vscode.window.showInformationMessage(l10n.t('{0} new updates on your pull requests.', updates.length), show);
            if (choice === show) {
                await vscode.commands.executeCommand(`${VIEW_IDS[0]}.focus`);
            }
            return;
        }
        await Promise.all(updates.map(notifyOne));
    };

    const register = (command: string, callback: (...args: any[]) => Promise<unknown>) =>
        vscode.commands.registerCommand(command, async (...args: unknown[]) => {
            try {
                await callback(...args);
            } catch (error) {
                log.error(`${command} failed: ${errorMessage(error)}`);
                vscode.window.showErrorMessage(errorMessage(error));
            }
        });

    const resetConnection = () => {
        connection.reset();
        watcher.reset();
    };

    context.subscriptions.push(
        watcher,
        tree,
        ...views,
        editorComments,
        reviewer,
        fixer,
        reviewer.onDidChangeDrafts(() => tree.refresh()),
        watcher.onDidChange(updateView),
        watcher.onDidReceiveUpdates(updates =>
            notify(updates).catch(error => log.error(`Notification failed: ${errorMessage(error)}`)),
        ),

        register('jiraBitbucketFlow.bitbucket.configure', async () => {
            if (await connection.configure(suggestedUrl())) {
                resetConnection();
            }
        }),
        register('jiraBitbucketFlow.bitbucket.refresh', () => watcher.poll(true)),
        register('jiraBitbucketFlow.bitbucket.logout', async () => {
            const signOut = l10n.t('Sign Out');
            const choice = await vscode.window.showWarningMessage(
                l10n.t('Sign out of Bitbucket?'),
                { modal: true, detail: l10n.t('The saved token is deleted from this computer.') },
                signOut,
            );
            if (choice === signOut) {
                await connection.logout();
            }
        }),
        register('jiraBitbucketFlow.bitbucket.markAllRead', () => watcher.markAllRead()),
        register('jiraBitbucketFlow.bitbucket.openPullRequest', async (node?: PullRequestNode) => {
            const pr = nodePullRequest(node);
            if (pr) {
                await openPullRequest(pr);
            }
        }),
        register('jiraBitbucketFlow.bitbucket.openComment', async (node?: PullRequestNode) => {
            if (node?.kind === 'comment') {
                await openComment(node.pr, node.comment);
            }
        }),
        register('jiraBitbucketFlow.bitbucket.openCommentInBrowser', async (target?: PullRequestNode | vscode.CommentThread) => {
            if (target && 'kind' in target) {
                if (target.kind === 'comment') {
                    await openCommentInBrowser(target.pr, target.comment.id);
                }
                return;
            }
            const entry = target && editorComments.find(target);
            if (entry) {
                await openCommentInBrowser(entry.pr, entry.rootId);
            }
        }),
        register('jiraBitbucketFlow.bitbucket.reply', async (node?: PullRequestNode) => {
            if (node?.kind === 'comment') {
                await replyTo(node.pr, node.comment);
            }
        }),
        register('jiraBitbucketFlow.bitbucket.replyInEditor', async (reply: vscode.CommentReply) => {
            const entry = editorComments.find(reply.thread);
            const text = reply.text.trim();
            if (entry && text) {
                await sendReply(entry.pr, entry.rootId, text);
            }
        }),

        register('jiraBitbucketFlow.review.start', async (node?: PullRequestNode) => {
            const pr = nodePullRequest(node) ?? await pickPullRequest(
                [...watcher.reviewRequests, ...watcher.snapshots.map(snapshot => snapshot.pr)],
                l10n.t('Select a pull request to review'),
            );
            if (pr) {
                await startReview(pr);
            }
        }),
        register('jiraBitbucketFlow.review.startWithInstructions', async (node?: PullRequestNode) => {
            const pr = nodePullRequest(node) ?? await pickPullRequest(
                [...watcher.reviewRequests, ...watcher.snapshots.map(snapshot => snapshot.pr)],
                l10n.t('Select a pull request to review'),
            );
            if (!pr) {
                return;
            }
            const extra = await vscode.window.showInputBox({
                title: l10n.t('AI review of #{0}', pr.id),
                prompt: l10n.t('What should the AI pay extra attention to? It is added to the review instructions.'),
                placeHolder: l10n.t('e.g. Check null safety and that every new text is localized'),
                value: lastReviewInstructions,
                ignoreFocusOut: true,
            });
            if (extra?.trim()) {
                lastReviewInstructions = extra.trim();
                await startReview(pr, lastReviewInstructions);
            }
        }),
        register('jiraBitbucketFlow.review.selectModel', () => reviewer.selectModel()),
        register('jiraBitbucketFlow.review.sendAll', async (node?: PullRequestNode) => {
            const pr = nodePullRequest(node) ?? await pickPullRequest(reviewer.pending(), l10n.t('Select a pull request'));
            if (pr && reviewer.draftCount(pr) > 0) {
                await sendAllDrafts(pr);
            }
        }),
        register('jiraBitbucketFlow.review.discardAll', async (node?: PullRequestNode) => {
            const pr = nodePullRequest(node) ?? await pickPullRequest(reviewer.pending(), l10n.t('Select a pull request'));
            if (pr) {
                reviewer.discardAll(pr);
            }
        }),
        register('jiraBitbucketFlow.review.sendDraft', (thread: vscode.CommentThread) => reviewer.send(thread)),
        register('jiraBitbucketFlow.review.discardDraft', async (thread: vscode.CommentThread) => reviewer.discard(thread)),
        register('jiraBitbucketFlow.review.editDraft', async (comment: DraftComment) => reviewer.edit(comment)),
        register('jiraBitbucketFlow.review.saveDraft', async (comment: DraftComment) => reviewer.save(comment)),
        register('jiraBitbucketFlow.review.cancelEdit', async (comment: DraftComment) => reviewer.cancelEdit(comment)),
        register('jiraBitbucketFlow.review.approve', async (node?: PullRequestNode) => {
            const pr = nodePullRequest(node);
            if (pr) {
                await setReviewStatus(pr, 'APPROVED');
            }
        }),
        register('jiraBitbucketFlow.review.needsWork', async (node?: PullRequestNode) => {
            const pr = nodePullRequest(node);
            if (pr) {
                await setReviewStatus(pr, 'NEEDS_WORK');
            }
        }),
        register('jiraBitbucketFlow.commentFix.fixComment', async (node?: PullRequestNode) => {
            if (node?.kind === 'comment') {
                await fixer.fix(node.pr, node.comment);
            }
        }),
        register('jiraBitbucketFlow.commentFix.fixAll', async (node?: PullRequestNode) => {
            const mine = watcher.snapshots.map(snapshot => snapshot.pr);
            if (!node && mine.length === 0) {
                vscode.window.showInformationMessage(l10n.t('You have no open pull requests.'));
                return;
            }
            const pr = nodePullRequest(node) ?? await pickPullRequest(mine, l10n.t('Select a pull request'));
            if (pr) {
                await fixer.fix(pr);
            }
        }),

        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('jiraBitbucketFlow.bitbucket.baseUrl') || event.affectsConfiguration('jiraBitbucketFlow.bitbucket.email')) {
                resetConnection();
            }
        }),
        context.secrets.onDidChange(event => {
            if (event.key === BITBUCKET_TOKEN_SECRET) {
                resetConnection();
            }
        }),
    );
    if (git) {
        context.subscriptions.push(git.onDidOpenRepository(() => editorComments.update(allThreads())));
    }

    updateView();
    void watcher.poll();
    return connection;
}
