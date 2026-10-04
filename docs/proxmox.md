# Proxmox VM setup

[Project overview](../README.md) · [Deployment](deployment.md) · [CI/CD](ci-cd.md)

Run workstation commands from the repository root; file paths below are relative
to that root unless explicitly stated otherwise. Guest commands specify their
working directory separately.

`deploy/proxmox/` provisions **three full QEMU/KVM VMs**, not LXC containers:

| VM | Purpose | Deployment runner label |
| --- | --- | --- |
| `openjury-dev` | Disposable PR containers on a replaceable dev host | `openjury-dev` |
| `openjury-staging` | Staging application and smoke-test target | `openjury-staging` |
| `openjury-production` | Production application | `openjury-production` |

The automation runs from a **trusted administrator workstation**, not GitHub
Actions or an application runner. It uses administrator SSH to Proxmox and
guest SSH for configuration. It does not install Docker or runners on the
hypervisor, copy Proxmox credentials into guests, register runners, enable CD,
or change GitHub settings. No Proxmox infrastructure is contacted by CI.

## Prerequisites and trust boundaries

- A Proxmox VE host using the **legacy `pve-firewall` backend**, with its
  datacenter firewall enabled and working. The experimental/new nftables
  `proxmox-firewall` backend is not supported by these playbooks; do not change
  backends blindly on a live host. Keep a console session available while
  applying network changes.
- An existing **Ubuntu Server 24.04 amd64 cloud-init QEMU template**, with
  Python 3, `cloud-init`, `qemu-guest-agent`, and OpenSSH installed. Its root disk
  must be `scsi0`, its cloud-init drive attached, and it must have no runner
  registration, credentials, custom cloud-init snippets, extra NICs, or mounts.
  Clean cloud-init state/machine identity before converting it to a template.
- Separate VLANs on an existing VLAN-aware bridge, with routing/gateways
  configured by your network administrator. The playbooks do not reconfigure
  the physical switch, router, Proxmox management interface, or host firewall.
- An existing **off-host Proxmox Backup Server storage target**, already
  authenticated in Proxmox. Its server/storage must not depend on the same
  physical machine. Configure PBS retention verification, alerts, and restore
  access independently; do not put its credentials in this inventory.
- A trusted workstation with Python 3.12+ and Ansible from
  `deploy/proxmox/requirements.txt`, SSH keys, and verified SSH host fingerprints.
  Do not disable host-key checking. Verify new guest fingerprints via the
  Proxmox console before connecting.

All three VMs have distinct Docker daemons and runner identities. VM firewalls
allow inbound SSH only from the configured administrator network and inbound
HTTP/HTTPS for ingress. Outbound rules block private/link-local and explicitly
protected networks before allowing configured public DNS/NTP endpoints and web
traffic. Put the Proxmox/admin networks in `openjury_management_cidrs` and
**all other sensitive networks and NAT/public aliases** in
`openjury_protected_cidrs`. The other guests and PBS endpoint are also blocked
explicitly. Management and guest subnets must not overlap.
IPv6 is blocked by the VM policy; this setup uses static IPv4 networking.
The firewall is outside the guest, so Docker port publishing cannot bypass it.

This still needs your upstream firewall policy: prevent VLAN hopping, dev access
to Proxmox management, and access through public hostnames/NAT hairpins. Denying
private addresses alone does not protect a publicly reachable management IP.
DNS/NTP servers are narrow network exceptions, not general management access.

**One physical host is not high availability.** Hardware failure, hypervisor
compromise, or maintenance affects all environments. VMs isolate guest kernels,
not the physical failure domain. Dev workloads share the dev VM; fully automatic
hostile-PR previews need disposable per-PR VMs/microVMs and additional automation.

## Configure and apply

Copy `deploy/proxmox/inventory.example.yml` to the gitignored
`deploy/proxmox/inventory.local.yml`. Replace the sample VM IDs, host addresses,
template/storage names, VLANs, CIDRs, DNS/NTP endpoints, public SSH key,
backup settings, and ACME email. Read all inventory comments before setting the
operator confirmation flags. Never put private keys, passwords, GitHub tokens,
or Proxmox/PBS credentials in the file.

From the repository root on your administrator workstation:

```sh
python3 -m venv /tmp/openjury-ansible
/tmp/openjury-ansible/bin/pip install -r deploy/proxmox/requirements.txt
/tmp/openjury-ansible/bin/ansible-playbook \
  -i deploy/proxmox/inventory.local.yml deploy/proxmox/provision.yml --syntax-check
/tmp/openjury-ansible/bin/ansible-playbook \
  -i deploy/proxmox/inventory.local.yml deploy/proxmox/guests.yml --syntax-check
```

Review the inventory and network policy before running the same commands
**without** `--syntax-check`, provisioning first and configuring guests second.
Syntax checks cannot verify your live VLANs, firewall backend, template, storage,
or PBS availability. The examples are not ready-to-apply infrastructure values.
Do not treat check mode as a substitute for reviewing Proxmox CLI operations.

Guest configuration installs the Docker stable repository and Compose plugin,
the guest agent, and a checksum-verified GitHub runner release. It creates the
`openjury-runner` account and `/opt/actions-runner` but does not register it.
Registered runners manage their own updates; rerunning the playbook does not
unpack an archive over an existing runner installation.

Ingress is installed at `/opt/openjury-ingress/compose.yml` and uses the existing
application labels and `openjury-proxy` network. It runs Traefik with no public
dashboard, HTTP-to-HTTPS redirects, and a `letsencrypt` HTTP-01 resolver.
Docker socket access makes Traefik privileged infrastructure: a `:ro` socket
mount does **not** make its Docker API read-only. Keep it patched and do not
replace it with PR-controlled images.

## DNS, TLS, and runner registration

Point staging, production, and wildcard dev DNS at their respective ingress
endpoints. Each VM needs externally reachable TCP 80/443 for HTTP-01 and smoke
tests. If all VMs share **one public IP**, you need an upstream hostname/SNI-aware
proxy routing HTTP challenges and TLS traffic to the correct VM (or separate
public IPs); ordinary port forwarding cannot send the same ports to three VMs.
Avoid publishing any Proxmox, SSH, Docker, or Traefik management interface.

Wildcard DNS does not provide a wildcard certificate: this HTTP-01 setup issues
certificates per hostname. For many previews, plan a wildcard/DNS-01 certificate
strategy and ACME rate-limit handling separately. Do not place broad DNS account
credentials on the dev runner.

Before registration, configure **runner groups restricted to the trusted
deployment workflow paths on `main`** as described in
[deployment infrastructure](deployment.md#prepare-self-hosted-infrastructure).
If that restriction is unavailable for this repository/account, stop here and
use a separate trusted deployment repository or controller. Three isolated VMs
do not stop a malicious PR workflow from requesting an unrestricted production
runner.

On each guest, use the short-lived registration token from GitHub's runner setup
page interactively; do not persist it in inventory or command history:

```sh
sudo -iu openjury-runner
cd /opt/actions-runner
./config.sh
```

Choose the trusted registration URL/group, the VM's name, and its matching custom
label from the table. Retain the standard `self-hosted`, `linux`, `x64` labels.
Do not use `--replace` to take over another runner. Return to your administrator
account and install/start the service:

```sh
cd /opt/actions-runner
sudo ./svc.sh install openjury-runner
sudo ./svc.sh start
```

The runner account has Docker access, which is effectively root-equivalent
**inside its VM**. It must never have hypervisor credentials or host mounts.
Verify firewall isolation from the dev VM, HTTPS reachability from outside your
LAN, a successful production backup, and GitHub environment protections before
setting `PREVIEW_CD_ENABLED` or `CD_ENABLED` to `true`.

## Backups and recovery

The provisioning playbook configures a scheduled production-only backup job to
your existing off-host PBS storage. Verify an initial backup completes and
monitor subsequent jobs; creating a schedule does not prove recoverability.
Perform periodic restore drills into an **isolated network**, keeping the
restored runner service stopped to avoid duplicate runner identities/deployments.
Protect PBS access: a VM backup includes runner credentials and ingress TLS keys.

Snapshots on the same Proxmox host are not backups. Separately back up Supabase
data and retain known-good GHCR digests; neither is included in a frontend VM
backup. After restoring, verify DNS/TLS, runner identity, network isolation, the
chosen application digest, and smoke tests before restoring production traffic.
Dev has no data-recovery requirement: revoke its runner registration and rebuild
the VM when necessary. PR closure only removes that PR's containers/data, not
the shared dev VM or its runner.
