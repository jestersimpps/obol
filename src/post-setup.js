const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const { OBOL_DIR, loadConfig, saveConfig } = require('./config');

function isPostSetupDone() {
  const flag = path.join(OBOL_DIR, '.post-setup-complete');
  return fs.existsSync(flag);
}

function markPostSetupDone() {
  const flag = path.join(OBOL_DIR, '.post-setup-complete');
  fs.writeFileSync(flag, JSON.stringify({
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
  },

  {
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
    name: 'harden-ssh',
    description: 'Harden SSH — key-only auth, no root password, rate limiting',
    run: async () => {
      try {
        const sshdConfig = '/etc/ssh/sshd_config';
        if (!fs.existsSync(sshdConfig)) {
          return { success: true, message: 'No sshd_config found — not an SSH server' };
        }

        let config = fs.readFileSync(sshdConfig, 'utf-8');
        let changed = false;
        const changes = [];

        const settings = {
          'Port': '2222',
          'PasswordAuthentication': 'no',
          'PermitRootLogin': 'prohibit-password',
          'PubkeyAuthentication': 'yes',
          'MaxAuthTries': '3',
          'LoginGraceTime': '20',
          'X11Forwarding': 'no',
          'PermitEmptyPasswords': 'no',
        };

        for (const [key, value] of Object.entries(settings)) {
          const regex = new RegExp(`^#?\\s*${key}\\s+.*$`, 'm');
          const target = `${key} ${value}`;
          if (config.match(new RegExp(`^${key}\\s+${value}$`, 'm'))) continue;

          if (regex.test(config)) {
            config = config.replace(regex, target);
          } else {
            config += `\n${target}`;
          }
          changes.push(`${key}=${value}`);
          changed = true;
        }

        if (changed) {
          // Backup original
          execSync(`cp ${sshdConfig} ${sshdConfig}.bak.obol`, { stdio: 'pipe' });
          fs.writeFileSync(sshdConfig, config);
          // Test config before restarting
          try {
            execSync('sshd -t', { stdio: 'pipe' });
            execSync('systemctl reload sshd 2>/dev/null || systemctl reload ssh 2>/dev/null', { stdio: 'pipe' });
            return { success: true, message: `Hardened: ${changes.join(', ')}` };
          } catch (e) {
            // Rollback on bad config
            execSync(`cp ${sshdConfig}.bak.obol ${sshdConfig}`, { stdio: 'pipe' });
            return { success: false, message: `Config test failed, rolled back: ${e.message}` };
          }
        }

        return { success: true, message: 'SSH already hardened' };
      } catch (e) {
        return { success: false, message: `SSH hardening failed: ${e.message}` };
      }
    },
  },

  {
    name: 'install-fail2ban',
    description: 'Install and configure fail2ban to block brute-force attacks',
    run: async () => {
      try {
        // Check if already running
        try {
          const status = execSync('systemctl is-active fail2ban', { encoding: 'utf-8' }).trim();
          if (status === 'active') {
            return { success: true, message: 'fail2ban already active' };
          }
        } catch {}

        // Install
        execSync('apt-get update -qq && apt-get install -y -qq fail2ban', { stdio: 'pipe' });

        // Write jail config — port 2222 (hardened by obol)
        const jailLocal = `[sshd]
enabled = true
port = 2222
filter = sshd
logpath = /var/log/auth.log
maxretry = 3
bantime = 3600
findtime = 600
`;
        fs.writeFileSync('/etc/fail2ban/jail.local', jailLocal);

        execSync('systemctl enable fail2ban && systemctl restart fail2ban', { stdio: 'pipe' });

        return { success: true, message: 'fail2ban active (SSH port 2222, max 3 retries, 1h ban)' };
      } catch (e) {
        return { success: false, message: `fail2ban setup failed: ${e.message}` };
      }
    },
  },

  {
    name: 'setup-firewall',
    description: 'Enable UFW firewall — allow SSH (port 2222) only',
    run: async () => {
      try {
        // Install ufw if not present
        try { execSync('which ufw', { stdio: 'pipe' }); } catch {
          execSync('apt-get update -qq && apt-get install -y -qq ufw', { stdio: 'pipe' });
        }

        const status = execSync('ufw status', { encoding: 'utf-8' });
        if (status.includes('Status: active')) {
          return { success: true, message: 'Firewall already active' };
        }

        // Default deny inbound, allow outbound
        execSync('ufw default deny incoming', { stdio: 'pipe' });
        execSync('ufw default allow outgoing', { stdio: 'pipe' });
        execSync('ufw allow 2222/tcp', { stdio: 'pipe' });
        execSync('echo "y" | ufw enable', { stdio: 'pipe' });

        return { success: true, message: 'Firewall enabled (SSH port 2222 only, deny all inbound)' };
      } catch (e) {
        return { success: false, message: `Firewall setup failed: ${e.message}` };
      }
    },
  },

  {
    name: 'setup-auto-updates',
    description: 'Enable automatic security updates',
    run: async () => {
      try {
        // Check if already configured
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
  },

  {
    name: 'kernel-hardening',
    description: 'Apply kernel network security settings',
    run: async () => {
      try {
        const sysctlConf = `/etc/sysctl.d/99-obol-hardening.conf`;

        const settings = {
          // SYN flood protection
          'net.ipv4.tcp_syncookies': '1',
          // Reverse path filtering
          'net.ipv4.conf.all.rp_filter': '1',
          'net.ipv4.conf.default.rp_filter': '1',
          // Ignore ICMP redirects
          'net.ipv4.conf.all.accept_redirects': '0',
          'net.ipv4.conf.default.accept_redirects': '0',
          'net.ipv6.conf.all.accept_redirects': '0',
          // Don't send ICMP redirects
          'net.ipv4.conf.all.send_redirects': '0',
          // Ignore broadcast pings
          'net.ipv4.icmp_echo_ignore_broadcasts': '1',
          // Log martian packets
          'net.ipv4.conf.all.log_martians': '1',
        };

        const content = '# OBOL security hardening\n' +
          Object.entries(settings).map(([k, v]) => `${k} = ${v}`).join('\n') + '\n';

        fs.writeFileSync(sysctlConf, content);
        execSync('sysctl --system 2>/dev/null', { stdio: 'pipe' });

        return { success: true, message: 'Kernel hardening applied (syncookies, rp_filter, no redirects)' };
      } catch (e) {
        return { success: false, message: `Kernel hardening failed: ${e.message}` };
      }
    },
  },
];

// ─── RUNNER ───

async function runPostSetup(config, reportFn) {
  if (isPostSetupDone()) return;

  if (process.platform !== 'linux') {
    reportFn?.(`⚠️  Post-setup tasks are designed for Linux VPS servers. Skipping on ${process.platform}.`);
    markPostSetupDone();
    return [];
  }

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
