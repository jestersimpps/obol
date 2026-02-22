const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { OBOL_DIR, loadConfig, saveConfig } = require('./config');

const POST_SETUP_FLAG = path.join(OBOL_DIR, '.post-setup-complete');

function isPostSetupDone() {
  return fs.existsSync(POST_SETUP_FLAG);
}

function markPostSetupDone() {
  fs.writeFileSync(POST_SETUP_FLAG, JSON.stringify({
    completedAt: new Date().toISOString(),
    tasks: SETUP_TASKS.map(t => t.name),
  }));
}

// ─── SETUP TASKS ───
// These run in order after first-run conversation completes.
// Each task is a self-contained function that returns { success, message }.
// Add new tasks here — they'll run automatically on next boot.

const SETUP_TASKS = [
  {
    name: 'install-pass',
    description: 'Install GPG and pass for encrypted secret storage',
    run: async (config) => {
      try {
        // Check if already installed
        try {
          execSync('which pass', { stdio: 'pipe' });
          execSync('pass ls', { stdio: 'pipe' });
          return { success: true, message: 'pass already configured' };
        } catch {}

        // Install gpg + pass
        const os = execSync('cat /etc/os-release 2>/dev/null || echo "unknown"', { encoding: 'utf-8' });
        if (os.includes('Ubuntu') || os.includes('Debian')) {
          execSync('apt-get update -qq && apt-get install -y -qq gnupg pass', { stdio: 'pipe' });
        } else if (os.includes('Alpine')) {
          execSync('apk add --quiet gnupg pass', { stdio: 'pipe' });
        } else {
          return { success: false, message: 'Unknown OS — install gpg and pass manually' };
        }

        // Generate GPG key (non-interactive)
        const botName = config.bot?.name || 'OBOL';
        const gpgBatch = `
%no-protection
Key-Type: RSA
Key-Length: 2048
Subkey-Type: RSA
Subkey-Length: 2048
Name-Real: ${botName}
Name-Email: obol@local
Expire-Date: 0
%commit
`;
        const batchFile = path.join(OBOL_DIR, '.gpg-batch');
        fs.writeFileSync(batchFile, gpgBatch);
        execSync(`gpg --batch --gen-key ${batchFile}`, { stdio: 'pipe' });
        fs.unlinkSync(batchFile);

        // Get the key fingerprint
        const keys = execSync('gpg --list-keys --with-colons obol@local', { encoding: 'utf-8' });
        const fprLine = keys.split('\n').find(l => l.startsWith('fpr:'));
        const fingerprint = fprLine?.split(':')[9];

        if (!fingerprint) {
          return { success: false, message: 'GPG key generated but could not extract fingerprint' };
        }

        // Init pass store
        execSync(`pass init ${fingerprint}`, { stdio: 'pipe' });

        return { success: true, message: `GPG key + pass store initialized (${fingerprint.slice(-8)})` };
      } catch (e) {
        return { success: false, message: `Failed: ${e.message}` };
      }
    },
  },

  {
    name: 'migrate-secrets',
    description: 'Move plaintext secrets from config.json to pass',
    run: async (config) => {
      try {
        // Verify pass is working
        execSync('pass ls', { stdio: 'pipe' });

        const secrets = {
          'obol/anthropic-key': config.anthropic?.apiKey,
          'obol/telegram-token': config.telegram?.token,
          'obol/supabase-url': config.supabase?.url,
          'obol/supabase-key': config.supabase?.serviceKey,
          'obol/supabase-access-token': config.supabase?.accessToken,
          'obol/github-token': config.github?.token,
          'obol/vercel-token': config.vercel?.token,
        };

        let migrated = 0;
        for (const [passPath, value] of Object.entries(secrets)) {
          if (!value) continue;
          execSync(`echo "${value}" | pass insert -m ${passPath}`, { stdio: 'pipe' });
          migrated++;
        }

        // Rewrite config.json without plaintext secrets
        const cleanConfig = {
          ...config,
          anthropic: { apiKey: 'pass:obol/anthropic-key' },
          telegram: { ...config.telegram, token: 'pass:obol/telegram-token' },
          supabase: config.supabase ? {
            url: 'pass:obol/supabase-url',
            serviceKey: 'pass:obol/supabase-key',
            ...(config.supabase.accessToken ? { accessToken: 'pass:obol/supabase-access-token' } : {}),
            ...(config.supabase.anonKey ? { anonKey: config.supabase.anonKey } : {}),
          } : null,
          github: config.github ? {
            ...config.github,
            token: 'pass:obol/github-token',
          } : null,
          vercel: config.vercel ? { token: 'pass:obol/vercel-token' } : null,
        };

        saveConfig(cleanConfig);

        return { success: true, message: `Migrated ${migrated} secrets to pass. Config cleaned.` };
      } catch (e) {
        return { success: false, message: `Failed: ${e.message}` };
      }
    },
  },

  {
    name: 'setup-swap',
    description: 'Add swap if RAM is low (embedding model needs ~200MB)',
    run: async () => {
      try {
        const memInfo = execSync('free -m', { encoding: 'utf-8' });
        const totalMatch = memInfo.match(/Mem:\s+(\d+)/);
        const totalMB = totalMatch ? parseInt(totalMatch[1]) : 0;

        if (totalMB >= 2048) {
          return { success: true, message: `${totalMB}MB RAM — swap not needed` };
        }

        // Check if swap already exists
        const swapInfo = execSync('swapon --show', { encoding: 'utf-8' });
        if (swapInfo.trim()) {
          return { success: true, message: 'Swap already configured' };
        }

        // Create 2GB swap
        execSync('fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile', { stdio: 'pipe' });

        // Make persistent
        const fstab = fs.readFileSync('/etc/fstab', 'utf-8');
        if (!fstab.includes('/swapfile')) {
          fs.appendFileSync('/etc/fstab', '\n/swapfile none swap sw 0 0\n');
        }

        return { success: true, message: `2GB swap created (${totalMB}MB RAM detected)` };
      } catch (e) {
        return { success: false, message: `Swap setup failed: ${e.message}` };
      }
    },
  },

  {
    name: 'setup-firewall',
    description: 'Enable UFW firewall with SSH only',
    run: async () => {
      try {
        // Check if ufw is available
        try { execSync('which ufw', { stdio: 'pipe' }); } catch {
          return { success: true, message: 'ufw not installed — skipping' };
        }

        const status = execSync('ufw status', { encoding: 'utf-8' });
        if (status.includes('Status: active')) {
          return { success: true, message: 'Firewall already active' };
        }

        execSync('ufw allow OpenSSH', { stdio: 'pipe' });
        execSync('echo "y" | ufw enable', { stdio: 'pipe' });

        return { success: true, message: 'Firewall enabled (SSH only)' };
      } catch (e) {
        return { success: false, message: `Firewall setup failed: ${e.message}` };
      }
    },
  },
];

// ─── RUNNER ───

async function runPostSetup(config, reportFn) {
  if (isPostSetupDone()) return;

  reportFn?.('🪙 Running post-setup tasks...\n');

  const results = [];
  for (const task of SETUP_TASKS) {
    reportFn?.(`⚙️ ${task.description}...`);
    const result = await task.run(config);
    results.push({ name: task.name, ...result });
    reportFn?.(`  ${result.success ? '✅' : '⚠️'} ${result.message}`);
  }

  markPostSetupDone();

  const summary = results.map(r => `${r.success ? '✅' : '⚠️'} ${r.name}: ${r.message}`).join('\n');
  reportFn?.(`\n🪙 Post-setup complete!\n${summary}`);

  return results;
}

module.exports = { isPostSetupDone, runPostSetup, SETUP_TASKS };
