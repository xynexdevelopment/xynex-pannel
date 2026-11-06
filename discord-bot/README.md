# XyneX Discord Bot

Discord se apne XyneX Panel ke servers manage karo — slash commands + buttons.
Bot panel se **API key** ke through baat karta hai (Admin → API Keys), isliye panel ka password kahin nahi chahiye.

## Commands
| Command | Kaam | Kaun |
|---|---|---|
| `/server <name>` | **Poora card:** status, address, type/version, limits, live CPU/RAM/Disk/Network, players, backups + saare buttons | allowed |
| `/servers` | Saare servers ki list + dropdown (kisi pe click karo to poora card khulta hai) | allowed |
| `/start` `/stop` `/restart <name>` | Power control (baad me poora card dikhta hai) | allowed |
| `/kill <name>` | Force kill | **admin** |
| `/players <name>` | Online players | allowed |
| `/backup <name>` | Backup banao | allowed |
| `/command <name> <cmd>` | Console command bhejna | **admin** |
| `/panel` | Panel health + uptime + online count | allowed |

`/server` card ke buttons: ▶️ Start · 🔄 Restart · ⏹️ Stop · ☠️ Kill (confirm maangta hai, admin) · 🔁 Refresh · 👥 Players · ⌨️ Console (popup me command likho, admin) · 💾 Backup.
Server ka naam type karte hi autocomplete list aati hai.

Extra: server online/offline hote hi channel me alert (`NOTIFY_CHANNEL_ID`), aur har action ka log (`LOG_CHANNEL_ID`: kisne kya kiya).

## Look & feel
- **Loading card:** har command/button pe pehle ~2 second ka animated "Loading…" card aata hai, phir poora embed (`LOADING_MS` se change karo, `0` = bina delay).
- **Apne emojis:** bot ke apne bane hue emojis hain (`emojis/` folder: online/offline dots, start/stop/restart, CPU, RAM, disk, network, players, console, backup, loading spinner…). Bot pehli baar start hote hi inhe khud **application emojis** ki tarah upload kar leta hai — tumhe kuch nahi karna. Upload fail ho to normal Discord emojis use hote hain.
- Emojis dobara banane/badalne ho to `python3 tools/make-emojis.py` (Pillow chahiye), phir bot restart.
- Usage bars rang badalte hain: 🟩 normal → 🟨 60%+ → 🟥 85%+.

## Setup (5 min) — sab kuch panel se
1. **Discord bot banao:** https://discord.com/developers/applications → New Application → *Bot* tab → **Reset Token** (copy karke rakho). *OAuth2 → URL Generator* → scopes `bot` + `applications.commands` → permissions *Send Messages*, *Embed Links* → link se apne server me add karo.
2. **Panel me:** Admin → **API Keys** → neeche **Discord Bot** card → **Create bot API key**. Wo ek ready command dikhata hai.
3. **Server pe wo command chalao** (panel folder ke andar):
   ```bash
   cd discord-bot && PANEL_URL="https://tera-panel" PANEL_API_KEY="xynex-..." bash setup.sh
   ```
   Ye dependencies install karke bot ko PM2 me chala deta hai (24/7, crash pe restart).
4. **Panel me token daalo:** wahi Discord Bot card me *Bot token* paste karo, *Your Discord server ID* aur *Bot admins* me apni Discord user ID daalo → **Save settings**. Bot 15 second me khud reload ho jata hai aur status **Online** dikhne lagta hai.
5. Discord me `/server` try karo.

> Discord IDs copy karne ke liye: Discord → Settings → Advanced → **Developer Mode** ON, phir user/role/server/channel pe right-click → *Copy ID*.

Token kabhi bhi `.env` me nahi rakhna padta — wo panel me **encrypted** save hota hai aur browser ko wapas kabhi nahi bheja jata. Token badalna ho to panel me naya paste karke Save karo (bot khud restart hota hai).

## Settings (panel me)
Bot token · server (guild) ID · app ID (optional, token se auto) · Bot admins / Allowed users+roles · status-alert channel · action-log channel · enable/disable · **Restart bot** button. Jab tak koi admin/allowed ID nahi daaloge, koi bot use nahi kar sakta (safe default).

## Safety
- Bot ki API key `.env` me rehti hai (`chmod 600`), kabhi Discord me mat bhejna. Leak ho jaye to Panel → API Keys me revoke karo aur naya bana lo.
- Bot sirf wohi kar sakta hai jo key ka user panel me kar sakta hai.
- `/command` aur `kill` sirf `ADMIN_*` list wale use kar sakte hain.
- Panel aur bot alag machines pe ho to `PANEL_URL` me panel ka public URL do (https recommended).
