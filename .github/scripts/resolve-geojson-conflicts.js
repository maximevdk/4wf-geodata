const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function run(cmd) {
  return execSync(cmd, { encoding: "utf-8" }).trim();
}

const repoRoot = run("git rev-parse --show-toplevel");

function resolveRepoPath(...parts) {
  return path.join(repoRoot, ...parts);
}

function remoteRef(branch) {
  return `refs/remotes/origin/${branch}`;
}

function fetchRemoteBranch(branch) {
  run(`git fetch origin ${branch}:${remoteRef(branch)}`);
}

function getFileAtRef(ref, file) {
  try {
    return JSON.parse(run(`git show ${ref}:${file}`));
  } catch {
    return null;
  }
}

function listGeoJSONFiles(ref) {
  try {
    return run(`git ls-tree --name-only ${ref} data/`)
      .split("\n")
      .filter(Boolean)
      .filter((f) => f.endsWith(".geojson"));
  } catch {
    return [];
  }
}

function listWorkingTreeGeoJSONCountryCodes() {
  const dataDir = resolveRepoPath("data");

  if (!fs.existsSync(dataDir)) {
    return [];
  }

  return fs
    .readdirSync(dataDir)
    .filter((file) => file.endsWith(".geojson"))
    .map((file) => path.basename(file, ".geojson"))
    .sort();
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

  fetchRemoteBranch("master");

  for (const pr of prs) {
    const branch = pr.head.ref;
    const masterRef = remoteRef("master");
    const branchRef = remoteRef(branch);

    console.log(`\nProcessing PR #${pr.number}: ${pr.title} (${branch})`);

    try {
      fetchRemoteBranch(branch);

      const mergeBase = run(`git merge-base ${masterRef} ${branchRef}`);

      // Try a test merge to see if there's a conflict
      run(`git checkout -f ${masterRef}`);
      try {
        run(`git merge --no-commit --no-ff ${branchRef} 2>&1`);
        run("git merge --abort 2>/dev/null || true");
        console.log(`  No conflicts — skipping.`);
        continue;
      } catch {
        run("git merge --abort 2>/dev/null || true");
      }

      console.log(`  Conflict detected — resolving via JSON merge...`);

      // Collect all geojson files across all three refs
      const allFiles = new Set([
        ...listGeoJSONFiles(mergeBase),
        ...listGeoJSONFiles(masterRef),
        ...listGeoJSONFiles(branchRef),
      ]);

      // Check out the PR branch and merge main
      run(`git checkout -f ${branchRef}`);
      run(`git checkout -B temp-resolve-${pr.number}`);

      try {
        run(`git merge ${masterRef} -X ours --no-edit`);
      } catch {
        // If merge fails, we'll resolve manually below
        for (const file of allFiles) {
          run(`git add ${file} 2>/dev/null || true`);
        }
        run(`git add index.json 2>/dev/null || true`);
        run(
          `git -c user.name="github-actions[bot]" -c user.email="github-actions[bot]@users.noreply.github.com" commit --no-edit`
        );
      }

      // Resolve each geojson file
      for (const file of allFiles) {
        const emptyCollection = { type: "FeatureCollection", features: [] };
        const baseData = getFileAtRef(mergeBase, file) || emptyCollection;
        const mainData = getFileAtRef(masterRef, file) || emptyCollection;
        const prData = getFileAtRef(branchRef, file) || emptyCollection;

        const resolved = resolveFeatures(baseData, mainData, prData);
        const filePath = resolveRepoPath(file);

        if (resolved.features.length === 0) {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
          run(`git add ${file}`);
          continue;
        }

        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(resolved, null, 2) + "\n");
        run(`git add ${file}`);
      }

      // Update index.json
      const sortedCodes = listWorkingTreeGeoJSONCountryCodes();
      fs.writeFileSync(
        resolveRepoPath("index.json"),
        JSON.stringify({ countries: sortedCodes }, null, 2) + "\n"
      );
      run("git add index.json");

      const diff = run("git diff --cached --name-only");
      if (diff.length > 0) {
        run(
          `git -c user.name="github-actions[bot]" -c user.email="github-actions[bot]@users.noreply.github.com" commit -m "Resolve geojson conflicts with master"`
        );
      }

      run(`git push origin HEAD:${branch}`);
      console.log(`  Resolved and pushed to ${branch}.`);
    } catch (err) {
      console.error(`  Failed to process PR #${pr.number}: ${err.message}`);
    } finally {
      run(`git checkout -f ${masterRef} 2>/dev/null || true`);
      run(`git branch -D temp-resolve-${pr.number} 2>/dev/null || true`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
