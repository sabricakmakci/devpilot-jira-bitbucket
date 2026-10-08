import * as path from 'path';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { registerPullRequests } from './bitbucket/feature';
import { Repository, getGitApi, pickRepository } from './git';
import { HookInstaller } from './hookInstaller';
import { HookServer } from './hookServer';
import { errorMessage } from './http';
import { JIRA_TOKEN_SECRET, JiraClient, JiraIssue } from './jira';
import { checkReadiness, readinessRules } from './readiness';
import { generateReadinessRules } from './readinessGenerator';
import { RepoCheck, SettingKey, SettingNode, SettingsTreeProvider, editSetting } from './settingsTree';
import { TaskStatusBar } from './statusBar';
import { TaskTreeProvider } from './taskTree';
import { checkCommit, myTasksJql, withIssueKey } from './validation';

const DECLINED_REPOS_KEY = 'jiraBitbucketFlow.declinedRepos';
const EXTENSION_ID = 'Sabricakmakci.devpilot-jira-bitbucket';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const log = vscode.window.createOutputChannel('DevPilot', { log: true });
    const jira = new JiraClient(context.secrets);
    const statusBar = new TaskStatusBar(context.workspaceState, jira);
    const server = new HookServer(message => checkCommit(jira, message, log));
    context.subscriptions.push(log, statusBar, server);

    try {
        await server.start();
    } catch (error) {
        log.error(`Could not start the hook server: ${errorMessage(error)}`);
    }

    const git = await getGitApi();
    const bitbucket = registerPullRequests(context, git, log);
    const installer = git && new HookInstaller(git.git.path, context.asAbsolutePath(path.join('out', 'hook.js')));
    const repoName = (repo: Repository) => path.basename(repo.rootUri.fsPath);
    const declinedRepos = () => context.globalState.get<string[]>(DECLINED_REPOS_KEY, []);
    const setDeclined = (root: string, declined: boolean) => {
        const others = declinedRepos().filter(item => item !== root);
        return context.globalState.update(DECLINED_REPOS_KEY, declined ? [...others, root] : others);
    };

    const tasks = new TaskTreeProvider(jira, () => statusBar.activeKey, message => (tasksView.message = message), log);
    const tasksView = vscode.window.createTreeView('jiraBitbucketFlow.tasks', { treeDataProvider: tasks });
    const repoChecks = async (): Promise<RepoCheck[]> =>
        !git || !installer
            ? []
            : Promise.all(git.repositories.map(async repo => ({
                root: repo.rootUri.fsPath,
                name: repoName(repo),
                state: await installer.state(repo.rootUri.fsPath).catch(() => 'unsupported' as const),
            })));
    const settings = new SettingsTreeProvider(jira, bitbucket, repoChecks);
    context.subscriptions.push(tasks, tasksView, settings, vscode.window.createTreeView('jiraBitbucketFlow.settings', { treeDataProvider: settings }));

    const updateJiraState = async () => {
        await vscode.commands.executeCommand('setContext', 'jiraBitbucketFlow.jiraConfigured', await jira.isConfigured());
        tasks.refresh();
        settings.refresh();
        await statusBar.refresh();
    };

    async function setActiveTask(issue: JiraIssue): Promise<void> {
        await statusBar.setActive(issue);
        tasks.refresh(false);
    }

    async function pickMyTask(): Promise<JiraIssue | undefined> {
        if (!(await jira.ensureConfigured())) {
            return undefined;
        }
        const items = jira.searchIssues(myTasksJql()).then(issues =>
            issues.map(issue => ({
                label: issue.key,
                description: issue.fields.summary,
                detail: [
                    issue.fields.status?.name,
                    issue.fields.parent && `${issue.fields.parent.key} ${issue.fields.parent.fields?.summary ?? ''}`,
                ].filter(Boolean).join(' · '),
                issue,
            })),
        );
        const pick = await vscode.window.showQuickPick(items, {
            title: l10n.t('My Jira Tasks'),
            placeHolder: l10n.t('Select a task'),
            matchOnDescription: true,
            matchOnDetail: true,
        });
        if (pick) {
            await setActiveTask(pick.issue);
        }
        return pick?.issue;
    }

    async function activeTask(issue?: JiraIssue): Promise<JiraIssue | undefined> {
        if (!(await jira.ensureConfigured())) {
            return undefined;
        }
        if (issue) {
            return issue;
        }
        const key = statusBar.activeKey;
        return key ? jira.getIssue(key) : pickMyTask();
    }

    /** Asks before starting a task whose readiness rules fail. */
    async function confirmReadiness(issue: JiraIssue): Promise<boolean> {
        const rules = readinessRules();
        if (rules.length === 0) {
            return true;
        }
        let readiness;
        try {
            readiness = (await checkReadiness(jira, [issue], rules)).get(issue.key);
        } catch (error) {
            log.warn(`Readiness check failed for ${issue.key}: ${errorMessage(error)}`);
            return true;
        }
        if (!readiness || readiness.level !== 'error') {
            return true;
        }
        const detail = readiness.results
            .filter(result => result.state === 'failed')
            .map(result => `• ${result.rule.name}${result.detail ? `: ${result.detail}` : ''}`)
            .join('\n');
        const proceed = l10n.t('Start Anyway');
        const choice = await vscode.window.showWarningMessage(
            l10n.t('{0} is not ready for development', issue.key),
            { modal: true, detail },
            proceed,
        );
        return choice === proceed;
    }

    async function requireRepository(root?: string): Promise<Repository | undefined> {
        if (!git) {
            vscode.window.showErrorMessage(l10n.t('The built-in Git extension is not available.'));
            return undefined;
        }
        const repo = root && git.repositories.find(item => item.rootUri.fsPath === root);
        return repo || pickRepository(git);
    }

    async function enableCheck(repo: Repository): Promise<void> {
        if (!installer) {
            return;
        }
        const root = repo.rootUri.fsPath;
        const state = await installer.state(root);
        if (state === 'unsupported') {
            vscode.window.showWarningMessage(
                l10n.t('{0} uses a custom hooks directory (core.hooksPath). Add the commit-msg hook there manually.', repoName(repo)),
            );
            return;
        }
        if (state === 'foreign') {
            const replace = l10n.t('Replace');
            const choice = await vscode.window.showWarningMessage(
                l10n.t('{0} already has a commit-msg hook.', repoName(repo)),
                { modal: true, detail: l10n.t('The existing hook will be renamed to commit-msg.backup.') },
                replace,
            );
            if (choice !== replace) {
                return;
            }
        }
        await installer.install(root);
        await setDeclined(root, false);
        settings.refresh();
        vscode.window.showInformationMessage(l10n.t('Jira commit check enabled for {0}.', repoName(repo)));
        await jira.ensureConfigured();
    }

    async function offerCheck(repo: Repository): Promise<void> {
        if (!installer) {
            return;
        }
        const root = repo.rootUri.fsPath;
        try {
            const state = await installer.state(root);
            if (state === 'managed') {
                await installer.install(root);
                return;
            }
            if (state !== 'missing' || declinedRepos().includes(root)) {
                return;
            }
            const enable = l10n.t('Enable');
            const never = l10n.t('Never');
            const choice = await vscode.window.showInformationMessage(
                l10n.t('Check Jira issue keys in commit messages for {0}?', repoName(repo)),
                enable,
                never,
            );
            if (choice === enable) {
                await enableCheck(repo);
            } else if (choice === never) {
                await setDeclined(root, true);
            }
        } catch (error) {
            log.warn(`Commit hook check failed for ${root}: ${errorMessage(error)}`);
        }
    }

    const register = (command: string, callback: (...args: any[]) => Promise<unknown>) =>
        vscode.commands.registerCommand(command, async (...args: unknown[]) => {
            try {
                await callback(...args);
            } catch (error) {
                vscode.window.showErrorMessage(errorMessage(error));
            }
        });

    const insertIntoCommitMessage = async (issue: JiraIssue) => {
        const repo = git && (await pickRepository(git));
        if (repo) {
            repo.inputBox.value = withIssueKey(repo.inputBox.value, issue.key);
        }
    };

    context.subscriptions.push(
        register('jiraBitbucketFlow.jira.configure', async () => {
            if (await jira.configure()) {
                await updateJiraState();
            }
        }),

        register('jiraBitbucketFlow.jira.logout', async () => {
            const signOut = l10n.t('Sign Out');
            const choice = await vscode.window.showWarningMessage(
                l10n.t('Sign out of Jira?'),
                { modal: true, detail: l10n.t('The saved token is deleted from this computer.') },
                signOut,
            );
            if (choice === signOut) {
                await jira.logout();
            }
        }),

        register('jiraBitbucketFlow.jira.pickTask', async () => {
            const issue = await pickMyTask();
            if (issue) {
                await insertIntoCommitMessage(issue);
            }
        }),

        register('jiraBitbucketFlow.jira.setActiveTask', (issue: JiraIssue) => setActiveTask(issue)),

        register('jiraBitbucketFlow.jira.addToCommitMessage', async (issue: JiraIssue) => {
            await setActiveTask(issue);
            await insertIntoCommitMessage(issue);
        }),

        register('jiraBitbucketFlow.jira.refreshTasks', async () => {
            tasks.refresh();
            await statusBar.refresh();
        }),

        register('jiraBitbucketFlow.jira.openTask', async (issue?: JiraIssue) => {
            if (!(await jira.ensureConfigured())) {
                return;
            }
            const key = issue?.key ?? statusBar.activeKey ?? (await pickMyTask())?.key;
            if (key) {
                await vscode.env.openExternal(jira.browseUrl(key));
            }
        }),

        register('jiraBitbucketFlow.jira.createBranch', async (task?: JiraIssue) => {
            const repo = await requireRepository();
            const issue = repo && (await activeTask(task));
            if (!repo || !issue) {
                return;
            }
            const prefixes = vscode.workspace.getConfiguration('jiraBitbucketFlow').get<string[]>('branchPrefixes', []);
            const prefix = prefixes.length > 1
                ? await vscode.window.showQuickPick(prefixes, { placeHolder: l10n.t('Select a branch type') })
                : prefixes[0] ?? '';
            if (prefix === undefined) {
                return;
            }
            const name = await vscode.window.showInputBox({
                title: l10n.t('Create Branch from {0}', issue.key),
                value: prefix ? `${prefix}/${issue.key}` : issue.key,
                validateInput: value =>
                    value && !/[\s~^:?*[\\]|\.\.|@\{|^\/|\/$|\.lock$|\.$/.test(value) ? undefined : l10n.t('Invalid branch name.'),
            });
            if (name) {
                await repo.createBranch(name, true);
            }
        }),

        register('jiraBitbucketFlow.jira.transitionTask', async (task?: JiraIssue) => {
            const issue = await activeTask(task);
            if (!issue) {
                return;
            }
            const transitions = await jira.getTransitions(issue.key);
            if (transitions.length === 0) {
                vscode.window.showInformationMessage(l10n.t('No status changes are available for {0}.', issue.key));
                return;
            }
            const pick = await vscode.window.showQuickPick(
                transitions.map(transition => ({
                    label: transition.to?.name ?? transition.name,
                    description: transition.to && transition.to.name !== transition.name ? transition.name : undefined,
                    id: transition.id,
                    category: transition.to?.statusCategory?.key,
                })),
                {
                    title: l10n.t('Change Status of {0}', issue.key),
                    placeHolder: l10n.t('Current status: {0}', issue.fields.status?.name ?? '?'),
                },
            );
            if (!pick) {
                return;
            }
            if (pick.category === 'indeterminate' && !(await confirmReadiness(issue))) {
                return;
            }
            await jira.transition(issue.key, pick.id);
            tasks.refresh();
            await statusBar.refresh();
            vscode.window.showInformationMessage(l10n.t('{0} moved to {1}.', issue.key, pick.label));
        }),

        register('jiraBitbucketFlow.commitCheck.enable', async (node?: SettingNode) => {
            const repo = await requireRepository(node?.root);
            if (repo) {
                await enableCheck(repo);
            }
        }),

        register('jiraBitbucketFlow.commitCheck.disable', async (node?: SettingNode) => {
            const repo = await requireRepository(node?.root);
            if (!repo || !installer) {
                return;
            }
            const root = repo.rootUri.fsPath;
            const removed = await installer.uninstall(root);
            await setDeclined(root, true);
            settings.refresh();
            vscode.window.showInformationMessage(
                removed
                    ? l10n.t('Jira commit check disabled for {0}.', repoName(repo))
                    : l10n.t('Jira commit check is not enabled for {0}.', repoName(repo)),
            );
        }),

        register('jiraBitbucketFlow.settings.edit', (key: SettingKey) => editSetting(key)),
        register('jiraBitbucketFlow.readiness.generate', () => generateReadinessRules(jira, log)),
        register('jiraBitbucketFlow.settings.refresh', async () => {
            jira.reset();
            bitbucket.reset();
            settings.refresh();
        }),
        register('jiraBitbucketFlow.settings.openAll', async () =>
            vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${EXTENSION_ID}`)),

        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('jiraBitbucketFlow.jira')) {
                jira.reset();
                void updateJiraState();
            } else if (event.affectsConfiguration('jiraBitbucketFlow')) {
                if (event.affectsConfiguration('jiraBitbucketFlow.readiness')) {
                    tasks.refresh();
                }
                settings.refresh();
            }
        }),

        context.secrets.onDidChange(event => {
            if (event.key === JIRA_TOKEN_SECRET) {
                jira.reset();
                void updateJiraState();
            } else {
                settings.refresh();
            }
        }),
    );

    if (git) {
        context.subscriptions.push(
            git.onDidOpenRepository(repo => {
                settings.refresh();
                void offerCheck(repo);
            }),
            git.onDidCloseRepository(() => settings.refresh()),
        );
        git.repositories.forEach(repo => void offerCheck(repo));
    }
    void updateJiraState();
}

export function deactivate(): void { }
