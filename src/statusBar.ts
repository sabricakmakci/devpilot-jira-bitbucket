import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { JiraClient, JiraIssue } from './jira';

const ACTIVE_TASK_KEY = 'jiraBitbucketFlow.activeTask';
const TOOLTIP_COMMANDS = [
    'jiraBitbucketFlow.jira.openTask',
    'jiraBitbucketFlow.jira.transitionTask',
    'jiraBitbucketFlow.jira.createBranch',
    'jiraBitbucketFlow.jira.pickTask',
];

export class TaskStatusBar implements vscode.Disposable {
    private readonly item = vscode.window.createStatusBarItem('jiraBitbucketFlow.task', vscode.StatusBarAlignment.Left, 100);
    private issue?: JiraIssue;

    constructor(private readonly state: vscode.Memento, private readonly jira: JiraClient) {
        this.item.name = l10n.t('Jira Task');
        this.render();
        this.item.show();
    }

    get activeKey(): string | undefined {
        return this.state.get<string>(ACTIVE_TASK_KEY);
    }

    async setActive(issue: JiraIssue): Promise<void> {
        await this.state.update(ACTIVE_TASK_KEY, issue.key);
        this.issue = issue;
        this.render();
    }

    async refresh(): Promise<void> {
        const key = this.activeKey;
        if (key && (await this.jira.isConfigured())) {
            try {
                this.issue = await this.jira.getIssue(key);
            } catch {
                // Keep the last known details, e.g. while offline.
            }
        }
        this.render();
    }

    private render(): void {
        const key = this.activeKey;
        if (!key) {
            this.item.text = `$(issues) ${l10n.t('Pick Jira Task')}`;
            this.item.tooltip = l10n.t('Select one of your Jira tasks');
            this.item.command = 'jiraBitbucketFlow.jira.pickTask';
            return;
        }

        const issue = this.issue?.key === key ? this.issue : undefined;
        const status = issue?.fields.status?.name;
        this.item.text = `$(issues) ${key}${status ? ` · ${status}` : ''}`;
        this.item.command = 'jiraBitbucketFlow.jira.openTask';

        const tooltip = new vscode.MarkdownString(undefined, true);
        tooltip.isTrusted = { enabledCommands: TOOLTIP_COMMANDS };
        tooltip.appendMarkdown(`**${key}** `);
        if (issue?.fields.summary) {
            tooltip.appendText(issue.fields.summary);
        }
        const links = [
            `[$(link-external) ${l10n.t('Open in Jira')}](command:jiraBitbucketFlow.jira.openTask)`,
            `[$(arrow-swap) ${l10n.t('Change Status')}](command:jiraBitbucketFlow.jira.transitionTask)`,
            `[$(git-branch) ${l10n.t('Create Branch')}](command:jiraBitbucketFlow.jira.createBranch)`,
            `[$(list-selection) ${l10n.t('Pick Another Task')}](command:jiraBitbucketFlow.jira.pickTask)`,
        ];
        tooltip.appendMarkdown(`\n\n${links.join(' · ')}`);
        this.item.tooltip = tooltip;
    }

    dispose(): void {
        this.item.dispose();
    }
}
