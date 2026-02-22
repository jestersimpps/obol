# Deploy OBOL on DigitalOcean

Complete guide: from zero to a running AI assistant in ~10 minutes.

## 1. Create a Droplet

Go to [cloud.digitalocean.com](https://cloud.digitalocean.com) → **Create** → **Droplets**

| Setting | Value |
|---------|-------|
| **Region** | Pick the closest to you (e.g. Amsterdam, Frankfurt) |
| **Image** | Ubuntu 24.04 LTS |
| **Size** | Basic → Regular → **$6/mo** (1 vCPU, 1GB RAM, 25GB SSD) |
| **Auth** | SSH key (recommended) or password |
| **Hostname** | `obol` |

> 💡 The $6 droplet is enough. OBOL is a single Node.js process. The embedding model uses ~200MB RAM on first load, then stays resident. If you plan to run heavy scripts, go $12/mo (2GB RAM).

Click **Create Droplet**. Copy the IP address.

## 2. Connect via SSH

```bash
ssh root@YOUR_DROPLET_IP
```

## 3. Install Node.js

```bash
# Install Node.js 22 LTS via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# Verify
node -v   # v22.x.x
npm -v    # 10.x.x
```

## 4. Install OBOL

```bash
npm install -g obol
```

## 5. Prepare Your Accounts

Before running `obol init`, have these ready:

### Anthropic API Key
1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Sign up / log in
3. Go to **API Keys** → **Create Key**
4. Copy the key (starts with `sk-ant-`)
5. Add credits ($5 minimum) — go to **Billing** → **Add funds**

### Telegram Bot Token
1. Open Telegram, search for **@BotFather**
2. Send `/newbot`
3. Choose a name (e.g. "My OBOL")
4. Choose a username (e.g. `my_obol_bot`)
5. Copy the token (looks like `7123456789:AAF...`)

### Your Telegram User ID
1. Open Telegram, search for **@userinfobot**
2. Send `/start`
3. It replies with your numeric ID (e.g. `206639616`)

### Supabase Access Token
1. Go to [supabase.com](https://supabase.com) → sign up (free)
2. Go to [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens)
3. **Generate new token** → name it "obol" → copy it

### Vercel Token
1. Go to [vercel.com](https://vercel.com) → sign up (free)
2. Go to [vercel.com/account/tokens](https://vercel.com/account/tokens)
3. **Create** → name it "obol" → copy the token

### GitHub Token
1. Go to [github.com/settings/tokens](https://github.com/settings/tokens)
2. **Generate new token (classic)**
3. Select scope: `repo`
4. Copy the token

## 6. Run Setup

```bash
obol init
```

The wizard walks you through everything:

```
🪙 OBOL — Your AI, your rules.

─── Anthropic ───
  Paste your Anthropic API key: ****
  ✅ Anthropic configured

─── Telegram ───
  Paste BotFather token: ****
  ✅ Telegram configured

─── Memory (Supabase) ───
  Supabase setup: Create new project
  Supabase access token: ****
  Creating project... ✅
  Waiting for project to initialize (~60s)... ✅
  Running migrations... ✅

─── GitHub (backup) ───
  Set up GitHub backup? Yes
  GitHub token: ****
  Creating private repo: yourname/obol-brain... ✅

─── Identity ───
  Your name: Jo
  Bot name: Mr. Meeseeks
  Your Telegram user ID: 206639616

🪙 Done! Run: obol start
```

## 7. Test It (Foreground)

```bash
obol start
```

Go to Telegram, open your bot, send a message. You should get a response from Claude.

Press `Ctrl+C` to stop.

## 8. Run as Daemon

```bash
obol start -d
```

Check it's running:

```bash
obol status
obol logs
```

## 9. Keep It Running (systemd)

Create a systemd service so OBOL survives reboots:

```bash
cat > /etc/systemd/system/obol.service << 'EOF'
[Unit]
Description=OBOL AI Assistant
After=network.target

[Service]
Type=simple
User=root
ExecStart=/usr/bin/node /usr/lib/node_modules/obol/src/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

# Enable and start
systemctl enable obol
systemctl start obol

# Check status
systemctl status obol

# View logs
journalctl -u obol -f
```

Now OBOL starts automatically on boot and restarts if it crashes.

## 10. Customize Your Bot

SSH in and edit the personality files:

```bash
nano ~/.obol/personality/SOUL.md    # Bot personality
nano ~/.obol/personality/USER.md    # About you
nano ~/.obol/personality/AGENTS.md  # How it works
```

Restart after changes:

```bash
systemctl restart obol
```

## Costs

| Service | Cost |
|---------|------|
| DigitalOcean droplet | $6/mo |
| Anthropic API (Claude Sonnet) | ~$3/mo for moderate use |
| Supabase | Free (500MB) |
| GitHub | Free (private repos) |
| Vercel | Free (100GB bandwidth) |
| Embeddings | Free (runs locally) |
| **Total** | **~$9/mo** |

## Updating

```bash
npm update -g obol
systemctl restart obol
```

## Backup & Restore

OBOL automatically backs up to GitHub daily at 3 AM (personality, scripts, commands, daily notes).

To restore on a new droplet:

```bash
npm install -g obol
obol init --restore
# Paste GitHub token → it clones your brain
# Re-enter Telegram token + Anthropic key
obol start -d
```

## Troubleshooting

### Bot doesn't respond
```bash
obol status          # Is it running?
obol logs            # Check for errors
```

### "Not authorized" / bot ignores messages
Check that your Telegram user ID is correct in `~/.obol/config.json`:
```bash
cat ~/.obol/config.json | grep allowedUsers
```

### Memory not working
```bash
# Test Supabase connection
curl -s -H "apikey: YOUR_KEY" https://YOUR_PROJECT.supabase.co/rest/v1/obol_memory?limit=1
```

### Out of memory (OOM)
Upgrade to 2GB droplet:
```bash
# In DigitalOcean dashboard: Droplet → Resize → 2GB ($12/mo)
```

Or add swap:
```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### Firewall
OBOL only makes outbound connections (Telegram, Anthropic, Supabase). No ports need to be opened. But basic hardening is good practice:

```bash
ufw allow OpenSSH
ufw enable
```

---

*That's it. One droplet, one process, one bot. 🪙*
