echo "--- cert attempt"; sudo tailscale cert oracle-vps.tail317d12.ts.net 2>&1 | head -6
echo "--- funnel status"; sudo tailscale funnel status 2>&1 | head -8