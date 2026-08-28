# HR visit tracker — server

Invite-only tool for a team to log and predict when HR roams by their stations.
Node/Express + SQLite backend, plain JS frontend, no public sign-up.

## What's in here

- `server.js` — Express app, security middleware, mounts routes
- `db.js` — SQLite schema (accounts, invites, sightings, sighting_logs)
- `routes/auth.js` — register (invite-gated), login, logout, invite generation (admin)
- `routes/sightings.js` — log a sighting (with server-side dedup), list, stats
- `middleware/auth.js` — JWT cookie auth
- `public/` — the frontend (plain HTML/JS, no build step)
- `scripts/init-admin.js` — one-time bootstrap to get your first invite code

## Local setup

```bash
npm install
cp .env.example .env
# edit .env: set JWT_SECRET to a long random string
#   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

node scripts/init-admin.js
# prints an invite code — the first account registered with it becomes admin

node server.js
# visit http://localhost:3000, register with that invite code
```

Once you're an admin, use the "Generate invite code" button in the app to
invite each coworker. Each code is single-use.

## Deploying to your own VPS

Assumes Ubuntu/Debian. Adjust package manager commands if different.

### 1. Get Node onto the server

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. Copy the project over and install

```bash
# from your local machine
scp -r hrtracker-server you@your-server:/home/you/hrtracker-server

# on the server
cd /home/you/hrtracker-server
npm install --omit=dev
cp .env.example .env
nano .env   # set JWT_SECRET (long random string), NODE_ENV=production
node scripts/init-admin.js   # note the invite code, keep it safe
```

### 3. Run it as a systemd service (keeps it alive, restarts on crash/reboot)

Create `/etc/systemd/system/hrtracker.service`:

```ini
[Unit]
Description=HR tracker
After=network.target

[Service]
Type=simple
User=you
WorkingDirectory=/home/you/hrtracker-server
ExecStart=/usr/bin/node server.js
Restart=on-failure
EnvironmentFile=/home/you/hrtracker-server/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hrtracker
sudo systemctl status hrtracker
```

### 4. Put nginx in front of it (reverse proxy + HTTPS)

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
```

`/etc/nginx/sites-available/hrtracker`:

```nginx
server {
    listen 80;
    server_name your-domain-or-subdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/hrtracker /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d your-domain-or-subdomain.com
```

Certbot handles the HTTPS cert and nginx config for you, and sets up
auto-renewal. `server.js` already has `app.set('trust proxy', 1)` and
`secure: NODE_ENV === 'production'` on the session cookie, so cookies will
only be sent over HTTPS once this is live.

### 5. Firewall

Only expose 80/443 (nginx) and SSH — the app itself listens on 127.0.0.1:3000
only, not on the public interface, so there's nothing extra to lock down
there.

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

### 6. Backups

The whole dataset is one file: `data/hr_tracker.db`. A simple cron job
copying it somewhere (or `sqlite3 data/hr_tracker.db ".backup backup.db"` on
a schedule) is enough for a team-sized tool like this.

## Inviting your team

You (the admin) generate a code per person from the in-app admin panel or
`POST /api/auth/invites`. Send each person their own code out of band
(Slack DM, etc.) — each code works once, so it can't be shared onward beyond
the person you gave it to.

## Notes on the security model

- Passwords are hashed with bcrypt (12 rounds), never stored in plaintext.
- Sessions are JWTs in httpOnly, sameSite cookies — not readable by page JS,
  not sent cross-site.
- Login/register are rate-limited (20 attempts / 15 min / IP) to slow down
  guessing.
- This is appropriately secure for an internal team tool. It has not had a
  professional security audit — don't put anything more sensitive than "who
  logged what sighting" into it.
