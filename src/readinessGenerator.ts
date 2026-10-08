import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { JiraClient } from './jira';
import { ReadinessRule } from './readiness';

const MAX_CHECKLIST_LENGTH = 20000;
const MAX_FIELDS = 600;

const PROMPT = `You turn a team's "ready for development" checklist into rules for a VS Code extension that checks Jira issues.
Answer with a JSON array only, no other text. Each item is a rule object with these properties:
- "name" (required): short text shown in the checklist, in the language of the checklist.
- "issue": "parent" (default: the story that the developer's sub-task belongs to) or "task" (the developer's sub-task itself). Omit it for "parent".
- "field": exact Jira field name from the list below. Without "matches" the field must not be empty.
- "matches": JavaScript regular expression, matched case-insensitively against each value of the field. The rule passes when any value matches. Values are version names, component names, option values, user display names, linked issue keys (for "Linked Issues"), the parent issue key (for "Epic Link", "Parent Link" and "Parent") or the plain text of text fields.
- "lowestUnreleased": true with a version field (e.g. "Fix Version/s"): each version must be the lowest version of the project that is not released yet ("the next version", "lowest live version + 1"). Versions with a different format, e.g. with a suffix, are compared separately.
- "subtask": {"type": regular expression for a sub-task type name from the list below, "done": true when it must be in a done status, "assigned": true when it must have an assignee}.
- "when": {"field": field name, "matches": regular expression}: apply the rule only when this matches, e.g. {"field": "Issue Type", "matches": "^Bug$"}.
- "severity": "warning" for nice-to-have items. Omit it for required items.
Guidelines:
- Create one rule per check. Split a checklist item that checks several things.
- Every rule must be checked automatically, so every rule needs a "field" or a "subtask". Find the closest check in Jira data, e.g. acceptance criteria: a field for them if there is one, otherwise "Description" matching the heading ("acceptance criteria" in the language of the checklist).
- Use only field names and sub-task types from the lists below. Never invent fields.
- A link to the issue one level above the story (epic, feature, initiative) is "Parent Link" if that field exists, else "Epic Link", else "Parent". Use "Linked Issues" only for other issue links.
- Do not add rules that are not in the checklist.`;

/** Turns a pasted checklist into readiness rules with the selected language model. */
export async function generateReadinessRules(jira: JiraClient, log: vscode.LogOutputChannel): Promise<void> {
    if (!(await jira.ensureConfigured())) {
        return;
    }
    const checklist = await checklistText();
    const model = checklist && (await chatModel());
    if (!checklist || !model) {
        return;
    }

    const generated = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: l10n.t('Creating readiness rules with AI…'), cancellable: true },
        async (_, token) => {
            const [fields, types] = await Promise.all([jira.listFields(), jira.issueTypes()]);
            const subtaskTypes = [...new Set(types.filter(type => type.subtask).map(type => type.name))];
            const issueTypes = [...new Set(types.filter(type => !type.subtask).map(type => type.name))];
            const context = [
                `Jira fields: ${[...new Set(fields.map(field => field.name))].slice(0, MAX_FIELDS).join('; ')}`,
                `Sub-task types: ${subtaskTypes.join('; ')}`,
                `Other issue types: ${issueTypes.join('; ')}`,
            ].join('\n');
            const response = await model.sendRequest(
                [
                    vscode.LanguageModelChatMessage.User(`${PROMPT}\n\n${context}`),
                    vscode.LanguageModelChatMessage.User(`Checklist:\n${checklist}`),
                ],
                { justification: l10n.t('Create task readiness rules from your checklist') },
                token,
            );
            let text = '';
            for await (const part of response.text) {
                text += part;
            }
            if (token.isCancellationRequested) {
                return undefined;
            }
            const rules = parseRules(text);
            if (rules.length === 0) {
                log.warn(`Readiness rule generation returned an unexpected answer: ${text.slice(0, 500)}`);
            }
            const known = new Set(fields.flatMap(field => [field.name.toLowerCase(), field.id.toLowerCase()]));
            return rules.map(rule => ({ rule, problem: findProblem(rule, known, subtaskTypes) }));
        },
    );
    if (!generated) {
        return;
    }
    if (generated.length === 0) {
        vscode.window.showWarningMessage(l10n.t('The AI model did not return any rules. Try again or choose another model.'));
        return;
    }

    const picks = await vscode.window.showQuickPick(
        generated.map(({ rule, problem }) => ({
            label: rule.name,
            description: problem && `$(warning) ${problem}`,
            detail: describeRule(rule),
            picked: !problem,
            rule,
        })),
        { title: l10n.t('Select the Rules to Save'), placeHolder: l10n.t('Rules with a warning are not selected.'), canPickMany: true, ignoreFocusOut: true },
    );
    if (!picks || picks.length === 0) {
        return;
    }
    await saveRules(picks.map(pick => pick.rule));
}

async function checklistText(): Promise<string | undefined> {
    const text = await vscode.window.showInputBox({
        title: l10n.t('Create Readiness Rules with AI'),
        prompt: l10n.t('Paste or write your checklist, then press Enter. It is sent to the AI model.'),
        placeHolder: l10n.t('e.g. Fix Version is set, a Test sub-task is assigned, the description has a design link'),
        ignoreFocusOut: true,
        validateInput: value => value.length > MAX_CHECKLIST_LENGTH
            ? l10n.t('The checklist is too long. Keep only the checklist items.')
            : undefined,
    });
    return text?.trim() || undefined;
}

/** Uses the model chosen for AI review, asking for one if none is chosen. */
async function chatModel(): Promise<vscode.LanguageModelChat | undefined> {
    const find = async () => {
        const id = vscode.workspace.getConfiguration('jiraBitbucketFlow.review').get<string>('model', '');
        return id ? (await vscode.lm.selectChatModels({ id }))[0] : undefined;
    };
    const model = await find();
    if (model) {
        return model;
    }
    await vscode.commands.executeCommand('jiraBitbucketFlow.review.selectModel');
    return find();
}

function parseRules(text: string): ReadinessRule[] {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start < 0 || end <= start) {
        return [];
    }
    let value: unknown;
    try {
        value = JSON.parse(text.slice(start, end + 1));
    } catch {
        return [];
    }
    return Array.isArray(value) ? value.map(toRule).filter((rule): rule is ReadinessRule => rule !== undefined) : [];
}

function toRule(value: unknown): ReadinessRule | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    const object = value as Record<string, unknown>;
    const name = text(object.name);
    if (!name) {
        return undefined;
    }
    const rule: ReadinessRule = { name };
    if (object.issue === 'task') {
        rule.issue = 'task';
    }
    const subtask = object.subtask as Record<string, unknown> | undefined;
    const field = text(object.field);
    if (subtask && typeof subtask === 'object') {
        rule.subtask = {};
        const type = text(subtask.type);
        if (type) {
            rule.subtask.type = type;
        }
        if (subtask.done === true) {
            rule.subtask.done = true;
        }
        if (subtask.assigned === true) {
            rule.subtask.assigned = true;
        }
    } else if (field) {
        rule.field = field;
        const matches = text(object.matches);
        if (matches) {
            rule.matches = matches;
        }
        if (object.lowestUnreleased === true) {
            rule.lowestUnreleased = true;
        }
    }
    const when = object.when as Record<string, unknown> | undefined;
    const whenField = when && typeof when === 'object' ? text(when.field) : undefined;
    if (whenField) {
        const matches = text(when?.matches);
        rule.when = matches ? { field: whenField, matches } : { field: whenField };
    }
    if (object.severity === 'warning') {
        rule.severity = 'warning';
    }
    return rule;
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function findProblem(rule: ReadinessRule, fields: Set<string>, subtaskTypes: string[]): string | undefined {
    if (!rule.field && !rule.subtask) {
        return l10n.t('The rule has no field or sub-task to check.');
    }
    for (const name of [rule.field, rule.when?.field]) {
        if (name && !fields.has(name.toLowerCase())) {
            return l10n.t("Jira has no field named '{0}'.", name);
        }
    }
    for (const pattern of [rule.matches, rule.when?.matches, rule.subtask?.type]) {
        if (pattern && !isValidRegex(pattern)) {
            return l10n.t("Invalid regular expression '{0}'.", pattern);
        }
    }
    const type = rule.subtask?.type;
    if (type && !subtaskTypes.some(name => new RegExp(type, 'i').test(name))) {
        return l10n.t("No sub-task type matches '{0}'.", type);
    }
    return undefined;
}

function isValidRegex(pattern: string): boolean {
    try {
        new RegExp(pattern, 'i');
        return true;
    } catch {
        return false;
    }
}

function describeRule(rule: ReadinessRule): string {
    const parts: string[] = [];
    if (rule.subtask) {
        const { type, done, assigned } = rule.subtask;
        const conditions = [type ?? l10n.t('any type'), done && l10n.t('done'), assigned && l10n.t('assigned')].filter(Boolean);
        parts.push(l10n.t('Sub-task: {0}', conditions.join(', ')));
    } else if (rule.field) {
        parts.push(rule.matches ? `${rule.field} ~ /${rule.matches}/` : l10n.t('{0} is not empty', rule.field));
        if (rule.lowestUnreleased) {
            parts.push(l10n.t('lowest unreleased version'));
        }
    }
    if (rule.when) {
        parts.push(l10n.t('only when {0}', rule.when.matches ? `${rule.when.field} ~ /${rule.when.matches}/` : rule.when.field));
    }
    if (rule.issue === 'task') {
        parts.push(l10n.t('on the task itself'));
    }
    if (rule.severity === 'warning') {
        parts.push(l10n.t('warning'));
    }
    return parts.join(' · ');
}

/** Saves to the user settings; asks whether to replace or extend existing rules. */
async function saveRules(rules: ReadinessRule[]): Promise<void> {
    const config = vscode.workspace.getConfiguration('jiraBitbucketFlow.readiness');
    const existing = config.inspect<ReadinessRule[]>('rules')?.globalValue ?? [];
    let value = rules;
    if (existing.length > 0) {
        const replace = l10n.t('Replace');
        const add = l10n.t('Add');
        const choice = await vscode.window.showInformationMessage(
            l10n.t('You already have {0} readiness rules.', existing.length),
            { modal: true, detail: l10n.t('Replace them with the new rules or add the new rules to them?') },
            replace,
            add,
        );
        if (!choice) {
            return;
        }
        value = choice === add ? [...existing, ...rules] : rules;
    }
    await config.update('rules', value, vscode.ConfigurationTarget.Global);

    const inspected = config.inspect<ReadinessRule[]>('rules');
    if (inspected?.workspaceValue !== undefined || inspected?.workspaceFolderValue !== undefined) {
        const open = l10n.t('Open Workspace Settings');
        const choice = await vscode.window.showWarningMessage(
            l10n.t('{0} rules were saved to your user settings, but this workspace has its own readiness rules, which are used instead.', value.length),
            open,
        );
        if (choice === open) {
            await vscode.commands.executeCommand('workbench.action.openWorkspaceSettingsFile');
        }
        return;
    }
    vscode.window.showInformationMessage(l10n.t('{0} readiness rules saved to your user settings.', value.length));
}
