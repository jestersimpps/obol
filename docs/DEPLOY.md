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

> ⚠️ **After first run**, OBOL hardens your server automatically — including moving SSH to port 2222. From then on:
> ```bash
> ssh -p 2222 root@YOUR_DROPLET_IP
> ```

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
npm install -g obol-ai
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
OBOL auto-detects your Telegram ID during setup — just send any message to your bot before running `obol init`. Alternatively:
1. Open Telegram, search for **@userinfobot**
2. Send `/start`
3. It replies with your numeric ID (e.g. `206639616`)

### Supabase (two options)

**Option A: Auto-create project** — you need an access token:
1. Go to [supabase.com](https://supabase.com) → sign up (free)
2. Go to [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens)
3. **Generate new token** → name it "obol" → copy it

**Option B: Use existing project** — you need the project ID + service role key:
1. Go to your project's **Settings > API** page: `supabase.com/dashboard/project/<project-id>/settings/api`
2. Copy the **Project ID** (or full URL like `https://xxx.supabase.co`)
3. Copy the **service_role key** (under Project API keys — the one that bypasses RLS)

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

The wizard walks you through everything with inline credential validation:

```
🪙 OBOL — Your AI, your rules.

─── Step 1/7: Anthropic (AI brain) ───
  Anthropic API key: ****
  Validating Anthropic... ✅ Key valid

─── Step 2/7: Telegram (chat interface) ───
  Telegram bot token: ****
  Validating Telegram... ✅ Bot: @my_obol_bot

─── Step 3/7: Supabase (memory) ───
  Supabase setup: Use existing project
  Project URL or ID: abcdefghijklmnopqrst
  Service role key: ****
  Validating Supabase... ✅ Connected

─── Step 4/7: GitHub (backup) ───
  GitHub token: ****
  Creating private repo: yourname/obol-brain... ✅

─── Step 5/7: Vercel (deploy sites) ───
  Vercel token: ****
  Validating Vercel... ✅ Token valid

─── Step 6/7: Identity ───
  Your name: Jo
  Bot name: Mr. Meeseeks

─── Step 7/7: Access control ───
  Found users who messaged this bot:
    206639616 — Jo (@jo)
  Use this user? Yes

🪙 Done! Setup complete.

  Next steps:
    obol start      Start the bot
    obol start -d   Start as background daemon
    obol config     Edit configuration later
    obol status     Check bot status
```

If a credential fails validation, you can continue and fix it later with `obol config`.

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

## 9. Keep It Running (pm2, optional)

pm2 keeps OBOL alive, auto-restarts on crash, and survives reboots. pm2 is installed automatically when you run `obol start -d`. If pm2 isn't installed, `obol stop` and `obol logs` fall back to PID files and log files.

```bash
# Install pm2 globally
npm install -g pm2

# Start OBOL with pm2
pm2 start $(which obol) --name obol -- start

# Auto-start on boot
pm2 startup
pm2 save

# Useful commands
pm2 status          # See running processes
pm2 logs obol       # Tail logs
pm2 restart obol    # Restart
pm2 stop obol       # Stop
pm2 monit           # Live monitoring dashboard
```

That's it — OBOL auto-starts on boot and restarts if it crashes.

## 10. Customize Your Bot

SSH in and edit the personality files (replace `USER_ID` with your Telegram user ID):

```bash
nano ~/.obol/users/USER_ID/personality/SOUL.md    # Bot personality
nano ~/.obol/users/USER_ID/personality/USER.md    # About you
nano ~/.obol/users/USER_ID/personality/AGENTS.md  # How it works
```

Restart after changes:

```bash
pm2 restart obol
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
pm2 restart obol
```

## Backup & Restore

OBOL automatically backs up to GitHub daily at 3 AM (personality, scripts, commands, daily notes).

To restore on a new droplet:

```bash
npm install -g obol-ai
obol init --restore
# Paste GitHub token → it clones your brain
# Re-enter Telegram token + Anthropic key
obol start -d
```

## Editing Config

Edit any credential or setting interactively:

```bash
obol config
```

Sections: Anthropic, Telegram, Supabase, GitHub, Vercel, Identity, Access Control, Heartbeat, Evolution.

To start fresh:

```bash
obol init --reset
```

## Troubleshooting

### Can't SSH after first run
OBOL moves SSH to port 2222 during security hardening:
```bash
ssh -p 2222 root@YOUR_DROPLET_IP
```

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
ufw allow 2222/tcp
ufw enable
```
OBOL does this automatically during post-setup.

---

*That's it. One droplet, one process, one bot. 🪙*
