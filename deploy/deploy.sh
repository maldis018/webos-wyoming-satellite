#!/usr/bin/env bash
#
# Deploys this satellite to a rooted LG webOS TV over SSH, or checks that
# what runs on the TV matches this repository. The code (bin, src, init,
# package.json) comes from this working tree; the config file is passed in,
# so a household's own settings can live outside the repository. Each
# subcommand uses exactly one SSH connection, so an SSH agent that asks for
# approval per connection asks once.
#
# Disclaimer: provided as is, without warranty of any kind.
# Last modified: 2026-11-06 [2026-11-06]
# Written for: Linux talking to webOS 5 with Homebrew Channel root.
# Written by: Max Aldis and Mercury AI
# Variable names are uppercased if the variable is read-only or if it is an
# external variable.

set -o errexit  # abort on nonzero exitstatus
set -o nounset  # abort on unbound variable
set -o pipefail # don't hide errors within pipes

# ---- global variables ------------------------------------------------------
# The TV's address; there is no default, so nothing deploys to a wrong TV.
readonly TV_HOST="${TV_HOST:-}"
# Optional: the public half of a key held by an SSH agent, to select it.
readonly SSH_KEY_PUB="${SSH_KEY_PUB:-}"
readonly REMOTE_DIR="/media/developer/webos-wyoming-satellite"
readonly BOOT_HOOK="/var/lib/webosbrew/init.d/50-webos-wyoming-satellite"
readonly SETTLE_TIME_IN_SECONDS=4
# Repository root: this script lives in deploy/.
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_DIR
# What gets deployed, relative to the repository root.
readonly CODE_PATHS=(bin src init package.json)

# Prints usage to stdout.
# Input: none. Output: usage text. Called by: main.
function usage() {
  cat <<EOF
Usage: TV_HOST=<address> $(basename "$0") <command> <config.json>

Deploys the satellite from this working tree to a TV, or verifies the TV
against it. The config is any JSON file, for example a copy of
config.remote.example.json kept outside the repository.

Commands:
  deploy <config>  Copy the code and <config> (as config.json) to
                   $REMOTE_DIR, validate it,
                   install the boot hook and restart the satellite.
  verify <config>  Compare the md5 of every deployed file, the config
                   and the boot hook with this working tree and <config>.
  -h, --help       This text.

Environment:
  TV_HOST      address of the TV (required)
  SSH_KEY_PUB  public key file that selects an agent-held key (optional)
EOF
}

# Runs a remote shell snippet on the TV as root, passing stdin through.
# Input: $1 remote command. Output: remote stdout/stderr.
# Called by: cmd_deploy, cmd_verify.
function tv_ssh() {
  local -a key_opts=()
  if [[ -n "$SSH_KEY_PUB" ]]; then
    key_opts=(-o IdentitiesOnly=yes -o IdentityFile="$SSH_KEY_PUB")
  fi
  ssh "${key_opts[@]}" -o ConnectTimeout=10 "root@$TV_HOST" "$1"
}

# Checks TV_HOST: an IPv4 address or a plain host name.
# Input: TV_HOST. Output: exits 2 with a message when unusable.
# Called by: main.
function validate_host() {
  if [[ -z "$TV_HOST" ]]; then
    printf 'Set TV_HOST to the address of the TV (see --help)\n' >&2
    exit 2
  fi
  if [[ ! "$TV_HOST" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
    printf 'TV_HOST is not an address or host name: %s\n' "$TV_HOST" >&2
    exit 2
  fi
}

# Checks the config argument: an existing .json file with a plain name.
# Input: $1 path. Output: its absolute path on stdout; exits 2 otherwise.
# Called by: main.
function resolve_config_and_output_path() {
  local file="$1"
  if [[ -z "$file" || ! -f "$file" ]]; then
    printf 'No such config file: %s\n' "${file:-(none given)}" >&2
    exit 2
  fi
  if [[ ! "$(basename "$file")" =~ ^[A-Za-z0-9._-]+\.json$ ]]; then
    printf 'Config must be a .json file with a plain name: %s\n' \
      "$file" >&2
    exit 2
  fi
  printf '%s/%s\n' "$(cd "$(dirname "$file")" && pwd)" "$(basename "$file")"
}

# Warns when the code to deploy differs from the last commit, since the TV
# would then run code that is not in git.
# Input: none. Output: warning on stderr. Called by: cmd_deploy.
function warn_if_uncommitted() {
  local changes
  changes="$(git -C "$REPO_DIR" status --porcelain -- "${CODE_PATHS[@]}")"
  if [[ -n "$changes" ]]; then
    printf 'Warning: deploying uncommitted changes:\n%s\n' "$changes" >&2
  fi
}

# Prints the remote snippet that unpacks the archive from stdin, installs
# the config, validates it, installs the boot hook and restarts.
# Input: none. Output: snippet on stdout. Called by: cmd_deploy.
function deploy_snippet() {
  cat <<EOF
set -e
mkdir -p $REMOTE_DIR && cd $REMOTE_DIR
tar xzf - 2>/dev/null
mv -f deploy-config.json config.json
node bin/webos-wyoming-satellite.js --check --config config.json
cp init/webos-wyoming-satellite.sh $BOOT_HOOK && chmod +x $BOOT_HOOK
$BOOT_HOOK restart
sleep $SETTLE_TIME_IN_SECONDS
tail -n 4 satellite.log
EOF
}

# Packs the code and the config (as deploy-config.json) and deploys them.
# Input: $1 config path. Output: remote progress and log tail.
# Called by: main.
function cmd_deploy() {
  local config="$1" name
  name="$(basename "$config")"
  warn_if_uncommitted
  # The code from the repo root, then the config from its own directory
  # under a fixed name. GNU tar applies --transform to every member, so
  # the pattern is anchored to the config's exact name.
  tar czf - --transform "s|^${name//./\\.}\$|deploy-config.json|" \
    -C "$REPO_DIR" "${CODE_PATHS[@]}" -C "$(dirname "$config")" "$name" |
    tv_ssh "$(deploy_snippet)"
}

# Prints the md5 of every file that should be on the TV, under the name it
# has there, sorted by name.
# Input: $1 config path. Output: "md5  name" lines. Called by: cmd_verify.
function local_md5s_and_output() {
  local config="$1" file
  (
    cd "$REPO_DIR"
    git ls-files -- "${CODE_PATHS[@]}" | while read -r file; do
      md5sum "$file"
    done
    printf '%s  config.json\n' "$(md5sum < "$config" | cut -d' ' -f1)"
    printf '%s  boot-hook\n' \
      "$(md5sum < init/webos-wyoming-satellite.sh | cut -d' ' -f1)"
  ) | sort -k2
}

# Prints the remote snippet that lists md5s of the deployed files.
# Input: none. Output: snippet on stdout. Called by: cmd_verify.
function verify_snippet() {
  cat <<EOF
cd $REMOTE_DIR || exit 1
find . -type f ! -name 'satellite.log*' | sed 's|^\./||' | while read f; do
  md5sum "\$f"
done
echo "\$(md5sum < $BOOT_HOOK | cut -d' ' -f1)  boot-hook"
EOF
}

# Compares the TV with the working tree and reports any difference.
# Input: $1 config path. Output: "in sync" or a diff; exit 1 on a difference.
# Called by: main.
function cmd_verify() {
  local config="$1" remote local_list
  remote="$(tv_ssh "$(verify_snippet)" </dev/null | sort -k2)"
  local_list="$(local_md5s_and_output "$config")"
  if diff <(printf '%s\n' "$local_list") <(printf '%s\n' "$remote"); then
    printf 'in sync: the TV runs exactly this working tree and config\n'
    return 0
  fi
  printf '(< this working tree and config, > the TV)\n' >&2
  return 1
}

# Dispatches the subcommand.
# Input: command-line arguments. Output: per command. Called by: script.
function main() {
  local cmd="${1:-}" config
  case "$cmd" in
    -h|--help|"") usage ;;
    deploy|verify)
      validate_host
      config="$(resolve_config_and_output_path "${2:-}")"
      "cmd_$cmd" "$config"
      ;;
    *) usage >&2; return 2 ;;
  esac
}

main "$@"
