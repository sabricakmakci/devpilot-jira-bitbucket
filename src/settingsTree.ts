import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { BitbucketConnection } from './bitbucket/client';
import { HookState } from './hookInstaller';
import { errorMessage } from './http';
import { JiraClient, userId } from './jira';
import { pickReviewModel, reviewModelLabel } from './bitbucket/review';
import { readinessRules } from './readiness';

export type SettingKey =
    | 'commitCheck.allowedIssueTypes'
    | 'commitCheck.onViolation'
    | 'bitbucket.pollInterval'
    | 'bitbucket.panelComments'
    | 'branchPrefixes'
    | 'commentFix.excludeAuthors'
    | 'review.language'
    | 'review.model';

/** Keep in sync with the enum of jiraBitbucketFlow.review.language in package.json. */
const REVIEW_LANGUAGES = ['auto', 'en', 'tr', 'de', 'fr', 'es', 'it', 'nl', 'pt', 'ru', 'ar', 'ja', 'ko', 'zh-CN'];

export interface RepoCheck {
    root: string;
    name: string;
    state: HookState;
}

type Group = 'accounts' | 'commitCheck' | 'bitbucket' | 'general';

export interface SettingNode {
    item: vscode.TreeItem;
    group?: Group;
    /** Repository root of a commit check row. */
    root?: string;
}

function config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('jiraBitbucketFlow');
}

function settingLabel(key: SettingKey): string {
    switch (key) {
        case 'commitCheck.allowedIssueTypes':
            return l10n.t('Allowed issue types');
        case 'commitCheck.onViolation':
            return l10n.t('When there is a problem');
        case 'bitbucket.pollInterval':
            return l10n.t('Check interval');
        case 'branchPrefixes':
            return l10n.t('Branch prefixes');
        case 'commentFix.excludeAuthors':
            return l10n.t('Authors skipped by AI fix');
        case 'review.language':
            return l10n.t('AI review language');
        case 'review.model':
            return l10n.t('AI model');
        case 'bitbucket.panelComments':
            return l10n.t('Comments panel');
    }
}

function reviewLanguageLabel(code: string | undefined): string {
    if (!code || code === 'auto') {
        return l10n.t('Auto (VS Code language)');
    }
    try {
        const name = new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? code;
        return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
    } catch {
        return code;
    }
}

function panelCommentsLabel(value: string | undefined): string {
    return value === 'all' ? l10n.t('All comments') : l10n.t('Only the ones that concern me');
}

function violationLabel(value: string | undefined): string {
    return value === 'block' ? l10n.t('Block the commit') : l10n.t('Warn');
}

function settingItem(key: SettingKey, description: string, icon: string): SettingNode {
    const item = new vscode.TreeItem(settingLabel(key));
    item.id = `setting:${key}`;
    item.description = description;
    item.tooltip = l10n.t('Click to change');
    item.iconPath = new vscode.ThemeIcon(icon);
    item.contextValue = 'setting';
    item.command = { command: 'jiraBitbucketFlow.settings.edit', title: l10n.t('Change'), arguments: [key] };
    return { item };
}

function groupNode(group: Group, label: string, icon: string): SettingNode {
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `group:${group}`;
    item.iconPath = new vscode.ThemeIcon(icon);
    return { item, group };
}

function readinessRulesItem(count: number): SettingNode {
    const item = new vscode.TreeItem(l10n.t('Task readiness rules'));
    item.id = 'setting:readiness.rules';
    item.description = count > 0 ? l10n.t('{0} rules', count) : l10n.t('Not set');
    item.iconPath = new vscode.ThemeIcon('checklist');
    item.contextValue = 'readinessRules';
    if (count > 0) {
        item.tooltip = l10n.t('Rules that show whether a task is ready for development. Click to open the setting.');
        item.command = { command: 'workbench.action.openSettings', title: l10n.t('Change'), arguments: ['jiraBitbucketFlow.readiness.rules'] };
    } else {
        item.tooltip = l10n.t('Click to create the rules from your checklist with AI.');
        item.command = { command: 'jiraBitbucketFlow.readiness.generate', title: l10n.t('Create Readiness Rules with AI') };
    }
    return { item };
}

/** Accounts, per-repository commit check and settings, edited in place. */
export class SettingsTreeProvider implements vscode.TreeDataProvider<SettingNode>, vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.emitter.event;

    constructor(
        private readonly jira: JiraClient,
        private readonly bitbucket: BitbucketConnection,
        private readonly repoChecks: () => Promise<RepoCheck[]>,
    ) { }

    refresh(): void {
        this.emitter.fire();
    }

    getTreeItem(node: SettingNode): vscode.TreeItem {
        return node.item;
    }

    async getChildren(node?: SettingNode): Promise<SettingNode[]> {
        if (!node) {
            return [
                groupNode('accounts', l10n.t('Accounts'), 'account'),
                groupNode('commitCheck', l10n.t('Jira Commit Check'), 'shield'),
                groupNode('bitbucket', l10n.t('Bitbucket Notifications'), 'bell'),
                groupNode('general', l10n.t('General'), 'settings'),
            ];
        }
        const settings = config();
        switch (node.group) {
            case 'accounts':
                return Promise.all([this.jiraAccount(), this.bitbucketAccount()]);
            case 'commitCheck': {
                const types = settings.get<string[]>('commitCheck.allowedIssueTypes', []);
                return [
                    settingItem('commitCheck.allowedIssueTypes', types.length ? types.join(', ') : l10n.t('Any sub-task type'), 'list-filter'),
                    settingItem('commitCheck.onViolation', violationLabel(settings.get<string>('commitCheck.onViolation')), 'warning'),
                    ...(await this.repoChecks()).map(repo => this.repoItem(repo)),
                ];
            }
            case 'bitbucket':
                return [
                    settingItem('bitbucket.pollInterval', l10n.t('{0} seconds', settings.get<number>('bitbucket.pollInterval', 30)), 'watch'),
                    settingItem('commentFix.excludeAuthors', settings.get<string[]>('commentFix.excludeAuthors', []).join(', ') || '-', 'sparkle'),
                    settingItem('bitbucket.panelComments', panelCommentsLabel(settings.get<string>('bitbucket.panelComments')), 'comment-discussion'),
                    settingItem('review.language', reviewLanguageLabel(settings.get<string>('review.language')), 'globe'),
                    settingItem('review.model', await reviewModelLabel(), 'sparkle'),
                ];
            case 'general':
                return [
                    settingItem('branchPrefixes', settings.get<string[]>('branchPrefixes', []).join(', ') || '-', 'git-branch'),
                    readinessRulesItem(readinessRules().length),
                ];
            default:
                return [];
        }
    }

    dispose(): void {
        this.emitter.dispose();
    }

    private accountItem(label: string, contextValue: string, configureCommand: string): vscode.TreeItem {
        const item = new vscode.TreeItem(label);
        item.id = `account:${label}`;
        item.contextValue = contextValue;
        item.command = { command: configureCommand, title: l10n.t('Set Up Connection') };
        item.description = l10n.t('Not connected. Click to sign in.');
        item.iconPath = new vscode.ThemeIcon('circle-large-outline');
        return item;
    }

    private connected(item: vscode.TreeItem, contextValue: string, host: string, user: Promise<string>): Promise<SettingNode> {
        item.contextValue = contextValue;
        item.tooltip = l10n.t('Click to change the connection');
        return user.then(
            name => {
                item.description = `${name} · ${host}`;
                item.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
                return { item };
            },
            error => {
                item.description = `${host} · ${errorMessage(error)}`;
                item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
                return { item };
            },
        );
    }

    private async jiraAccount(): Promise<SettingNode> {
        const item = this.accountItem('Jira', 'jiraAccount', 'jiraBitbucketFlow.jira.configure');
        if (!(await this.jira.isConfigured())) {
            return { item };
        }
        const user = this.jira.getMyself().then(me => me.displayName ?? userId(me) ?? '?');
        return this.connected(item, 'jiraAccount.connected', new URL(this.jira.baseUrl).host, user);
    }

    private async bitbucketAccount(): Promise<SettingNode> {
        const item = this.accountItem('Bitbucket', 'bitbucketAccount', 'jiraBitbucketFlow.bitbucket.configure');
        const baseUrl = this.bitbucket.baseUrl;
        if (!baseUrl || !(await this.bitbucket.api())) {
            return { item };
        }
        const user = this.bitbucket.user().then(me => me?.name ?? '?');
        return this.connected(item, 'bitbucketAccount.connected', new URL(baseUrl).host, user);
    }

    private repoItem(repo: RepoCheck): SettingNode {
        const item = new vscode.TreeItem(repo.name);
        item.id = `repo:${repo.root}`;
        item.tooltip = repo.root;
        item.contextValue = `repoCheck.${repo.state}`;
        switch (repo.state) {
            case 'managed':
                item.description = l10n.t('Commit check enabled');
                item.iconPath = new vscode.ThemeIcon('repo', new vscode.ThemeColor('charts.green'));
                break;
            case 'missing':
                item.description = l10n.t('Commit check disabled');
                item.iconPath = new vscode.ThemeIcon('repo');
                break;
            case 'foreign':
                item.description = l10n.t('Another commit-msg hook is installed');
                item.iconPath = new vscode.ThemeIcon('repo', new vscode.ThemeColor('problemsWarningIcon.foreground'));
                break;
            case 'unsupported':
                item.description = l10n.t('Not supported (core.hooksPath)');
                item.iconPath = new vscode.ThemeIcon('repo', new vscode.ThemeColor('disabledForeground'));
                break;
        }
        return { item, root: repo.root };
    }
}

export async function editSetting(key: SettingKey): Promise<void> {
    const settings = config();
    const title = settingLabel(key);
    let value: unknown;
    switch (key) {
        case 'commitCheck.allowedIssueTypes':
        case 'branchPrefixes':
        case 'commentFix.excludeAuthors': {
            const prompts: Record<string, string> = {
                branchPrefixes: l10n.t('Separate values with commas, e.g. feature, bugfix, hotfix.'),
                'commentFix.excludeAuthors': l10n.t('Separate user names with commas. Their comments are left out when all comments are fixed with AI. Bots are always left out.'),
            };
            const input = await vscode.window.showInputBox({
                title,
                prompt: prompts[key] ?? l10n.t('Separate values with commas. Leave empty to allow any sub-task type.'),
                value: settings.get<string[]>(key, []).join(', '),
                ignoreFocusOut: true,
            });
            if (input === undefined) {
                return;
            }
            value = [...new Set(input.split(',').map(part => part.trim()).filter(Boolean))];
            break;
        }
        case 'commitCheck.onViolation': {
            const current = settings.get<string>(key);
            const pick = await vscode.window.showQuickPick(
                [
                    { label: violationLabel('warn'), detail: l10n.t('Show a warning and let you choose whether to commit anyway.'), value: 'warn' },
                    { label: violationLabel('block'), detail: l10n.t('Abort the commit.'), value: 'block' },
                ].map(option => ({ ...option, description: option.value === current ? l10n.t('Current') : undefined })),
                { title },
            );
            if (!pick) {
                return;
            }
            value = pick.value;
            break;
        }
        case 'review.language': {
            const current = settings.get<string>(key) || 'auto';
            const pick = await vscode.window.showQuickPick(
                REVIEW_LANGUAGES.map(code => ({
                    label: reviewLanguageLabel(code),
                    description: code === current ? l10n.t('Current') : undefined,
                    value: code,
                })),
                { title },
            );
            if (!pick) {
                return;
            }
            value = pick.value;
            break;
        }
        case 'review.model':
            // The picker saves the setting itself, so that it also works from the command palette.
            await pickReviewModel();
            return;
        case 'bitbucket.panelComments': {
            const current = settings.get<string>(key) || 'involved';
            const pick = await vscode.window.showQuickPick(
                [
                    {
                        label: panelCommentsLabel('involved'),
                        detail: l10n.t('Comments on your own pull requests, and threads you took part in on the ones you review.'),
                        value: 'involved',
                    },
                    {
                        label: panelCommentsLabel('all'),
                        detail: l10n.t('Every comment of every listed pull request.'),
                        value: 'all',
                    },
                ].map(option => ({ ...option, description: option.value === current ? l10n.t('Current') : undefined })),
                { title },
            );
            if (!pick) {
                return;
            }
            value = pick.value;
            break;
        }
        case 'bitbucket.pollInterval': {
            const input = await vscode.window.showInputBox({
                title,
                prompt: l10n.t('Seconds between checks (15 or more).'),
                value: String(settings.get<number>(key, 30)),
                ignoreFocusOut: true,
                validateInput: text => (/^\d+$/.test(text.trim()) && Number(text) >= 15 ? undefined : l10n.t('Enter a whole number of 15 or more.')),
            });
            if (input === undefined) {
                return;
            }
            value = Number(input.trim());
            break;
        }
    }
    // Keep editing the workspace value if one overrides the user setting.
    const target = settings.inspect(key)?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await settings.update(key, value, target);
}
