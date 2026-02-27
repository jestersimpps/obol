const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const { OBOL_DIR, saveConfig } = require('../config');

const installPass = {
  name: 'install-pass',
  description: 'Install GPG and pass for encrypted secret storage',
  run: async (config) => {
    try {
      try {
        execSync('which pass', { stdio: 'pipe' });
        execSync('pass ls', { stdio: 'pipe' });
        return { success: true, message: 'pass already configured' };
      } catch {}

      const os = execSync('cat /etc/os-release 2>/dev/null || echo "unknown"', { encoding: 'utf-8' });
      if (os.includes('Ubuntu') || os.includes('Debian')) {
        execSync('apt-get update -qq && apt-get install -y -qq gnupg pass', { stdio: 'pipe' });
      } else if (os.includes('Alpine')) {
        execSync('apk add --quiet gnupg pass', { stdio: 'pipe' });
      } else {
        return { success: false, message: 'Unknown OS — install gpg and pass manually' };
      }

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

      const keys = execSync('gpg --list-keys --with-colons obol@local', { encoding: 'utf-8' });
      const fprLine = keys.split('\n').find(l => l.startsWith('fpr:'));
      const fingerprint = fprLine?.split(':')[9];

      if (!fingerprint) {
        return { success: false, message: 'GPG key generated but could not extract fingerprint' };
      }

      execSync(`pass init ${fingerprint}`, { stdio: 'pipe' });

      return { success: true, message: `GPG key + pass store initialized (${fingerprint.slice(-8)})` };
    } catch (e) {
      return { success: false, message: `Failed: ${e.message}` };
    }
  },
};

const migrateSecrets = {
  name: 'migrate-secrets',
  description: 'Move plaintext secrets from config.json to pass',
  run: async (config) => {
    try {
      execSync('pass ls', { stdio: 'pipe' });

      const isOAuth = !!config.anthropic?.oauth;

      const secrets = {
        ...(isOAuth ? {
          'obol/anthropic-oauth-access': config.anthropic.oauth.accessToken,
          'obol/anthropic-oauth-refresh': config.anthropic.oauth.refreshToken,
        } : {
          'obol/anthropic-key': config.anthropic?.apiKey,
        }),
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
        const result = spawnSync('pass', ['insert', '-m', passPath], {
          input: value,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        if (result.status !== 0) throw new Error(result.stderr?.toString() || 'pass insert failed');
        migrated++;
      }

      const cleanConfig = {
        ...config,
        anthropic: isOAuth ? {
          oauth: {
            accessToken: 'pass:obol/anthropic-oauth-access',
            refreshToken: 'pass:obol/anthropic-oauth-refresh',
            expires: config.anthropic.oauth.expires,
          },
        } : { apiKey: 'pass:obol/anthropic-key' },
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
};

const installPm2 = {
  name: 'install-pm2',
  description: 'Install pm2 process manager and configure auto-start on boot',
  run: async () => {
    try {
      try {
        execSync('which pm2', { stdio: 'pipe' });
        return { success: true, message: 'pm2 already installed' };
      } catch {}

      execSync('npm install -g pm2', { stdio: 'pipe' });
      execSync('pm2 startup -u root --hp /root 2>/dev/null || pm2 startup', { stdio: 'pipe' });

      return { success: true, message: 'pm2 installed + startup configured' };
    } catch (e) {
      return { success: false, message: `pm2 setup failed: ${e.message}` };
    }
  },
};

const setupSwap = {
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

      const swapInfo = execSync('swapon --show', { encoding: 'utf-8' });
      if (swapInfo.trim()) {
        return { success: true, message: 'Swap already configured' };
      }

      execSync('fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile', { stdio: 'pipe' });

      const fstab = fs.readFileSync('/etc/fstab', 'utf-8');
      if (!fstab.includes('/swapfile')) {
        fs.appendFileSync('/etc/fstab', '\n/swapfile none swap sw 0 0\n');
      }

      return { success: true, message: `2GB swap created (${totalMB}MB RAM detected)` };
    } catch (e) {
      return { success: false, message: `Swap setup failed: ${e.message}` };
    }
  },
};

const setupAutoUpdates = {
  name: 'setup-auto-updates',
  description: 'Enable automatic security updates',
  run: async () => {
    try {
      try {
        const conf = fs.readFileSync('/etc/apt/apt.conf.d/20auto-upgrades', 'utf-8');
        if (conf.includes('Unattended-Upgrade "1"')) {
          return { success: true, message: 'Unattended upgrades already enabled' };
        }
      } catch {}

      execSync('apt-get update -qq && apt-get install -y -qq unattended-upgrades', { stdio: 'pipe' });

      const autoConf = `APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
`;
      fs.writeFileSync('/etc/apt/apt.conf.d/20auto-upgrades', autoConf);
      execSync('systemctl enable unattended-upgrades', { stdio: 'pipe' });

      return { success: true, message: 'Automatic security updates enabled (daily check, weekly cleanup)' };
    } catch (e) {
      return { success: false, message: `Auto-updates setup failed: ${e.message}` };
    }
  },
};

module.exports = [installPass, migrateSecrets, installPm2, setupSwap, setupAutoUpdates];
