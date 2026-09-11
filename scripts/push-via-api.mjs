#!/usr/bin/env node
/**
 * Push local working-tree content to GitHub when github.com:443 is unreachable
 * (git's smart-HTTP protocol needs github.com; the REST API does not).
 *
 * Builds the commit entirely server-side:
 *   base tree (from an existing remote ref)
 *     + one blob per local file
 *     -> new tree -> new commit -> move the branch ref
 *
 * Deliberately does NOT depend on local commit history: it only reads the working
 * tree, so it works even when local and remote histories disagree (which happens
 * once an API-created commit exists on the remote but not locally).
 *
 *   node scripts/push-via-api.mjs <owner/repo> <branch> <baseRef> <messageFile> <file...>
 *
 * Example:
 *   node scripts/push-via-api.mjs goesByhc/CloddsBot main origin/main .msg \
 *     src/a.ts scripts/b.ts
 */
import { execFileSync } from 'child_process';
import { readFileSync, existsSync, statSync } from 'fs';

const [repo, branch, baseRef, messageFile, ...files] = process.argv.slice(2);
if (!repo || !branch || !baseRef || !messageFile || files.length === 0) {
  console.error(
    'usage: node scripts/push-via-api.mjs <owner/repo> <branch> <baseRef> <messageFile> <file...>'
  );
  process.exit(1);
}
if (!existsSync(messageFile)) {
  console.error(`message file not found: ${messageFile}`);
  process.exit(1);
}

function ghApi(pathAndQuery, { method = 'GET', body } = {}) {
  const args = ['api', pathAndQuery, '-X', method, '--input', '-'];
  const out = execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    input: JSON.stringify(body ?? {}),
  });
  return out.trim() ? JSON.parse(out) : null;
}

const message = readFileSync(messageFile, 'utf8');

// The base may be a local ref (origin/main) or a raw SHA that only exists on the
// remote (e.g. a commit this script itself created earlier). Resolve local refs
// with git; treat anything else as a SHA to look up through the API.
let baseCommitSha;
try {
  baseCommitSha = execFileSync('git', ['rev-parse', `${baseRef}^{commit}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {
  baseCommitSha = baseRef;
}
if (!/^[0-9a-f]{40}$/.test(baseCommitSha)) {
  console.error(`base "${baseRef}" is neither a local ref nor a full commit SHA`);
  process.exit(1);
}

const baseCommit = ghApi(`repos/${repo}/git/commits/${baseCommitSha}`);
if (!baseCommit?.tree?.sha) {
  console.error(`could not resolve base commit ${baseCommitSha} (${baseRef}) on ${repo}`);
  process.exit(1);
}
console.log(`base ref     : ${baseRef} -> ${baseCommitSha.slice(0, 8)}`);
console.log(`base tree    : ${baseCommit.tree.sha}`);

const tree = [];
for (const path of files) {
  if (!existsSync(path)) {
    console.error(`  MISSING local file: ${path}`);
    process.exit(1);
  }
  const content = readFileSync(path);
  const blob = ghApi(`repos/${repo}/git/blobs`, {
    method: 'POST',
    body: { content: content.toString('base64'), encoding: 'base64' },
  });
  // Derive the mode from the filesystem rather than the index, so untracked files
  // work too. 100755 if any execute bit is set, else 100644.
  const mode = (statSync(path).mode & 0o111) !== 0 ? '100755' : '100644';
  tree.push({ path, mode, type: 'blob', sha: blob.sha });
  console.log(`  ${path} -> ${blob.sha.slice(0, 8)} (${mode}, ${content.length}B)`);
}

const newTree = ghApi(`repos/${repo}/git/trees`, {
  method: 'POST',
  body: { base_tree: baseCommit.tree.sha, tree },
});
console.log(`new tree     : ${newTree.sha}`);

const newCommit = ghApi(`repos/${repo}/git/commits`, {
  method: 'POST',
  body: { message, tree: newTree.sha, parents: [baseCommitSha] },
});
console.log(`new commit   : ${newCommit.sha}`);

// Move the branch. Non-forced: if the remote is not at the base we expected the
// API rejects it, which is the behaviour we want.
let current = null;
try {
  current = ghApi(`repos/${repo}/git/ref/heads/${branch}`);
} catch {
  current = null;
}

if (current) {
  console.log(`current ref  : ${current.object.sha.slice(0, 8)}`);
  ghApi(`repos/${repo}/git/refs/heads/${branch}`, {
    method: 'PATCH',
    body: { sha: newCommit.sha, force: false },
  });
  console.log(`updated      : heads/${branch} -> ${newCommit.sha.slice(0, 8)}`);
} else {
  ghApi(`repos/${repo}/git/refs`, {
    method: 'POST',
    body: { ref: `refs/heads/${branch}`, sha: newCommit.sha },
  });
  console.log(`created      : heads/${branch} -> ${newCommit.sha.slice(0, 8)}`);
}

console.log(`\nhttps://github.com/${repo}/commit/${newCommit.sha}`);
console.log(
  'NOTE: this commit is built server-side, so its SHA differs from any local\n' +
    'commit with the same content. Once github.com is reachable, reconcile with:\n' +
    `  git fetch origin ${branch} && git reset --hard origin/${branch}`
);
