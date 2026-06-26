import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

function toReleaseUrl(repositoryUrl) {
  if (!repositoryUrl || typeof repositoryUrl !== 'string') {
    return null;
  }

  const raw = repositoryUrl.trim().replace(/^git\+/, '').replace(/\.git$/, '');

  // Handle common SSH format: git@github.com:owner/repo
  const sshMatch = raw.match(/^git@github\.com:(.+?)\/(.+)$/i);
  if (sshMatch) {
    const [, owner, repo] = sshMatch;
    return `https://github.com/${owner}/${repo}/releases`;
  }

  // Handle HTTPS format: https://github.com/owner/repo
  const httpsMatch = raw.match(/^https?:\/\/github\.com\/(.+?)\/(.+)$/i);
  if (httpsMatch) {
    const [, owner, repo] = httpsMatch;
    return `https://github.com/${owner}/${repo}/releases`;
  }

  return null;
}

// Read current manifest
const manifestPath = path.join(process.cwd(), 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

// Get current version
const currentVersion = manifest.version;
const [major, minor, patch] = currentVersion.split('.').map(Number);

// Increment patch version
const newVersion = `${major}.${minor}.${patch + 1}`;

// Update manifest
manifest.version = newVersion;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

// Update package.json
const packagePath = path.join(process.cwd(), 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
packageJson.version = newVersion;
fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2));

const repositoryUrl = packageJson.repository?.url;
if (
  typeof repositoryUrl !== 'string' ||
  repositoryUrl.includes('YOUR_GITHUB_USERNAME') ||
  repositoryUrl.includes('<')
) {
  throw new Error(
    'Configure package.json repository.url before running release. Example: https://github.com/<your-user-or-org>/noesis.git'
  );
}

console.log(`Version bumped from ${currentVersion} to ${newVersion}`);
execSync(`git add manifest.json package.json`, { stdio: 'inherit' });
execSync(`git commit -m "Bump version to ${newVersion}"`, { stdio: 'inherit' });

// Git tag and push
console.log(`Creating git tag ${newVersion}...`);
execSync(`git tag ${newVersion}`, { stdio: 'inherit' });

console.log('Pushing tags to remote...');
execSync('git push origin HEAD:main', { stdio: 'inherit' });
execSync('git push --tags', { stdio: 'inherit' });

// Wait 30 seconds
console.log('Waiting 60 seconds for GitHub action to create the release...');
await new Promise(resolve => setTimeout(resolve, 60000));

// Open releases page in browser
let releaseUrl = null;

try {
  const originUrl = execSync('git config --get remote.origin.url', {
    encoding: 'utf8',
  }).trim();
  releaseUrl = toReleaseUrl(originUrl);
} catch {
  // Fall back to package.json repository URL.
}

if (!releaseUrl) {
  releaseUrl = toReleaseUrl(repositoryUrl);
}

if (!releaseUrl) {
  throw new Error(
    'Could not determine GitHub releases URL from git remote.origin.url or package.json repository.url'
  );
}

console.log(`Opening ${releaseUrl} in browser...`);

// Cross-platform browser opening
const platform = process.platform;
let openCommand;

if (platform === 'darwin') {
  openCommand = `open "${releaseUrl}"`;
} else if (platform === 'win32') {
  openCommand = `start "" "${releaseUrl}"`;
} else {
  openCommand = `xdg-open "${releaseUrl}"`;
}

execSync(openCommand, { stdio: 'inherit' });
console.log('Done!');
