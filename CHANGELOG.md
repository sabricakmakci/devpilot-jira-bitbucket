# Changelog

## 0.5.8

- Connection errors now show the full underlying cause (TLS, proxy, connection reset) instead of only "Request was cancelled".

## 0.5.7

First release on the Visual Studio Marketplace.

### Jira

- Commit check through a `commit-msg` git hook: verifies that every Jira key in the message exists, is assigned to you, and has an allowed issue type. Works for the Commit button and for terminal commits.
- **Pick My Task** puts the selected key at the start of the commit message.
- Status bar item for the active task, with quick actions.
- Create a branch from a task, and move a task through its workflow.
- Side panel section listing your open Jira tasks.

### Bitbucket

- Polls your open pull requests and notifies you about new comments, replies, approvals, change requests, merges and declines.
- Reply straight from the notification, or from the comment thread in the editor.
- Pull Requests view with your own pull requests and the ones waiting for your review, including unread counts.
- Comments open in the local file when the repository is available, otherwise in a read-only copy from Bitbucket.
- Only one VS Code window polls at a time, so notifications are not duplicated.

### AI

- **Review with AI** produces draft comments in a diff view; nothing is posted until you send it. Optional extra instructions per review, and repository rule files are added to the prompt.
- **Fix with AI** and **Fix All Comments with AI** open Copilot Chat in agent mode with the `#bitbucketComments` and `#bitbucketReply` tools. Edits and replies always wait for your approval.

### Other

- English and Turkish user interface.
- Accounts & Settings section in the side panel for signing in, enabling the commit check per repository, and changing settings.
