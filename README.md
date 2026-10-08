# DevPilot for Jira & Bitbucket

- **Jira:** makes sure every commit references a Jira task that is **assigned to you** and has the **right type**, so your commits are credited to the correct task in engineering metrics tools.
- **Bitbucket:** notifies you about new comments and reviews on your pull requests and lets you reply without leaving VS Code.

## Side panel

Click the **DevPilot** icon in the Activity Bar. The panel has three sections:

- **My Jira Tasks.** Your open tasks. Click a task to make it the active one. The row buttons add the key to the commit message, create a branch, change the status, or open the task in Jira.
- **Pull Requests.** Two groups:
  - **Created by me:** your open pull requests with their comments. Unread comments are marked, and the panel icon shows how many there are.
  - **Waiting for my review:** open pull requests where you are a reviewer, with all their comments. The icon color shows your review status.
- **Accounts & Settings.**
  - Sign in to or out of Jira and Bitbucket.
  - Turn the commit check on or off for each open repository.
  - Change settings by clicking them.

## Jira features

- **Commit check.** A `commit-msg` git hook sends the commit message to VS Code. VS Code checks each Jira key (for example `ABC-123`) against Jira. The check works for the Commit button and for terminal commits while VS Code is open. You get a warning, or the commit is blocked, when:
  - the message has no Jira key,
  - the issue doesn't exist,
  - the issue is not assigned to you,
  - the issue type is not allowed (default: `Development Task`).
- **Pick My Task.** Lists your open tasks and puts the selected key at the start of the commit message. You can run it from the Source Control title bar.
- **Status bar.** Shows the active task and its status. Click it to open the task in Jira. The tooltip has quick actions.
- **Create Branch from Task.** Creates a branch such as `feature/ABC-123`.
- **Change Task Status.** Moves the task through its workflow, for example to *In Progress*.

The Jira project key is detected from the message. Look-alike text such as `UTF-8` is ignored.

## Bitbucket features

- **Notifications.** Your open pull requests are checked every 30 seconds. You get a notification when someone:
  - comments on your pull request or replies to your comment,
  - approves it or requests changes,
  - merges or declines it.
- **Reply from the notification.** Click **Reply**, type your answer and press Enter. **Open** jumps to the comment.
- **Pull Requests view.** It lists your open pull requests with their comment threads, shows unread comments, and has a badge with the unread count.
- **Comments in the editor.** Click a comment to open it in VS Code. File comments open in the local file when the repository is open, otherwise in a read-only copy of the file from Bitbucket. General and outdated comments open in a pull request overview. You can reply there too, including multi-line replies. **Open in Bitbucket** (right-click a comment, or the button on the comment thread) opens it in the browser.

Only one VS Code window polls at a time (the one you used last), so you don't get duplicate notifications.

## AI review

Click the sparkle button on a pull request (or run **Bitbucket: Review with AI**).
To tell the AI what to focus on in a single review, right-click the pull request and choose **Review with AI (Extra Instructions)...**. Your instructions are added to the review prompt.

- The diff and file contents are read from Bitbucket. Nothing is checked out and your working tree is not touched. Line numbers match Bitbucket exactly.
- The review uses a language model from GitHub Copilot Chat (`vscode.lm`). Pick one with **Bitbucket: Select AI Review Model**.
- If the repository is open, the rule files in `review.instructionFiles` (for example `.github/copilot-instructions.md`) are added to the prompt.
- Findings appear as **draft comments** in a diff view and in the Comments panel. For each draft you can **Send**, **Edit** or **Discard**. Nothing is posted until you send it.
- **Send All Drafts** posts every remaining draft after a confirmation.
- For pull requests you review, **Approve** and **Needs Work** set your review status.

## Fix review comments with AI

On your own pull requests, click the sparkle button on a comment (**Fix with AI**) or on the pull request (**Fix All Comments with AI**). This needs GitHub Copilot Chat.

- If the repository is not on the pull request's branch, you are asked to switch to it first.
- Copilot Chat opens in agent mode with a prepared prompt. The agent reads the comments with the `#bitbucketComments` tool and handles them one at a time:
  - If the code needs to change, it explains the plan and waits for your approval before editing. Nothing is committed or pushed.
  - It drafts a reply for the reviewer and posts it with the `#bitbucketReply` tool only after you approve it. VS Code also asks you to confirm every reply.
- Comments are never marked as resolved; the reviewer does that.
- **Fix All** skips resolved threads, threads you started, threads you already answered last, service accounts and the authors in `commentFix.excludeAuthors` (for example review bots).
- You can also use both tools in any agent mode chat, e.g. *"Fix the comments of #399 with #bitbucketComments"*.

## Setup

1. Open the **DevPilot** panel and click **Sign In to Jira** (or run **Jira: Set Up Connection**). Enter:
   - **Jira Server / Data Center:** your Jira URL and a *Personal Access Token* (Jira → Profile → Personal Access Tokens).
   - **Jira Cloud** (`*.atlassian.net`): your URL, account email and an [API token](https://id.atlassian.com/manage-profile/security/api-tokens).
2. Open a repository and click **Enable** when you are asked to turn on the commit check. You can also run **Jira: Enable Commit Check for Repository**.
3. In the same panel, click **Set Up Bitbucket Connection** (or run **Bitbucket: Set Up Connection**) and enter:
   - **Bitbucket Server / Data Center:** your Bitbucket URL and an *HTTP access token* (Bitbucket → Profile → Manage account → HTTP access tokens, *Repository read* permission is enough to read and reply).
   - **Bitbucket Cloud:** `https://bitbucket.org`, your Atlassian account email and an [API token](https://id.atlassian.com/manage-profile/security/api-tokens) with the scopes `read:user:bitbucket`, `read:pullrequest:bitbucket` and `write:pullrequest:bitbucket`.

## Settings

| Setting | Default | Description |
|---|---|---|
| `jiraBitbucketFlow.jira.baseUrl` | | Jira URL |
| `jiraBitbucketFlow.jira.email` | | Account email, only for Jira Cloud |
| `jiraBitbucketFlow.commitCheck.allowedIssueTypes` | `["Development Task"]` | Allowed issue types. Leave empty to allow any sub-task type |
| `jiraBitbucketFlow.commitCheck.onViolation` | `warn` | `warn` asks before committing, `block` aborts the commit |
| `jiraBitbucketFlow.branchPrefixes` | `["feature", "bugfix", "hotfix"]` | Prefixes offered when creating a branch |
| `jiraBitbucketFlow.bitbucket.baseUrl` | | Bitbucket URL |
| `jiraBitbucketFlow.bitbucket.email` | | Account email, only for Bitbucket Cloud |
| `jiraBitbucketFlow.bitbucket.pollInterval` | `30` | Seconds between checks (minimum 15) |
| `jiraBitbucketFlow.review.model` | | Language model used for AI review. Empty: ask on first use |
| `jiraBitbucketFlow.review.instructionFiles` | `.github/copilot-instructions.md`, `AGENTS.md`, ... | Project rule files added to the review prompt |
| `jiraBitbucketFlow.review.excludeFiles` | `**/*.g.dart`, `**/*.lock`, ... | Files skipped by AI review |
| `jiraBitbucketFlow.commentFix.excludeAuthors` | `[]` | Comment authors skipped by **Fix All Comments with AI** |
| `jiraBitbucketFlow.readiness.rules` | `[]` | Rules that show whether a task is ready for development (see below) |

## Task readiness rules

Define what "ready for development" means for your team. Tasks in **My Tasks** are colored:

- green: all rules pass
- red: a rule fails
- yellow: only `warning` rules fail

Expand a task to see the checklist and what is missing. Rules are checked on the parent story of your sub-task by default (`"issue": "task"` checks the task itself). Put the rules in `.vscode/settings.json` of your repository to share them with your team.

**Create the rules with AI:** run **Jira: Create Readiness Rules with AI** (also the sparkle button next to **Task readiness rules** in Settings), then paste or write your team's checklist in the input box and press Enter. The extension sends the checklist, together with the names of your Jira fields and sub-task types, to the language model selected for AI review. You pick the rules to keep from a list; rules that use a field or sub-task type your Jira doesn't have are not selected. The rules are saved to your user settings.

```jsonc
"jiraBitbucketFlow.readiness.rules": [
    // Field must not be empty. Use the name shown in Jira or the field id.
    { "name": "Acceptance criteria", "field": "Acceptance Criteria" },
    // Any value must match the regular expression (case-insensitive).
    { "name": "Spec or design link", "field": "Description", "matches": "wiki\\.example\\.com|figma\\.com" },
    { "name": "Fix version format", "field": "Fix Version/s", "matches": "^\\d+\\.\\d+\\.\\d+$" },
    // Must be the next version: the lowest one that is not released yet.
    { "name": "Next fix version", "field": "Fix Version/s", "lowestUnreleased": true },
    { "name": "Linked to an epic", "field": "Epic Link", "matches": "^EPIC-\\d+$" },
    // Advanced Roadmaps hierarchy (feature, initiative).
    { "name": "Linked to a feature", "field": "Parent Link", "matches": "^FEAT-\\d+$" },
    // Only for bugs.
    { "name": "Affects version", "field": "Affects Version/s", "when": { "field": "Issue Type", "matches": "^Bug$" } },
    // Sub-task checks.
    { "name": "Analysis done", "subtask": { "type": "Analysis", "done": true } },
    { "name": "Tester assigned", "subtask": { "type": "Test", "assigned": true }, "severity": "warning" }
]
```

## How it works and privacy

- Your Jira and Bitbucket tokens are stored in VS Code's SecretStorage (the OS keychain). They are never written to disk or to the hook.
- The hook runs with VS Code's own Node.js runtime, so you don't need Node or Python installed.
- The hook talks only to the VS Code window through a random local port on `127.0.0.1`, protected by a one-time secret.
- The hook is written to `.git/hooks/commit-msg`, which git never commits.
  - If a hook already exists, it is renamed to `commit-msg.backup` only after you confirm.
  - Repositories that use `core.hooksPath` (for example husky) are not modified.
- Merge and revert commits are skipped.
- If VS Code is closed or Jira can't be reached, the commit goes through and you see a warning.
- To skip the check once, use `git commit --no-verify`.
- Pull request data is only sent between VS Code and your Bitbucket server. When you first open the view, existing comments are recorded silently; you are only notified about new ones.
- AI review sends the pull request diff, changed files and rule files to the language model you selected through GitHub Copilot. It runs only when you start it.
- **Fix with AI** gives the comment texts and your code to Copilot agent mode. Edits and replies need your approval.
