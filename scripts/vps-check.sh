echo "--- funnel status"; sudo tailscale funnel status 2>&1 | head -15
echo "--- serve status"; sudo tailscale serve status 2>&1 | head -15
echo "--- https reachability"; curl -s -m 10 -o /dev/null -w "https://oracle-vps.tail317d12.ts.net/health -> %{http_code}\n" https://oracle-vps.tail317d12.ts.net/health || true