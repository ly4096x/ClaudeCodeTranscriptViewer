# Source this to run the Playwright tests in a REAL, MAXIMIZED Brave window as a
# NATIVE Wayland client on a KDE/Wayland desktop (no Xwayland):
#
#   node server.js sample/sample-session.jsonl --port 5858 --host 127.0.0.1 &
#   source tests/desktop-env.sh
#   BASE_URL=http://127.0.0.1:5858 node tests/verify.mjs
#
# launch.mjs reads $CHROMIUM_BIN (executablePath) and, when $WAYLAND_DISPLAY is
# set, adds --ozone-platform=wayland and --start-maximized (viewport:null).

export CHROMIUM_BIN="${CHROMIUM_BIN:-$(command -v brave || command -v chromium)}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
unset DISPLAY XAUTHORITY   # force native Wayland, not X11 / Xwayland

# Desktop screenshot (prove the window is on screen), KDE:  spectacle -b -n -f -o desktop.png
