#!/usr/bin/env bash
# Create one LAN VM (dev, staging, or production) from an existing cloud-init
# template and turn it into that environment's openjury-<environment> runner.
# Run from your workstation; needs SSH to the Proxmox host as root and an
# authenticated `gh` with repository admin.
# Safe to rerun: an existing VM is reused and a registered runner is kept.
set +x
set -euo pipefail

ENVIRONMENT="${ENVIRONMENT:-dev}"
case "$ENVIRONMENT" in
  dev) default_vmid=201 default_memory=4096 ;;
  staging) default_vmid=202 default_memory=2048 ;;
  production) default_vmid=203 default_memory=2048 ;;
  *) echo "ENVIRONMENT must be dev, staging, or production" >&2; exit 1 ;;
esac
PVE_HOST="${PVE_HOST:-root@192.168.1.3}"
TEMPLATE_ID="${TEMPLATE_ID:-9000}"
VMID="${VMID:-$default_vmid}"
VM_NAME="${VM_NAME:-openjury-$ENVIRONMENT}"
CORES="${CORES:-2}"
MEMORY_MB="${MEMORY_MB:-$default_memory}"
DISK_GB="${DISK_GB:-32}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519.pub}"
REPO="${DEPLOYMENT_REPOSITORY:-}"
if [[ ! "$REPO" =~ ^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$ || "${TRUSTED_PRIVATE_DEPLOYMENT_REPO:-}" != "$REPO" ]]; then
  echo "Set DEPLOYMENT_REPOSITORY and TRUSTED_PRIVATE_DEPLOYMENT_REPO to the same explicitly trusted PRIVATE deployment repository; runner attachment is refused by default" >&2
  exit 1
fi
verify_private_repo() {
  if [[ "$(gh api "repos/$REPO" --jq .visibility)" != private ]]; then
    echo "Runner repository must be PRIVATE; public/internal repositories are refused" >&2
    exit 1
  fi
}
verify_private_repo
# Labels only route jobs; they do not restrict which workflows may execute.
# The private deployment repository must never run untrusted PR code.

cd "$(dirname "${BASH_SOURCE[0]}")"
pve() { ssh -o BatchMode=yes "$PVE_HOST" "$@"; }

if pve qm status "$VMID" >/dev/null 2>&1; then
  echo "VM $VMID already exists; reusing it."
else
  pve qm clone "$TEMPLATE_ID" "$VMID" --name "$VM_NAME" --full 1
  pve "cat > /tmp/$VM_NAME.pub" < "$SSH_KEY"
  pve qm set "$VMID" --cores "$CORES" --memory "$MEMORY_MB" --onboot 1 \
    --agent enabled=1 --ciuser ubuntu --sshkeys "/tmp/$VM_NAME.pub" --ipconfig0 ip=dhcp
  pve rm -f "/tmp/$VM_NAME.pub"
  pve qm resize "$VMID" scsi0 "${DISK_GB}G"
fi
pve qm status "$VMID" | grep -q running || pve qm start "$VMID"

# DHCP address: ask the guest agent, else sweep the bridge's /24 for the VM's MAC.
mac="$(pve qm config "$VMID" | sed -n 's/^net0: virtio=\([^,]*\).*/\1/p' | tr '[:upper:]' '[:lower:]')"
ip=""
for _ in $(seq 30); do
  ip="$(pve bash -s "$VMID" "$mac" <<'EOF' || true
vmid="$1" mac="$2"
qm guest cmd "$vmid" network-get-interfaces 2>/dev/null | python3 -c '
import json, sys
for i in json.load(sys.stdin):
    if i.get("hardware-address", "").lower() == sys.argv[1]:
        for a in i.get("ip-addresses", []):
            if a["ip-address-type"] == "ipv4":
                print(a["ip-address"]); sys.exit()
' "$mac" 2>/dev/null && exit
net="$(ip -4 -o addr show vmbr0 | awk '{split($4, a, "."); print a[1] "." a[2] "." a[3]; exit}')"
for i in $(seq 254); do ping -c1 -W1 "$net.$i" >/dev/null 2>&1 & done; wait
ip -4 neigh show dev vmbr0 | awk -v mac="$mac" 'tolower($3) == mac && $NF != "FAILED" {print $1; exit}'
EOF
)"
  [[ -n "$ip" ]] && break
  sleep 10
done
[[ -n "$ip" ]] || { echo "Could not find the IPv4 address of VM $VMID ($mac)" >&2; exit 1; }
echo "VM $VMID ($mac) is at $ip. Reserve this address for that MAC in your router."

vm=(ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 "ubuntu@$ip")
for _ in $(seq 30); do "${vm[@]}" true 2>/dev/null && break; sleep 5; done
# Exit code 2 means done with recoverable warnings, e.g. an interface rename.
"${vm[@]}" cloud-init status --wait >/dev/null || [[ $? -eq 2 ]]

verify_private_repo
token="$(gh api --method POST "repos/$REPO/actions/runners/registration-token" --jq .token)"
scp -q vm-bootstrap.sh "ubuntu@$ip:/tmp/openjury-bootstrap.sh"
printf '%s\n' "$token" | "${vm[@]}" sudo bash /tmp/openjury-bootstrap.sh "$REPO" "$ENVIRONMENT" "$REPO"

if [[ "$ENVIRONMENT" != dev ]]; then
  cat <<EOF

$ENVIRONMENT VM ready: plain HTTP on http://$ip. Point your TLS-terminating proxy
at it, preserving the Host header, then set (see docs/proxmox.md):
  gh variable set APP_HOST --env $ENVIRONMENT --body <public hostname>
  gh variable set TLS_TERMINATION --env $ENVIRONMENT --body upstream
  gh variable set SUPABASE_SELF_HOSTED --env $ENVIRONMENT --body true
Until SMTP is configured, magic-link emails stay in this VM's Mailpit:
  ssh -L 8025:127.0.0.1:8025 ubuntu@$ip   # then open http://localhost:8025
EOF
  exit 0
fi

# nip.io would read pr-21.192.168.1.114 as 21.192.168.1; the dashed form is unambiguous.
domain="${ip//./-}.nip.io"
cat <<EOF

Dev VM ready. Set these in GitHub, then push a PR revision (or rerun its CI):
  gh variable set DEV_BASE_DOMAIN --env dev --body "$domain"
  gh variable set APP_SCHEME --env dev --body http
  gh variable set PREVIEW_CD_ENABLED --body true
Previews will be served at http://pr-<number>.$domain
Configure PREVIEW_ADMIN_PASSWORD in the trusted deployment workflow before seeding previews.
Mailpit is available only through SSH:
  ssh -L 8025:127.0.0.1:8025 ubuntu@$ip   # then open http://localhost:8025
EOF
