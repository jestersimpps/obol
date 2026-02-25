const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { isPathInsideDir } = require('../sanitize');

async function buildAndDeployApps(result, baseDir) {
  const deployedApps = [];
  if (!result.apps || typeof result.apps !== 'object') return deployedApps;

  const appsDir = path.join(baseDir, 'apps');

  for (const [appName, app] of Object.entries(result.apps)) {
    if (!app.files || typeof app.files !== 'object') continue;

    const appDir = path.join(appsDir, appName);
    fs.mkdirSync(appDir, { recursive: true });

    for (const [filePath, content] of Object.entries(app.files)) {
      if (!isPathInsideDir(filePath, appDir)) continue;
      const fullPath = path.resolve(appDir, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
    }

    if (app.files['package.json']) {
      try {
        execSync('npm install', {
          cwd: appDir,
          encoding: 'utf-8',
          timeout: 60000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {}
    }

    if (app.deploy) {
      try {
        const { loadConfig } = require('../config');
        const cfg = loadConfig();
        const token = cfg?.vercel?.token;
        if (token) {
          const deployOutput = execSync(
            `npx vercel --prod --name "${appName.replace(/[^a-zA-Z0-9_-]/g, '')}" --yes 2>&1`,
            { cwd: appDir, encoding: 'utf-8', timeout: 120000, env: { ...process.env, VERCEL_TOKEN: token } }
          );
          const urlMatch = deployOutput.match(/https:\/\/[^\s]+\.vercel\.app/);
          deployedApps.push({ name: appName, url: urlMatch ? urlMatch[0] : null });
        }
      } catch (e) {
        deployedApps.push({ name: appName, url: null, error: e.message.substring(0, 200) });
      }
    }
  }

  return deployedApps;
}

module.exports = { buildAndDeployApps };
