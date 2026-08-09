#!/bin/sh
set -eu

readonly allowed_uid="${CANARY_UID:?CANARY_UID is required}"
readonly allowed_gid="${CANARY_GID:?CANARY_GID is required}"

case "$allowed_uid:$allowed_gid" in
  *[!0-9:]*|:|*:)
    echo "CANARY_UID and CANARY_GID must be numeric" >&2
    exit 64
    ;;
esac

if [ "$allowed_uid" = 0 ]; then
  echo "The canary browser must not run as root" >&2
  exit 64
fi

apply_ipv4_policy() {
  iptables -F OUTPUT
  iptables -P OUTPUT DROP
  iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  iptables -A OUTPUT -d 1.1.1.1/32 -p udp --dport 53 -j ACCEPT
  iptables -A OUTPUT -d 1.1.1.1/32 -p tcp --dport 53 -j ACCEPT
  iptables -A OUTPUT -d 1.0.0.1/32 -p udp --dport 53 -j ACCEPT
  iptables -A OUTPUT -d 1.0.0.1/32 -p tcp --dport 53 -j ACCEPT
  if [ "${CANARY_ALLOW_LOOPBACK_STUB:-0}" = 1 ]; then
    iptables -A OUTPUT -d 127.0.0.1/32 -p tcp --dport 19172 -j ACCEPT
  fi
  iptables -A OUTPUT -d 0.0.0.0/8 -j REJECT
  iptables -A OUTPUT -d 10.0.0.0/8 -j REJECT
  iptables -A OUTPUT -d 100.64.0.0/10 -j REJECT
  iptables -A OUTPUT -d 127.0.0.0/8 -j REJECT
  iptables -A OUTPUT -d 169.254.0.0/16 -j REJECT
  iptables -A OUTPUT -d 172.16.0.0/12 -j REJECT
  iptables -A OUTPUT -d 192.0.0.0/24 -j REJECT
  iptables -A OUTPUT -d 192.0.2.0/24 -j REJECT
  iptables -A OUTPUT -d 192.168.0.0/16 -j REJECT
  iptables -A OUTPUT -d 198.18.0.0/15 -j REJECT
  iptables -A OUTPUT -d 198.51.100.0/24 -j REJECT
  iptables -A OUTPUT -d 203.0.113.0/24 -j REJECT
  iptables -A OUTPUT -d 224.0.0.0/4 -j REJECT
  iptables -A OUTPUT -d 240.0.0.0/4 -j REJECT
  iptables -A OUTPUT -p tcp -m multiport --dports 80,443 -j ACCEPT
}

apply_ipv6_policy() {
  ip6tables -F OUTPUT
  ip6tables -P OUTPUT DROP
  ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  if [ "${CANARY_ALLOW_LOOPBACK_STUB:-0}" = 1 ]; then
    ip6tables -A OUTPUT -d ::1/128 -p tcp --dport 19172 -j ACCEPT
  fi
  ip6tables -A OUTPUT -d ::1/128 -j REJECT
  ip6tables -A OUTPUT -d fc00::/7 -j REJECT
  ip6tables -A OUTPUT -d fe80::/10 -j REJECT
  ip6tables -A OUTPUT -d ff00::/8 -j REJECT
  ip6tables -A OUTPUT -d 2001:db8::/32 -j REJECT
  ip6tables -A OUTPUT -p tcp -m multiport --dports 80,443 -j ACCEPT
}

apply_ipv4_policy
if [ -e /proc/net/if_inet6 ]; then
  apply_ipv6_policy
fi

if [ "$allowed_gid" != "$(id -g node)" ]; then
  groupmod -o -g "$allowed_gid" node
fi
if [ "$allowed_uid" != "$(id -u node)" ]; then
  usermod -o -u "$allowed_uid" node
fi

exec setpriv \
  --reuid=node \
  --regid=node \
  --init-groups \
  --no-new-privs \
  --bounding-set=-all \
  --inh-caps=-all \
  --ambient-caps=-all \
  -- "$@"
