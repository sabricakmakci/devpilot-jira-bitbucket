import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { errorMessage } from './http';
import { JiraClient, JiraIssue } from './jira';
import { Readiness, RuleResult, checkReadiness, readinessRules } from './readiness';
import { myTasksJql } from './validation';

interface RuleNode {
    task: string;
    index: number;
    result: RuleResult;
}

type TaskNode = JiraIssue | RuleNode;

const LEVEL_COLORS: Record<Readiness['level'], string> = {
    ready: 'charts.green',
    warning: 'charts.yellow',
    error: 'charts.red',
};

function isRule(node: TaskNode): node is RuleNode {
    return 'result' in node;
}

/** Lists the open Jira tasks assigned to the user, with their readiness checklist. */
export class TaskTreeProvider implements vscode.TreeDataProvider<TaskNode>, vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.emitter.event;
    private issues?: Promise<JiraIssue[]>;
    private readinessLoad?: Promise<void>;
    private readiness = new Map<string, Readiness>();
    private readinessError?: string;

    constructor(
        private readonly jira: JiraClient,
        private readonly activeKey: () => string | undefined,
        private readonly showError: (message: string | undefined) => void,
        private readonly log: vscode.LogOutputChannel,
    ) { }

    /** `reload` fetches the tasks again; otherwise only the items are redrawn. */
    refresh(reload = true): void {
        if (reload) {
            this.issues = undefined;
            this.readinessLoad = undefined;
        }
        this.emitter.fire();
    }

    async getChildren(element?: TaskNode): Promise<TaskNode[]> {
        if (element) {
            return isRule(element)
                ? []
                : (this.readiness.get(element.key)?.results ?? []).map((result, index) => ({ task: element.key, index, result }));
        }
        if (!(await this.jira.isConfigured())) {
            return [];
        }
        const issues = (this.issues ??= this.jira.searchIssues(myTasksJql()));
        this.readinessLoad ??= issues
            .then(loaded => checkReadiness(this.jira, loaded, readinessRules()))
            .then(
                readiness => {
                    this.readiness = readiness;
                    this.readinessError = undefined;
                },
                error => {
                    this.readiness = new Map();
                    this.readinessError = l10n.t('Could not check task readiness: {0}', errorMessage(error));
                    this.log.warn(this.readinessError);
                },
            );
        try {
            const result = await issues;
            await this.readinessLoad;
            this.showError(this.readinessError);
            return result;
        } catch (error) {
            this.issues = undefined;
            this.readinessLoad = undefined;
            this.showError(l10n.t('Could not load your Jira tasks: {0}', errorMessage(error)));
            return [];
        }
    }

    getTreeItem(node: TaskNode): vscode.TreeItem {
        return isRule(node) ? ruleItem(node) : this.taskItem(node);
    }

    private taskItem(issue: JiraIssue): vscode.TreeItem {
        const { summary, status, parent, issuetype } = issue.fields;
        const active = issue.key === this.activeKey();
        const readiness = this.readiness.get(issue.key);
        const item = new vscode.TreeItem(
            issue.key,
            readiness?.results.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        );
        item.id = issue.key;
        item.description = [summary, status?.name].filter(Boolean).join(' · ');
        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown(`**${issue.key}** `).appendText(summary ?? '');
        tooltip.appendMarkdown('\n\n').appendText([issuetype?.name, status?.name].filter(Boolean).join(' · '));
        if (parent) {
            tooltip.appendMarkdown('\n\n').appendText(`${parent.key} ${parent.fields?.summary ?? ''}`);
        }
        if (readiness) {
            tooltip.appendMarkdown('\n\n').appendText(readinessSummary(readiness));
        }
        if (active) {
            tooltip.appendMarkdown('\n\n').appendText(l10n.t('Active task'));
        }
        item.tooltip = tooltip;
        const color = readiness ? LEVEL_COLORS[readiness.level] : active ? 'charts.green' : undefined;
        item.iconPath = new vscode.ThemeIcon(active ? 'target' : 'issues', color ? new vscode.ThemeColor(color) : undefined);
        item.contextValue = 'task';
        item.command = { command: 'jiraBitbucketFlow.jira.setActiveTask', title: l10n.t('Set as Active Task'), arguments: [issue] };
        return item;
    }

    dispose(): void {
        this.emitter.dispose();
    }
}

function readinessSummary(readiness: Readiness): string {
    const failed = readiness.results.filter(result => result.state === 'failed').length;
    return failed === 0 ? l10n.t('Ready for development') : l10n.t('{0} readiness rules are not met', failed);
}

function ruleItem({ task, index, result }: RuleNode): vscode.TreeItem {
    const item = new vscode.TreeItem(result.rule.name);
    item.id = `${task}:rule:${index}`;
    item.contextValue = 'readinessRule';
    switch (result.state) {
        case 'passed':
            item.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
            break;
        case 'failed': {
            const warning = result.rule.severity === 'warning';
            item.iconPath = new vscode.ThemeIcon(warning ? 'warning' : 'error', new vscode.ThemeColor(warning ? 'charts.yellow' : 'charts.red'));
            item.description = result.detail;
            break;
        }
    }
    item.tooltip = result.detail ? `${result.target}: ${result.detail}` : result.target;
    return item;
}
