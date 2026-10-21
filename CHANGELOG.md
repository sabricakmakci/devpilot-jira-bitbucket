# Changelog

## 0.6.0

### Comments panel

- The panel now shows only the comments that concern you: everything on your own pull requests, and on the pull requests you review only the threads you took part in. The new `jiraBitbucketFlow.bitbucket.panelComments` setting switches back to all comments.
- Comment threads start collapsed; only threads with unread comments open by themselves.
- **Hide This Comment** and **Hide All Comments of This Pull Request** take threads out of the panel. A hidden thread comes back when someone writes in it, and **Show Hidden Comments Again** in the Pull Requests view restores all of them.

### AI

- The model for AI review is now picked from a list of the available models (**AI model** in Accounts & Settings), instead of typing its id by hand.
- **Fix with AI** follows the `jiraBitbucketFlow.review.language` setting: the agent writes to you in that language, and drafts the reply to the reviewer in it as well. On `auto` the reply still follows the language of the reviewer's comment.
- When the model answers in an unexpected form, the review asks it once more instead of silently reporting that it found nothing. If a part still cannot be read, or findings were left out because they did not point at a changed line, the result says so and offers **Review Again**.

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
