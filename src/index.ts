import { debug, error as logError, getInput, setFailed } from "@actions/core";
import { context } from "@actions/github";
import { EventPayloads } from "@octokit/webhooks";

import { backport } from "./backport";
import { getLabelsToAdd } from "./get-labels-to-add";
import { getFilesToSkip } from "./get-files-to-skip";

const run = async () => {
  try {
    const token = getInput("github_token", { required: true });
    const titleTemplate = getInput("title_template");
    const branchName = getInput("branch_name");
    const deleteBranch = getInput("delete-branch") === "true";
    debug(JSON.stringify(context, undefined, 2));
    const labelsInput = getInput("add_labels");
    const labelsToAdd = getLabelsToAdd(labelsInput);
    const filesInput = getInput("files_to_skip");
    const filesToSkip = getFilesToSkip(filesInput);
    await backport({
      branchName,
      deleteBranch,
      filesToSkip,
      labelsToAdd,
      payload: context.payload as EventPayloads.WebhookPayloadPullRequest,
      titleTemplate,
      token,
    });
  } catch (error: unknown) {
    if (typeof error !== "string" && !(error instanceof Error)) {
      throw new TypeError(`Caught error of unexpected type: ${typeof error}`);
    }

    setFailed(error);
  }
};

void run();
