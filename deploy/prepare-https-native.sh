#!/bin/bash
# Prepare only: do not enable DNS, public ports, HTTPS, or change the application/ledger.
# Official stable package instructions: https://caddyserver.com/docs/install
# Run once as root on the existing Ubuntu/systemd deployment. Failures leave Caddy masked.
set -euo pipefail
umask 077
[[ $EUID == 0 ]] || { echo 'Run as root on the existing ECS server.' >&2; exit 1; }
logdir=$(mktemp -d /var/log/yuantuo-https-preparation.XXXXXX)
exec 3>&1
printf 'Private preparation log: %s\n' "$logdir" >&3
exec >"$logdir/preparation.log" 2>&1
policy_created=false
masks_created=false
cleanup() {
    result=$?
    # Package installation may fail midway; restore masks before removing its policy barrier.
    if $masks_created; then
        systemctl mask caddy.service caddy-api.service || result=1
    fi
    if $policy_created; then
        if cmp -s /usr/sbin/policy-rc.d "$logdir/policy-rc.d"; then
            rm -- /usr/sbin/policy-rc.d
        else
            echo 'Service-start policy changed externally; left untouched for administrator review.'
            result=1
        fi
    fi
    printf 'exit_status=%s\n' "$result" >"$logdir/result.txt"
    printf 'Preparation exit status: %s. Log: %s/preparation.log\n' "$result" "$logdir" >&3
    exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
die() { echo "ERROR: $*" >&2; exit 1; }
absent() { [[ ! -e $1 && ! -L $1 ]] || die "Existing path must be reviewed, not overwritten: $1"; }
for tool in systemctl curl gpg apt-get dpkg-query ss flock unshare; do
    command -v "$tool" >/dev/null || die "Required tool missing: $tool";
done
exec 9>/run/yuantuo-https-preparation.lock
flock -n 9 || die 'Another HTTPS preparation is running.'
[[ $(. /etc/os-release; printf '%s' "$ID") == ubuntu ]] || die 'This script targets Ubuntu only.'
systemctl is-active --quiet yuantuo-finance.service || die 'Existing finance service is not active.'
app_pid=$(systemctl show -p MainPID --value yuantuo-finance.service)
[[ $app_pid =~ ^[1-9][0-9]*$ ]] || die 'Finance service has no running main process.'
no_public_listeners() {
    local listeners
    listeners=$(ss -H -ltn '( sport = :80 or sport = :443 )')
    [[ -z $listeners ]] || die 'TCP 80/443 already has a listener.'
    listeners=$(ss -H -lun '( sport = :80 or sport = :443 )')
    [[ -z $listeners ]] || die 'UDP 80/443 already has a listener.'
}
no_public_listeners
! command -v caddy >/dev/null || die 'Caddy already exists; review it instead of reinstalling.'
! dpkg-query -W caddy >/dev/null 2>&1 || die 'An existing Caddy package record requires review.'
key=/usr/share/keyrings/caddy-stable-archive-keyring.gpg
source_file=/etc/apt/sources.list.d/caddy-stable.list
pending=/etc/yuantuo-finance-https-pending
for path in /etc/caddy "$key" "$source_file" "$pending" /usr/sbin/policy-rc.d; do absent "$path"; done
if grep -Riq 'caddy' /etc/apt/sources.list /etc/apt/sources.list.d 2>/dev/null; then
    die 'An existing Caddy repository requires review.'
fi
for directory in /usr/share/keyrings /etc/apt/keyrings; do
    [[ ! -d $directory ]] || [[ -z $(find "$directory" -maxdepth 1 -iname '*caddy*' -print) ]] || die 'An existing Caddy key requires review.'
done
for unit in caddy.service caddy-api.service; do
    [[ $(systemctl show -p LoadState --value "$unit") == not-found ]] || die "Existing unit requires review: $unit"
    absent "/etc/systemd/system/$unit"
    absent "/run/systemd/system/$unit"
done

download() { curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --show-error --silent --location --retry 2 --connect-timeout 15 --max-time 120 "$1" -o "$2"; }
download https://dl.cloudsmith.io/public/caddy/stable/gpg.key "$logdir/caddy.key.asc"
download https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt "$logdir/caddy-stable.list"
# Reject unexpected repository content; use only the official HTTPS stable archive.
awk 'NF && $1 !~ /^#/ { if ($1 != "deb" && $1 != "deb-src") exit 1;
    if ($2 != "[signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg]" || $3 != "https://dl.cloudsmith.io/public/caddy/stable/deb/debian" || $4 != "any-version" || $5 != "main" || NF != 5) exit 1;
    if ($1 == "deb") binary++ } END { if (binary != 1) exit 1 }' "$logdir/caddy-stable.list" || die 'Unexpected official repository definition.'
mkdir "$logdir/gnupg"
gpg --homedir "$logdir/gnupg" --batch --dearmor --output "$logdir/caddy.key.gpg" "$logdir/caddy.key.asc"
gpg --homedir "$logdir/gnupg" --batch --show-keys --fingerprint "$logdir/caddy.key.gpg"

# Two barriers before apt: persistent masks plus the Debian maintainer-script policy.
# The temporary policy denies all package-triggered service starts/restarts.
masks_created=true
systemctl mask caddy.service caddy-api.service
for unit in caddy.service caddy-api.service; do
    [[ $(systemctl is-enabled "$unit" 2>/dev/null || :) == masked ]] || die "Failed to mask $unit"
done
printf '#!/bin/sh\n# Temporary yuantuo HTTPS preparation: do not start services.\nexit 101\n' >"$logdir/policy-rc.d"
(set -o noclobber; cat "$logdir/policy-rc.d" >/usr/sbin/policy-rc.d)
policy_created=true
chmod 0755 /usr/sbin/policy-rc.d
install -m 0644 "$logdir/caddy.key.gpg" "$key"
install -m 0644 "$logdir/caddy-stable.list" "$source_file"
mkdir "$logdir/apt"
printf 'Package: caddy\nPin: origin dl.cloudsmith.io\nPin-Priority: 1001\n\nPackage: caddy\nPin: version *\nPin-Priority: -1\n' >"$logdir/caddy.pref"
apt_options=(-o "Dir::Etc::sourcelist=$source_file" -o 'Dir::Etc::sourceparts=-'
    -o "Dir::Etc::preferences=$logdir/caddy.pref" -o 'Dir::Etc::preferencesparts=-'
    -o 'APT::Update::Error-Mode=any' -o 'Acquire::https::Verify-Peer=true' -o 'Acquire::https::Verify-Host=true'
    -o "Dir::Log=$logdir/apt" -o "Dpkg::Options::=--log=$logdir/dpkg.log")
apt-get "${apt_options[@]}" update
DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get "${apt_options[@]}" --yes --no-remove --no-install-recommends install caddy
systemctl mask caddy.service caddy-api.service
for unit in caddy.service caddy-api.service; do
    [[ $(systemctl is-enabled "$unit" 2>/dev/null || :) == masked ]] || die "Mask was not retained: $unit"
    ! systemctl is-active --quiet "$unit" || die "Unexpected active service: $unit"
done
no_public_listeners

mkdir -m 0700 "$pending"
cat >"$pending/Caddyfile" <<'CADDY'
# PENDING ONLY: enable after ICP approval and interactive owner initialization.
{
    email 1921344174@qq.com
    admin off
}
finance.yuantuo.vip {
    encode zstd gzip
    reverse_proxy 127.0.0.1:4318 {
        header_up X-Finance-Client-IP {remote_host}
    }
}
CADDY
# Validate without any network interface; do not load this into a running server.
XDG_CONFIG_HOME="$logdir/caddy-config" XDG_DATA_HOME="$logdir/caddy-data" \
    unshare --net -- caddy validate --config "$pending/Caddyfile" --adapter caddyfile
systemctl is-active --quiet yuantuo-finance.service || die 'Finance service is no longer active.'
[[ $(systemctl show -p MainPID --value yuantuo-finance.service) == "$app_pid" ]] || die 'Finance process changed during preparation; review required.'
no_public_listeners
printf '%s\n' 'Prepared only. caddy and caddy-api remain masked.' \
    'Pending: ICP approval, interactive owner initialization, backup/restore verification, DNS and HTTPS activation.' \
    'No DNS/security-group changes; no application or ledger access.' >"$pending/STATUS.txt"
caddy version
echo "Pending configuration: $pending/Caddyfile"
