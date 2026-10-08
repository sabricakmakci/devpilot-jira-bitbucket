import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { HttpError, errorMessage } from './http';
import { ValidateResponse } from './ipc';
import { JiraClient, userId } from './jira';

const ISSUE_KEY = /\b[A-Z][A-Z0-9_]+-\d+\b/g;
const LEADING_ISSUE_KEY = /^\s*[A-Z][A-Z0-9_]+-\d+\s*/;
const SCISSORS_LINE = /^# -+ >8 -+$/m;

function config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('jiraBitbucketFlow.commitCheck');
}

/** An empty list means "any sub-task type". */
export function allowedIssueTypes(): string[] {
    return config().get<string[]>('allowedIssueTypes', []).filter(name => name.trim() !== '');
}

export function myTasksJql(): string {
    const allowed = allowedIssueTypes();
    const typeClause = allowed.length > 0
        ? `issuetype in (${allowed.map(name => `"${name.replace(/["\\]/g, '\\$&')}"`).join(', ')})`
        : 'issuetype in subTaskIssueTypes()';
    return `assignee = currentUser() AND ${typeClause} AND statusCategory != Done ORDER BY updated DESC`;
}

export function withIssueKey(message: string, key: string): string {
    return LEADING_ISSUE_KEY.test(message) ? message.replace(LEADING_ISSUE_KEY, `${key} `) : `${key} ${message}`;
}

function stripComments(message: string): string {
    const scissors = message.search(SCISSORS_LINE);
    return (scissors >= 0 ? message.slice(0, scissors) : message)
        .split(/\r?\n/)
        .filter(line => !line.startsWith('#'))
        .join('\n')
        .trim();
}

async function findProblems(jira: JiraClient, message: string): Promise<string[]> {
    const keys: string[] = [];
    for (const key of new Set(message.match(ISSUE_KEY) ?? [])) {
        if (await jira.projectExists(key.slice(0, key.lastIndexOf('-')))) {
            keys.push(key);
        }
    }
    if (keys.length === 0) {
        return [l10n.t('No Jira issue key found in the commit message.')];
    }

    const me = userId(await jira.getMyself());
    const allowed = allowedIssueTypes();
    const problems: string[] = [];
    for (const key of keys) {
        let issue;
        try {
            issue = await jira.getIssue(key);
        } catch (error) {
            if (error instanceof HttpError && error.status === 404) {
                problems.push(l10n.t('{0}: issue not found in Jira.', key));
                continue;
            }
            throw error;
        }

        const type = issue.fields.issuetype;
        const typeAllowed = allowed.length > 0 ? allowed.includes(type?.name ?? '') : type?.subtask === true;
        if (!typeAllowed) {
            const expected = allowed.length > 0 ? allowed.join(', ') : l10n.t('a sub-task');
            problems.push(l10n.t("{0}: issue type is '{1}', expected {2}.", key, type?.name ?? '?', expected));
        }
        if (userId(issue.fields.assignee) !== me) {
            const assignee = issue.fields.assignee?.displayName ?? l10n.t('unassigned');
            problems.push(l10n.t('{0}: not assigned to you (assignee: {1}).', key, assignee));
        }
    }
    return problems;
}

/** Called by the commit-msg hook (through the local hook server). */
export async function checkCommit(jira: JiraClient, rawMessage: string, log: vscode.LogOutputChannel): Promise<ValidateResponse> {
    const message = stripComments(rawMessage);
    if (!message || /^(Merge|Revert) /.test(message)) {
        return { allow: true, messages: [] };
    }
    if (!(await jira.isConfigured())) {
        return { allow: true, messages: [l10n.t('The Jira connection is not set up; the commit message was not checked.')] };
    }

    let problems: string[];
    try {
        problems = await findProblems(jira, message);
    } catch (error) {
        const text = l10n.t('Could not reach Jira; the commit message was not checked. ({0})', errorMessage(error));
        log.warn(text);
        void vscode.window.showWarningMessage(text);
        return { allow: true, messages: [text] };
    }
    if (problems.length === 0) {
        return { allow: true, messages: [] };
    }

    const detail = problems.join('\n');
    if (config().get<string>('onViolation') === 'block') {
        void vscode.window.showErrorMessage(l10n.t('Commit blocked by the Jira commit check'), { modal: true, detail });
        return { allow: false, messages: problems };
    }
    const proceed = l10n.t('Commit Anyway');
    const choice = await vscode.window.showWarningMessage(
        l10n.t('The Jira commit check found problems in the commit message'),
        { modal: true, detail },
        proceed,
    );
    return { allow: choice === proceed, messages: problems };
}
