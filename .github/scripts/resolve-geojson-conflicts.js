const { execSync } = require("child_process");

const GEOJSON_FILE = "data.geojson";

function run(cmd) {
  return execSync(cmd, { encoding: "utf-8" }).trim();
}

function getFileAtRef(ref, file) {
  try {
    return JSON.parse(run(`git show ${ref}:${file}`));
  } catch {
    return null;
  }
}

function featureIndex(features) {
  const map = new Map();
  for (const f of features) {
    const id = f.properties?.id;
    if (id) map.set(id, f);
  }
  return map;
}

function resolveFeatures(base, main, pr) {
  const baseIndex = featureIndex(base.features);
  const mainIndex = featureIndex(main.features);
  const prIndex = featureIndex(pr.features);

  // Start with main's features as the base result
  const result = new Map(mainIndex);

  for (const [id, feature] of prIndex) {
    const inBase = baseIndex.has(id);
    const inMain = mainIndex.has(id);

    if (!inBase) {
      // PR added this feature — add it to result
      result.set(id, feature);
    } else if (inBase && inMain) {
      // Feature exists in all three — PR's version wins (it's the PR's intent)
      result.set(id, feature);
    }
    // If inBase && !inMain: main deleted it, and PR still has it.
    // Main's deletion wins since it was already merged.
  }

  // Handle deletions by PR: feature in base but not in PR
  for (const [id] of baseIndex) {
    if (!prIndex.has(id)) {
      result.delete(id);
    }
  }

  return {
    ...main,
    features: [...result.values()],
  };
}

async function main() {
  const { Octokit } = await import("@octokit/rest");
  const token = process.env.GITHUB_TOKEN;
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
  const octokit = new Octokit({ auth: token });

  // Fetch all open PRs
  const { data: prs } = await octokit.pulls.list({
    owner,
    repo,
    state: "open",
    per_page: 100,
  });

  if (prs.length === 0) {
    console.log("No open PRs to process.");
    return;
  }

  console.log(`Found ${prs.length} open PR(s).`);

  // Make sure we have latest main
  run("git fetch origin main");

  for (const pr of prs) {
    const branch = pr.head.ref;
    console.log(`\nProcessing PR #${pr.number}: ${pr.title} (${branch})`);

    try {
      // Fetch the PR branch
      run(`git fetch origin ${branch}`);

      // Check if there's actually a conflict
      const mergeBase = run(`git merge-base origin/main origin/${branch}`);

      // Try a test merge to see if there's a conflict
      run("git checkout -f origin/main");
      try {
        run(`git merge --no-commit --no-ff origin/${branch} 2>&1`);
        run("git merge --abort 2>/dev/null || true");
        console.log(`  No conflicts — skipping.`);
        continue;
      } catch {
        run("git merge --abort 2>/dev/null || true");
      }

      // There is a conflict — resolve it via JSON merge
      console.log(`  Conflict detected — resolving via JSON merge...`);

      const baseData = getFileAtRef(mergeBase, GEOJSON_FILE);
      const mainData = getFileAtRef("origin/main", GEOJSON_FILE);
      const prData = getFileAtRef(`origin/${branch}`, GEOJSON_FILE);

      if (!baseData || !mainData || !prData) {
        console.log(`  Could not read ${GEOJSON_FILE} from all refs — skipping.`);
        continue;
      }

      const resolved = resolveFeatures(baseData, mainData, prData);

      // Check out the PR branch, update the file, and push
      run(`git checkout -f origin/${branch}`);
      run(`git checkout -b temp-resolve-${pr.number}`);

      // Merge main into the branch, accepting ours for conflicts temporarily
      try {
        run(`git merge origin/main -X ours --no-edit`);
      } catch {
        // If merge still fails, manually resolve
        const fs = require("fs");
        fs.writeFileSync(
          GEOJSON_FILE,
          JSON.stringify(resolved, null, 2) + "\n"
        );
        run(`git add ${GEOJSON_FILE}`);
        run(`git -c user.name="github-actions[bot]" -c user.email="github-actions[bot]@users.noreply.github.com" commit --no-edit`);
      }

      // Overwrite with our properly resolved version
      const fs = require("fs");
      fs.writeFileSync(
        GEOJSON_FILE,
        JSON.stringify(resolved, null, 2) + "\n"
      );

      // Check if the file actually changed after resolution
      const diff = run(`git diff --name-only`);
      if (diff.includes(GEOJSON_FILE)) {
        run(`git add ${GEOJSON_FILE}`);
        run(
          `git -c user.name="github-actions[bot]" -c user.email="github-actions[bot]@users.noreply.github.com" commit -m "Resolve data.geojson conflicts with main"`
        );
      }

      run(`git push origin HEAD:${branch}`);
      console.log(`  Resolved and pushed to ${branch}.`);
    } catch (err) {
      console.error(`  Failed to process PR #${pr.number}: ${err.message}`);
    } finally {
      run("git checkout -f origin/main 2>/dev/null || true");
      run(`git branch -D temp-resolve-${pr.number} 2>/dev/null || true`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
