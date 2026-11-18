echo "--- dns name"
tailscale status --json 2>/dev/null | tr ',' '\n' | grep -m1 DNSName
echo "--- funnel status"
sudo tailscale funnel status 2>&1 | head -12
echo "--- enable funnel on 20129"
sudo tailscale funnel --bg 20129 2>&1 | head -20
echo "--- after"
sudo tailscale funnel status 2>&1 | head -12
