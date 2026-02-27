const fs = require('fs');
const { execSync } = require('child_process');

const hardenSsh = {
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
        execSync(`cp ${sshdConfig} ${sshdConfig}.bak.obol`, { stdio: 'pipe' });
        fs.writeFileSync(sshdConfig, config);
        try {
          execSync('sshd -t', { stdio: 'pipe' });
          execSync('systemctl reload sshd 2>/dev/null || systemctl reload ssh 2>/dev/null', { stdio: 'pipe' });
          return { success: true, message: `Hardened: ${changes.join(', ')}` };
        } catch (e) {
          execSync(`cp ${sshdConfig}.bak.obol ${sshdConfig}`, { stdio: 'pipe' });
          return { success: false, message: `Config test failed, rolled back: ${e.message}` };
        }
      }

      return { success: true, message: 'SSH already hardened' };
    } catch (e) {
      return { success: false, message: `SSH hardening failed: ${e.message}` };
    }
  },
};

const installFail2ban = {
  name: 'install-fail2ban',
  description: 'Install and configure fail2ban to block brute-force attacks',
  run: async () => {
    try {
      try {
        const status = execSync('systemctl is-active fail2ban', { encoding: 'utf-8' }).trim();
        if (status === 'active') {
          return { success: true, message: 'fail2ban already active' };
        }
      } catch {}

      execSync('apt-get update -qq && apt-get install -y -qq fail2ban', { stdio: 'pipe' });

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
};

const setupFirewall = {
  name: 'setup-firewall',
  description: 'Enable UFW firewall — allow SSH (port 2222) only',
  run: async () => {
    try {
      try { execSync('which ufw', { stdio: 'pipe' }); } catch {
        execSync('apt-get update -qq && apt-get install -y -qq ufw', { stdio: 'pipe' });
      }

      const status = execSync('ufw status', { encoding: 'utf-8' });
      if (status.includes('Status: active')) {
        return { success: true, message: 'Firewall already active' };
      }

      execSync('ufw default deny incoming', { stdio: 'pipe' });
      execSync('ufw default allow outgoing', { stdio: 'pipe' });
      execSync('ufw allow 2222/tcp', { stdio: 'pipe' });
      execSync('echo "y" | ufw enable', { stdio: 'pipe' });

      return { success: true, message: 'Firewall enabled (SSH port 2222 only, deny all inbound)' };
    } catch (e) {
      return { success: false, message: `Firewall setup failed: ${e.message}` };
    }
  },
};

const kernelHardening = {
  name: 'kernel-hardening',
  description: 'Apply kernel network security settings',
  run: async () => {
    try {
      const sysctlConf = `/etc/sysctl.d/99-obol-hardening.conf`;

      const settings = {
        'net.ipv4.tcp_syncookies': '1',
        'net.ipv4.conf.all.rp_filter': '1',
        'net.ipv4.conf.default.rp_filter': '1',
        'net.ipv4.conf.all.accept_redirects': '0',
        'net.ipv4.conf.default.accept_redirects': '0',
        'net.ipv6.conf.all.accept_redirects': '0',
        'net.ipv4.conf.all.send_redirects': '0',
        'net.ipv4.icmp_echo_ignore_broadcasts': '1',
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
};

module.exports = [hardenSsh, installFail2ban, setupFirewall, kernelHardening];
