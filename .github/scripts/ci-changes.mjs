import { execFileSync } from "node:child_process";

export function shouldRunChecks({ eventName, baseSha, headSha }, git = execFileSync) {
  if (eventName !== "pull_request" && eventName !== "merge_group") return true;
  if (![baseSha, headSha].every((sha) => /^[a-f0-9]{40}$/.test(sha || ""))) {
    throw new Error("Missing or invalid comparison revision");
  }
  // Disable rename detection so moving code into documentation still runs CI.
  const files = git("git", [
    "diff", "--name-only", "--no-renames", "-z", baseSha, headSha, "--",
  ], { encoding: "utf8" }).split("\0").filter(Boolean);
  return files.some((file) => !(
    /^[^/]+\.md$/.test(file) ||
    (file.startsWith("docs/") && file.endsWith(".md")) ||
    file === "LICENSE"
  ));
}
