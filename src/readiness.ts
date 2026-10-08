import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { JiraClient, JiraIssue, JiraVersion } from './jira';

/** A rule from the `jiraBitbucketFlow.readiness.rules` setting. */
export interface ReadinessRule {
    name: string;
    /** Which issue is checked: the parent of the task (default) or the task itself. */
    issue?: 'parent' | 'task';
    field?: string;
    matches?: string;
    /** Each version in `field` must be the lowest unreleased version of its kind (e.g. 2.2.0 and 1.2.0-beta are compared separately). */
    lowestUnreleased?: boolean;
    subtask?: { type?: string; done?: boolean; assigned?: boolean };
    when?: { field: string; matches?: string };
    severity?: 'error' | 'warning';
}

export type RuleState = 'passed' | 'failed';

export interface RuleResult {
    rule: ReadinessRule;
    state: RuleState;
    /** Key of the checked issue. */
    target: string;
    detail?: string;
}

export interface Readiness {
    level: 'ready' | 'warning' | 'error';
    results: RuleResult[];
}

const MAX_DETAIL_LENGTH = 80;

export function readinessRules(): ReadinessRule[] {
    return vscode.workspace
        .getConfiguration('jiraBitbucketFlow.readiness')
        .get<ReadinessRule[]>('rules', [])
        .filter(rule => typeof rule?.name === 'string' && rule.name.trim() !== '');
}

/** Checks the rules for each task with two Jira searches. Keyed by task key. */
export async function checkReadiness(jira: JiraClient, tasks: JiraIssue[], rules: ReadinessRule[]): Promise<Map<string, Readiness>> {
    if (rules.length === 0 || tasks.length === 0) {
        return new Map();
    }
    const fieldIds = await jira.fieldIds();
    const fieldId = (name: string) => fieldIds.get(name.trim().toLowerCase());
    const targetOf = (task: JiraIssue, rule: ReadinessRule) => (rule.issue === 'task' ? task.key : task.fields.parent?.key ?? task.key);

    const fields = new Set(['issuetype', 'status']);
    for (const rule of rules) {
        for (const name of [rule.field, rule.when?.field]) {
            const id = name && fieldId(name);
            if (id) {
                fields.add(id);
            }
        }
    }
    const targets = [...new Set(tasks.flatMap(task => rules.map(rule => targetOf(task, rule))))];
    const issues = new Map(
        (await jira.searchIssues(`key in (${targets.join(', ')})`, [...fields], targets.length)).map(issue => [issue.key, issue]),
    );

    const parents = [...new Set(tasks.flatMap(task => rules.filter(rule => rule.subtask).map(rule => targetOf(task, rule))))];
    const children = new Map<string, JiraIssue[]>();
    if (parents.length > 0) {
        const found = await jira.searchIssues(`parent in (${parents.join(', ')})`, ['issuetype', 'status', 'assignee', 'parent'], 500);
        for (const child of found) {
            const parent = child.fields.parent?.key;
            if (parent) {
                children.set(parent, [...(children.get(parent) ?? []), child]);
            }
        }
    }

    const result = new Map<string, Readiness>();
    const versions = new Map<string, JiraVersion[]>();
    if (rules.some(rule => rule.field && rule.lowestUnreleased)) {
        const projects = [...new Set([...issues.keys()].map(projectOf))];
        const lists = await Promise.all(projects.map(project => jira.projectVersions(project)));
        projects.forEach((project, index) => versions.set(project, lists[index]));
    }
    for (const task of tasks) {
        const results: RuleResult[] = [];
        for (const rule of rules) {
            const target = targetOf(task, rule);
            const issue = issues.get(target);
            if (!issue) {
                results.push({ rule, target, state: 'failed', detail: l10n.t('{0} could not be loaded.', target) });
                continue;
            }
            if (rule.when) {
                const condition = evaluateField(issue, fieldId(rule.when.field), rule.when.field, rule.when.matches);
                if (condition.error) {
                    results.push({ rule, target, state: 'failed', detail: condition.error });
                    continue;
                }
                if (!condition.passed) {
                    continue;
                }
            }
            results.push({ rule, target, ...evaluateRule(rule, issue, children.get(target) ?? [], fieldId, versions.get(projectOf(target)) ?? []) });
        }
        const failed = results.filter(item => item.state === 'failed');
        const level = failed.some(item => item.rule.severity !== 'warning') ? 'error' : failed.length > 0 ? 'warning' : 'ready';
        result.set(task.key, { level, results });
    }
    return result;
}

function evaluateRule(
    rule: ReadinessRule,
    issue: JiraIssue,
    children: JiraIssue[],
    fieldId: (name: string) => string | undefined,
    versions: JiraVersion[],
): { state: RuleState; detail?: string } {
    if (rule.subtask) {
        return evaluateSubtasks(rule.subtask, children);
    }
    if (rule.field) {
        const id = fieldId(rule.field);
        const check = evaluateField(issue, id, rule.field, rule.matches);
        if (!check.passed) {
            return { state: 'failed', detail: check.error ?? check.detail };
        }
        return rule.lowestUnreleased && id ? evaluateLowestUnreleased(texts(issue.fields[id]), versions) : { state: 'passed' };
    }
    return { state: 'failed', detail: l10n.t('The rule has no field or sub-task to check.') };
}

function evaluateField(
    issue: JiraIssue,
    id: string | undefined,
    name: string,
    pattern: string | undefined,
): { passed: boolean; detail?: string; error?: string } {
    if (!id) {
        return { passed: false, error: l10n.t("Jira has no field named '{0}'.", name) };
    }
    const regex = toRegex(pattern);
    if (regex === null) {
        return { passed: false, error: l10n.t("Invalid regular expression '{0}'.", pattern ?? '') };
    }
    const values = texts(issue.fields[id]);
    if (values.length === 0) {
        return { passed: false, detail: l10n.t('Empty') };
    }
    const passed = !regex || values.some(value => regex.test(value));
    return { passed, detail: passed ? undefined : shorten(values.join(', ')) };
}

function evaluateSubtasks(check: NonNullable<ReadinessRule['subtask']>, children: JiraIssue[]): { state: RuleState; detail?: string } {
    const type = toRegex(check.type);
    if (type === null) {
        return { state: 'failed', detail: l10n.t("Invalid regular expression '{0}'.", check.type ?? '') };
    }
    const candidates = children.filter(child => !type || type.test(child.fields.issuetype?.name ?? ''));
    if (candidates.length === 0) {
        return { state: 'failed', detail: l10n.t('No matching sub-task.') };
    }
    const passed = candidates.some(child =>
        (!check.done || child.fields.status?.statusCategory?.key === 'done') && (!check.assigned || child.fields.assignee));
    if (passed) {
        return { state: 'passed' };
    }
    const detail = candidates
        .map(child => [child.key, child.fields.status?.name, child.fields.assignee?.displayName ?? l10n.t('unassigned')].filter(Boolean).join(' · '))
        .join(', ');
    return { state: 'failed', detail: shorten(detail) };
}

/** Each version must be the lowest unreleased, unarchived version with the same format (digits ignored). */
function evaluateLowestUnreleased(values: string[], versions: JiraVersion[]): { state: RuleState; detail?: string } {
    const open = versions.filter(version => !version.released && !version.archived).map(version => version.name);
    const wrong = values.flatMap(value => {
        const expected = open.filter(name => versionFormat(name) === versionFormat(value)).sort(compareVersions)[0];
        return expected === value ? [] : [l10n.t('{0}, expected {1}', value, expected ?? '-')];
    });
    return wrong.length === 0 ? { state: 'passed' } : { state: 'failed', detail: shorten(wrong.join('; ')) };
}

function versionFormat(name: string): string {
    return name.replace(/\d+/g, '#');
}

function compareVersions(a: string, b: string): number {
    const left = (a.match(/\d+/g) ?? []).map(Number);
    const right = (b.match(/\d+/g) ?? []).map(Number);
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
        const difference = (left[index] ?? 0) - (right[index] ?? 0);
        if (difference !== 0) {
            return difference;
        }
    }
    return 0;
}

function projectOf(key: string): string {
    return key.slice(0, key.lastIndexOf('-'));
}

/** undefined: no pattern; null: invalid pattern. */
function toRegex(pattern: string | undefined): RegExp | undefined | null {
    if (!pattern) {
        return undefined;
    }
    try {
        return new RegExp(pattern, 'i');
    } catch {
        return null;
    }
}

/** Readable values of a Jira field: names of versions/components, keys of linked or parent issues, plain text. */
function texts(value: unknown): string[] {
    if (value === null || value === undefined || value === '') {
        return [];
    }
    if (Array.isArray(value)) {
        return value.flatMap(texts);
    }
    if (typeof value === 'object') {
        const object = value as Record<string, unknown>;
        const linked = (object.inwardIssue ?? object.outwardIssue) as { key?: unknown } | undefined;
        if (typeof linked?.key === 'string') {
            return [linked.key];
        }
        // Parent Link (Advanced Roadmaps) wraps the parent issue in `data`; without it the field is empty.
        if ('showField' in object || 'hasEpicLinkFieldDependency' in object) {
            return texts(object.data);
        }
        for (const property of ['name', 'value', 'key', 'issueKey', 'displayName']) {
            if (typeof object[property] === 'string') {
                return [object[property] as string];
            }
        }
        return [JSON.stringify(value)];
    }
    return [String(value)];
}

function shorten(text: string): string {
    const line = text.replace(/\s+/g, ' ').trim();
    return line.length > MAX_DETAIL_LENGTH ? `${line.slice(0, MAX_DETAIL_LENGTH - 1)}…` : line;
}
