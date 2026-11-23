#!/bin/sh
# Install Cerium Host for the current user. Use sh -s -- --nightly or --version VERSION.
set -eu

fail() { printf 'cerium-host: %s\n' "$*" >&2; exit 1; }

install_host() {
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) fail 'This installer supports Linux and macOS.' ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) fail 'This installer supports x64 and ARM64.' ;;
  esac

  repo=CeriumHQ/cerium
  api="https://api.github.com/repos/$repo/releases"
  case "$#:${1:-}" in
    0:) endpoint="$api/latest" ;;
    1:--nightly) endpoint="$api?per_page=100" ;;
    2:--version) endpoint=; version=${2#v} ;;
    1:--version=*) endpoint=; version=${1#--version=}; version=${version#v} ;;
    *) fail 'Usage: install.sh [--nightly | --version VERSION]' ;;
  esac
  if [ -n "$endpoint" ]; then
    # Only public releases have a tag_name in GitHub's unauthenticated response.
    page=1
    while :; do
      request=$endpoint
      if [ "${1:-}" = --nightly ]; then request="$endpoint&page=$page"; fi
      json=$(curl -fsSL "$request")
      tags=$(printf '%s' "$json" | tr ',' '\n' | sed -n 's/^[[:space:]{]*"tag_name"[[:space:]]*:[[:space:]]*"v\([^"]*\)".*/\1/p')
      if [ "${1:-}" != --nightly ]; then version=$tags; break; fi
      version=$(printf '%s\n' "$tags" | sed -n '/-nightly\./{p;q;}')
      [ -z "$version" ] || break
      [ "$(printf '%s\n' "$tags" | wc -l)" -ge 100 ] || break
      page=$((page + 1))
    done
  fi
  case "$version" in ''|*[!0-9.nightly-]*) fail 'No matching Cerium release found.' ;; esac
  printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-nightly\.n?[0-9]+)?$' ||
    fail 'Invalid Cerium release version.'

  root=${CERIUM_HOST_DIR:-"$HOME/.local/share/cerium-host"}
  case "$root" in /*) ;; *) root="$PWD/$root" ;; esac
  bin="$HOME/.local/bin"
  mkdir -p "$root" "$bin"
  root=$(cd "$root" && pwd -P)
  bin=$(cd "$bin" && pwd -P)
  release="cerium-host-$version-$os-$arch"
  archive="$release.tar.gz"
  url="https://github.com/$repo/releases/download/v$version/$archive"
  staging=$(mktemp -d "$root/.install.XXXXXXXX")
  trap 'rm -rf "$staging"' EXIT
  trap 'exit 1' HUP INT TERM
  printf 'Downloading %s\n' "$archive"
  curl -fsSL "$url" -o "$staging/$archive"
  curl -fsSL "$url.sha256" -o "$staging/checksum"
  if command -v sha256sum >/dev/null 2>&1; then
    sum=$(sha256sum < "$staging/$archive")
  else
    sum=$(shasum -a 256 < "$staging/$archive")
  fi
  hash=${sum%% *}
  [ "$(cat "$staging/checksum")" = "$hash  $archive" ] || fail "Checksum mismatch for $archive."
  tar -xzf "$staging/$archive" -C "$staging"
  payload="$staging/$release"
  [ "$("$payload/bin/cerium-host" --version)" = "$version" ] || fail 'The downloaded host could not start.'

  [ ! -d "$bin/cerium-host" ] || fail "$bin/cerium-host is a directory."
  if [ "$bin" != "$root/bin" ] && [ -e "$bin/cerium-host" ] && [ ! -L "$bin/cerium-host" ]; then
    fail "Move the existing $bin/cerium-host before installing."
  fi
  mkdir "$root/.install-lock" || fail "Another installer holds $root/.install-lock."
  trap 'rmdir "$root/.install-lock"; rm -rf "$staging"' EXIT
  # The service keeps these bootstrap paths while the CLI updater switches current-version.
  id=$(printf '%s\n' "$hash" | sed -E 's/^(.{8})(.{4})(.{4})(.{4})(.{12}).*/\1-\2-\3-\4-\5/')
  selected="$version-$id"
  mkdir -p "$root/releases" "$root/bin" "$root/runtime/bin"
  if [ ! -x "$root/runtime/bin/node" ]; then
    cp "$payload/runtime/bin/node" "$staging/bootstrap-node"
    mv -f "$staging/bootstrap-node" "$root/runtime/bin/node"
  fi
  cp "$payload/runtime/LICENSE" "$root/runtime/LICENSE"
  for script in cerium-host standalone.mjs; do
    cp "$payload/bin/$script" "$staging/$script"
    mv -f "$staging/$script" "$root/bin/$script"
  done
  if [ ! -d "$root/releases/$selected" ]; then mv "$payload" "$root/releases/$selected"; fi
  printf '%s\n' "$selected" > "$staging/current-version"
  mv -f "$staging/current-version" "$root/current-version"
  if [ "$bin" != "$root/bin" ]; then ln -sf "$root/bin/cerium-host" "$bin/cerium-host"; fi
  printf 'Installed Cerium Host %s in %s\n' "$version" "$root"
  # shellcheck disable=SC2016 # The PATH hint is a command for the user to run.
  case ":${PATH:-}:" in
    *":$bin:"*) ;;
    *) printf 'Add this to your shell profile and run it in this terminal:\n  export PATH="$HOME/.local/bin:$PATH"\n' ;;
  esac
  printf '\nSign in and start the service:\n  cerium-host login\n  cerium-host service install\n'
}

install_host "$@"
