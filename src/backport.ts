import { error as logError, group, warning, info } from "@actions/core";
import { exec } from "@actions/exec";
import { getOctokit } from "@actions/github";
import { GitHub } from "@actions/github/lib/utils";
import { EventPayloads } from "@octokit/webhooks";
import { pull } from "lodash";
import escapeRegExp from "lodash/escapeRegExp";

const labelRegExp = /^backport ([^ ]+)(?: ([^ ]+))?$/;

const getLabelNames = ({
  action,
  label,
  labels,
}: {
  action: EventPayloads.WebhookPayloadPullRequest["action"];
  label: { name: string };
  labels: EventPayloads.WebhookPayloadPullRequest["pull_request"]["labels"];
}): string[] => {
  switch (action) {
    case "closed":
      return labels.map(({ name }) => name);
    case "labeled":
      return [label.name];
    default:
      return [];
  }
};

const getBackportBaseToHead = ({
  action,
  branchName,
  label,
  labels,
  pullRequestNumber,
}: {
  action: EventPayloads.WebhookPayloadPullRequest["action"];
  branchName: string;
  label: { name: string };
  labels: EventPayloads.WebhookPayloadPullRequest["pull_request"]["labels"];
  pullRequestNumber: number;
}): Record<string, string> => {
  const baseToHead: Record<string, string> = {};

  getLabelNames({ action, label, labels }).forEach((labelName) => {
    const matches = labelRegExp.exec(labelName);

    if (matches !== null) {
      const [
        ,
        base,
        head = branchName
          ? `${branchName}-to-${base}`
          : `backport-${pullRequestNumber}-to-${base}`,
      ] = matches;
      baseToHead[base] = head;
    }
  });

  return baseToHead;
};

const warnIfSquashIsNotTheOnlyAllowedMergeMethod = async ({
  github,
  owner,
  repo,
}: {
  github: InstanceType<typeof GitHub>;
  owner: string;
  repo: string;
}) => {
  const {
    data: { allow_merge_commit, allow_rebase_merge },
  } = await github.repos.get({ owner, repo });
  if (allow_merge_commit || allow_rebase_merge) {
    warning(
      [
        "Your repository allows merge commits and rebase merging.",
        " However, Backport only supports rebased and merged pull requests with a single commit and squashed and merged pull requests.",
        " Consider only allowing squash merging.",
        " See https://help.github.com/en/github/administering-a-repository/about-merge-methods-on-github for more information.",
      ].join("\n"),
    );
  }
};

const backportOnce = async ({
  base,
  body,
  commitToBackport,
  filesToSkip,
  github,
  head,
  labelsToAdd,
  owner,
  repo,
  title,
}: {
  base: string;
  body: string;
  commitToBackport: string;
  filesToSkip: string[];
  github: InstanceType<typeof GitHub>;
  head: string;
  labelsToAdd: string[];
  owner: string;
  repo: string;
  title: string;
}) => {
  const git = async (...args: string[]) => {
    await exec("git", args, { cwd: repo });
  };

  await git("switch", base);
  await git("switch", "--create", head);
  try {
    await git("cherry-pick", "-x", "-n", commitToBackport);
    for (const file of filesToSkip) {
      await git("checkout", "HEAD", file);
    }

    await git("commit", "--no-edit", "-s");
  } catch (error: unknown) {
    await git("cherry-pick", "--abort");
    throw error;
  }

  await git("push", "--set-upstream", "origin", head);
  const {
    data: { number: pullRequestNumber },
  } = await github.pulls.create({
    base,
    body,
    head,
    owner,
    repo,
    title,
  });
  if (labelsToAdd.length > 0) {
    await github.issues.addLabels({
      issue_number: pullRequestNumber,
      labels: labelsToAdd,
      owner,
      repo,
    });
  }

  return pullRequestNumber;
};

const getFailedBackportCommentBody = ({
  base,
  commitToBackport,
  errorMessage,
  head,
}: {
  base: string;
  commitToBackport: string;
  errorMessage: string;
  head: string;
}) => {
  const worktreePath = `.worktrees/backport-${base}`;
  return [
    `The backport to \`${base}\` failed:`,
    "```",
    errorMessage,
    "```",
    "To backport manually, run these commands in your terminal:",
    "```bash",
    "# Fetch latest updates from GitHub",
    "git fetch",
    "# Create a new working tree",
    `git worktree add ${worktreePath} ${base}`,
    "# Navigate to the new working tree",
    `cd ${worktreePath}`,
    "# Create a new branch",
    `git switch --create ${head}`,
    "# Cherry-pick the merged commit of this pull request and resolve the conflicts",
    `git cherry-pick -x --mainline 1 ${commitToBackport}`,
    "# Push it to GitHub",
    `git push --set-upstream origin ${head}`,
    "# Go back to the original working tree",
    "cd ../..",
    "# Delete the working tree",
    `git worktree remove ${worktreePath}`,
    "```",
    `Then, create a pull request where the \`base\` branch is \`${base}\` and the \`compare\`/\`head\` branch is \`${head}\`.`,
  ].join("\n");
};

const deleteBackportBranchIfMerged = async ({
  base,
  github,
  head,
  owner,
  pullRequestNumber,
  repo,
}: {
  base: string;
  github: InstanceType<typeof GitHub>;
  head: string;
  owner: string;
  pullRequestNumber: number;
  repo: string;
}) => {
  const git = async (...args: string[]) => {
    await exec("git", args, { cwd: repo });
  };

  let isMerged = false;
  try {
    await github.pulls.checkIfMerged({
      owner,
      pull_number: pullRequestNumber,
      repo,
    });
    isMerged = true;
  } catch {
    isMerged = false;
  }

  if (isMerged) {
    info(`The backport PR is merged, deleting the backport branch`);
    await git("push", "--delete", "--force", base, head);
  }
};

const backport = async ({
  branchName,
  deleteBranch,
  filesToSkip,
  labelsToAdd,
  payload: {
    action,
    label,
    pull_request: {
      labels,
      merge_commit_sha: mergeCommitSha,
      merged,
      number: pullRequestNumber,
      title: originalTitle,
    },
    repository: {
      name: repo,
      owner: { login: owner },
    },
  },
  titleTemplate,
  token,
}: {
  branchName: string;
  deleteBranch: boolean;
  filesToSkip: string[];
  labelsToAdd: string[];
  payload: EventPayloads.WebhookPayloadPullRequest;
  titleTemplate: string;
  token: string;
}) => {
  if (!merged) {
    return;
  }

  const backportBaseToHead = getBackportBaseToHead({
    action,
    branchName,
    // The payload has a label property when the action is "labeled".
    label: label!,
    labels,
    pullRequestNumber,
  });

  if (Object.keys(backportBaseToHead).length === 0) {
    return;
  }

  const github = getOctokit(token);

  await warnIfSquashIsNotTheOnlyAllowedMergeMethod({ github, owner, repo });

  // The merge commit SHA is actually not null.
  const commitToBackport = String(mergeCommitSha);
  info(`Backporting ${commitToBackport} from #${pullRequestNumber}`);

  await exec("git", [
    "clone",
    `https://x-access-token:${token}@github.com/${owner}/${repo}.git`,
  ]);
  await exec("git", [
    "config",
    "--global",
    "user.email",
    "github-actions[bot]@users.noreply.github.com",
  ]);
  await exec("git", ["config", "--global", "user.name", "github-actions[bot]"]);

  for (const [base, head] of Object.entries(backportBaseToHead)) {
    const body = `Backport ${commitToBackport} from #${pullRequestNumber}`;

    let title = titleTemplate;
    Object.entries({
      base,
      originalTitle,
    }).forEach(([name, value]) => {
      title = title.replace(
        new RegExp(escapeRegExp(`{{${name}}}`), "g"),
        value,
      );
    });

    await group(`Backporting to ${base} on ${head}`, async () => {
      try {
        const pullRequestNumber = await backportOnce({
          base,
          body,
          commitToBackport,
          filesToSkip,
          github,
          head,
          labelsToAdd,
          owner,
          repo,
          title,
        });
      } catch (error: unknown) {
        if (!(error instanceof Error)) {
          throw new TypeError(
            `Caught error of unexpected type: ${typeof error}`,
          );
        }

        logError(error);
        await github.issues.createComment({
          body: getFailedBackportCommentBody({
            base,
            commitToBackport,
            errorMessage: error.message,
            head,
          }),
          issue_number: pullRequestNumber,
          owner,
          repo,
        });
      }
    });

    if (deleteBranch) {
      info(`Deleting backport branch ${head}`);
      await deleteBackportBranchIfMerged({
        base,
        github,
        head,
        owner,
        pullRequestNumber,
        repo,
      });
    }
  }
};

export { backport };
