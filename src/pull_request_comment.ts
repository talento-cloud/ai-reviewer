import { info, warning } from "@actions/core";
import { loadContext } from "./context";
import config from "./config";
import { initOctokit } from "./octokit";
import {
  buildComment,
  getCommentThread,
  isOwnComment,
  isThreadRelevant,
  ReviewComment,
  ReviewCommentThread,
} from "./comments";
import { parseFileDiff, generateFileCodeDiff } from "./diff";
import { runReviewCommentPrompt } from "./prompts";

export async function handlePullRequestComment() {
  const context = await loadContext();
  const eventName = context.eventName;

  if (eventName !== "pull_request_review_comment" && eventName !== "issue_comment") {
    warning("unsupported github event");
    return;
  }

  const { comment, pull_request: prFromPayload, issue } = context.payload;
  if (!comment) {
    warning("`comment` is missing from payload");
    return;
  }
  if (context.payload.action !== "created") {
    warning("only consider newly created comments");
    return;
  }
  if (isOwnComment(comment.body)) {
    info("ignoring own comments");
    return;
  }

  const octokit = initOctokit(config.githubToken, config.githubApiUrl);
  let pull_request = prFromPayload;

  // For issue_comment, we need to fetch the PR since it's not in the payload
  if (eventName === "issue_comment") {
    if (!issue?.pull_request) {
      info("issue is not a pull request, ignoring");
      return;
    }
    const { data: pr } = await octokit.rest.pulls.get({
      ...context.repo,
      pull_number: issue.number,
    });
    pull_request = pr;
  }

  if (!pull_request) {
    warning("`pull_request` is missing from payload");
    return;
  }

  // Fetch diffs for all files
  const { data: files } = await octokit.rest.pulls.listFiles({
    ...context.repo,
    pull_number: pull_request.number,
  });
  let fileDiffs = files.map((file) => parseFileDiff(file, []));

  // Handle pull_request_review_comment (comment on a specific line)
  if (eventName === "pull_request_review_comment") {
    // Fetch comment thread
    const commentThread = await getCommentThread(octokit, {
      ...context.repo,
      pull_number: pull_request.number,
      comment_id: comment.id,
    });
    if (!commentThread) {
      warning("comment thread not found");
      return;
    }

    // Check if the comment thread is relevant
    if (!isThreadRelevant(commentThread)) {
      info("comment thread is not relevant, ignoring it");
      return;
    }

    // Find the file that the comment is in
    const commentFileDiff = fileDiffs.find(
      (fileDiff) => fileDiff.filename === commentThread.file
    );
    if (!commentFileDiff) {
      warning("comment is not in any file that was changed in this PR");
      return;
    }

    // Run prompt
    const response = await runReviewCommentPrompt({
      commentThread,
      commentFileDiff,
    });

    // Submit response if action requested
    if (!response.action_requested || !response.response_comment.length) {
      info(
        "comment doesn't seem to require any action, so not submitting a response"
      );
      return;
    }

    info("action requested, submitting response");
    await octokit.rest.pulls.createReviewComment({
      ...context.repo,
      pull_number: pull_request.number,
      commit_id: pull_request.head.sha,
      path: commentThread.file,
      body: buildComment(response.response_comment),
      in_reply_to: commentThread.comments[0].id,
    });
    return;
  }

  // Handle issue_comment (general comment on the PR)
  if (eventName === "issue_comment") {
    // Only respond if the comment mentions @presubmit or @presubmitai
    const lowerBody = (comment.body || "").toLowerCase();
    const mentionsPresubmit =
      lowerBody.includes("@presubmit") || lowerBody.includes("@presubmitai");
    if (!mentionsPresubmit) {
      info("comment does not mention @presubmit, ignoring");
      return;
    }

    // Create a synthetic comment thread with just this comment
    const commentThread: ReviewCommentThread = {
      file: "",
      comments: [
        {
          id: comment.id,
          path: "",
          body: comment.body,
          user: { login: comment.user.login },
        } as ReviewComment,
      ],
    };

    // Use all file diffs as context (joined together)
    const allDiffs = fileDiffs.map((f) => generateFileCodeDiff(f)).join("\n\n");
    const commentFileDiff = {
      filename: "all-files",
      patch: allDiffs,
      status: "modified" as const,
      additions: 0,
      deletions: 0,
      changes: 0,
      diffHunks: [],
    };

    // Run prompt
    const response = await runReviewCommentPrompt({
      commentThread,
      commentFileDiff,
    });

    // Submit response if action requested
    if (!response.action_requested || !response.response_comment.length) {
      info(
        "comment doesn't seem to require any action, so not submitting a response"
      );
      return;
    }

    info("action requested, submitting response as general PR comment");
    await octokit.rest.issues.createComment({
      ...context.repo,
      issue_number: pull_request.number,
      body: buildComment(response.response_comment),
    });
  }
}
