set -u
echo "--- tools"
for c in bun node npm curl cloudflared tailscale caddy nginx git; do printf '%-12s ' "$c"; command -v "$c" || echo "-"; done
echo "--- cloudflared"
ps -eo pid,args | grep -i cloudflared | grep -v grep || echo none
ls -la "$HOME/.cloudflared" 2>/dev/null || echo "no ~/.cloudflared"
echo "--- tailscale"
tailscale status --self=true 2>&1 | head -3
echo "--- running services"
systemctl list-units --type=service --state=running --no-pager 2>/dev/null | grep -Ei 'cloudflared|tailscale|caddy|nginx|bridge|zen|opencode' || echo none
echo "--- os"
. /etc/os-release; echo "$PRETTY_NAME"
echo "--- memory/disk"
free -m | head -2
df -h / | tail -1
echo "--- existing ports 20129/8443/443"
ss -ltn | grep -E ':(20129|443|8443)\b' || echo "free"
