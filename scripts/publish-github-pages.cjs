// Publish only the build output, without expanding source filenames into Git arguments.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function publish({ projectRoot = path.resolve(__dirname, '..'), log = console.log } = {}) {
  const dist = path.join(projectRoot, 'dist');
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    throw new Error('Missing dist/index.html. Run npm run build:github first.');
  }

  function git(args, cwd = projectRoot) {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
    }).trim();
  }

  const repo = git(['remote', 'get-url', 'origin']);
  const name = git(['config', 'user.name']);
  const email = git(['config', 'user.email']);
  const branchRef = 'refs/heads/gh-pages';
  log('Checking the GitHub Pages branch...');
  const remoteRef = git(['ls-remote', '--heads', repo, branchRef]);
  const expectedCommit = remoteRef ? remoteRef.split(/\s+/)[0] : '';
  if (expectedCommit && !/^[a-f0-9]{40,64}$/.test(expectedCommit)) {
    throw new Error('Could not determine the current gh-pages commit.');
  }

  const tempRoot = fs.realpathSync(os.tmpdir());
  const staging = fs.mkdtempSync(path.join(tempRoot, 'sto-pages-'));
  try {
    fs.cpSync(dist, staging, {
      recursive: true,
      filter(source) {
        const base = path.basename(source);
        if (base === '.git') return false;
        if (base === '.env' || base.startsWith('.env.')) {
          throw new Error('Refusing to publish an environment file from dist.');
        }
        return true;
      },
    });
    fs.writeFileSync(path.join(staging, '.nojekyll'), '');
    git(['init', '--quiet', '--initial-branch=gh-pages'], staging);
    git(['config', 'user.name', name], staging);
    git(['config', 'user.email', email], staging);
    git(['add', '--all', '--', '.'], staging);
    git(['commit', '--quiet', '-m', 'Publish STO Suprunec'], staging);

    // Keep the existing no-history deployment behavior, but reject concurrent updates.
    log('Publishing the build to gh-pages...');
    git([
      'push',
      `--force-with-lease=${branchRef}:${expectedCommit}`,
      repo,
      `HEAD:${branchRef}`,
    ], staging);
    log('Published');
  } finally {
    // Only remove the temporary directory created by this invocation.
    const resolvedStaging = fs.realpathSync(staging);
    if (path.dirname(resolvedStaging) !== tempRoot ||
        !path.basename(resolvedStaging).startsWith('sto-pages-')) {
      throw new Error('Unexpected temporary directory; cleanup cancelled.');
    }
    fs.rmSync(resolvedStaging, { recursive: true, force: true, maxRetries: 3 });
  }
}

if (require.main === module) {
  try {
    publish();
  } catch (error) {
    const message = error.stderr?.toString().trim() || error.message;
    console.error('Publication failed: ' + message.replace(/(https?:\/\/)[^/@\s]+@/g, '$1[redacted]@'));
    process.exitCode = 1;
  }
}

module.exports = { publish };
