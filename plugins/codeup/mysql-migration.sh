#!/bin/sh
# Each invocation owns its server, data directory and socket, including concurrent checks of the same project.
set -eu
bin=$1
database=$2
shift 2
umask 077
dir=$(mktemp -d /tmp/codeup-mysql.XXXXXXXX)
server=
check=
cleanup() {
  if [ -n "$check" ]; then
    kill "$check" 2>/dev/null || :
    wait "$check" 2>/dev/null || :
  fi
  if [ -n "$server" ]; then
    kill "$server" 2>/dev/null || :
    wait "$server" 2>/dev/null || :
  fi
  rm -rf "$dir"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
# MySQL clients also consult .mylogin.cnf when invoked with --no-defaults.
export MYSQL_TEST_LOGIN_FILE="$dir/login.cnf"
if ! "$bin/mysqld" --no-defaults --initialize-insecure --datadir="$dir/data" >"$dir/init.log" 2>&1; then
  tail -n 12 "$dir/init.log" >&2
  exit 1
fi
socket=$dir/db.sock
"$bin/mysqld" --no-defaults --datadir="$dir/data" --socket="$socket" --pid-file="$dir/server.pid" \
  --skip-networking --mysqlx=OFF --log-error="$dir/server.log" &
server=$!
mysql() {
  "$bin/mysql" --no-defaults --protocol=SOCKET --socket="$socket" --user=root "$@"
}
tries=0
until mysql -Nse 'SELECT 1' >/dev/null 2>&1; do
  if ! kill -0 "$server" 2>/dev/null || [ "$tries" -ge 60 ]; then
    tail -n 12 "$dir/server.log" >&2
    exit 1
  fi
  tries=$((tries + 1))
  sleep 1
done
mysql -e "CREATE DATABASE \`$database\`"
mysql --database="$database" -Nse 'SELECT VERSION(), DATABASE(), @@port'
export DATABASE_URL="mysql://root@localhost/$database?socket=$socket"
"$@" &
check=$!
status=0
wait "$check" || status=$?
check=
exit "$status"
