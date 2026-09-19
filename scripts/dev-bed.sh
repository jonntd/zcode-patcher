#!/bin/sh
# dev-bed —— ZCode 升级迭代用的隔离测试床（只在 /tmp 副本上操作，绝不碰真实安装）
#
# 用法：
#   scripts/dev-bed.sh start [端口]   拷副本（rsync 增量）→ 打全套补丁 → 隔离启动（CDP 调试口）
#   scripts/dev-bed.sh patch          只对副本重打全套补丁（配合改完锚点后快速验证）
#   scripts/dev-bed.sh stop           关掉副本实例（只按 /tmp/ZCode-dev.app 路径匹配，安全）
#   scripts/dev-bed.sh reset          清空副本的隔离数据目录（登录态/会话全没了）
#   scripts/dev-bed.sh url            打印 CDP 端点
#
# 副本实例必须带 ZCODE_DESKTOP_USER_DATA_DIR / ZCODE_DESKTOP_HOME_DIR：
#   不设的话主进程会强制回落到真实数据目录，和正在运行的宿主撞单实例锁 → 秒退，
#   那是锁冲突不是补丁坏了（这个坑写过进 AGENTS.md）。
#
# CDP 探针（实例起来后）：
#   curl -s http://127.0.0.1:9444/json          看 page target 是否出现（出现=没卡启动）
#   再用 Node 原生 WebSocket 连 webSocketDebuggerUrl 做 Runtime.evaluate：
#   document.querySelector("[data-testid='root-startup-loading']") 为 null 即通过启动。

set -u
SRC="/Applications/ZCode.app"
BED="/tmp/ZCode-dev.app"
UD="/tmp/zcode-dev-ud"
HOME_DIR="/tmp/zcode-dev-home"
PORT="${2:-9444}"
PATCHER="$HOME/.zcode/patcher/zcode-patcher.js"
[ -f "$PATCHER" ] || PATCHER="$(cd "$(dirname "$0")" && pwd)/zcode-patcher.js"

bed_running() {
  ps aux | grep -F "$BED" | grep -v grep | awk '{print $2}'
}

sync_bed() {
  echo "[i] 同步副本（rsync 增量，首次约 1 分钟）..."
  rsync -a --delete "$SRC/" "$BED/"
}

case "${1:-start}" in
  start)
    sync_bed
    echo "[i] 对副本打全套补丁..."
    node "$PATCHER" --usage-chart --menu-width --continue-btn --tps-footer --modelhub \
      --enhance-btn --quota-banner --edit-all "$BED" >/dev/null || { echo "[x] 打补丁失败"; exit 1; }
    echo "[i] 隔离启动副本，CDP 端口 ${PORT}..."
    ZCODE_DESKTOP_USER_DATA_DIR="$UD" ZCODE_DESKTOP_HOME_DIR="$HOME_DIR" \
      "$BED/Contents/MacOS/ZCode" --remote-debugging-port="$PORT" > /tmp/zcode-dev-bed.log 2>&1 &
    for i in $(seq 1 40); do
      sleep 1
      PAGES=$(curl -s "http://127.0.0.1:$PORT/json" 2>/dev/null | grep -c '"type": "page"' || true)
      [ "${PAGES:-0}" -ge 1 ] && break
    done
    if [ "${PAGES:-0}" -ge 1 ]; then
      echo "[√] 副本已启动：CDP http://127.0.0.1:$PORT/json（page target 已出现 = 启动握手通过）"
    else
      echo "[!] 40 秒内未出现 page target——大概率卡启动，看日志: tail -40 /tmp/zcode-dev-bed.log"
    fi
    ;;
  patch)
    [ -d "$BED" ] || { echo "[x] 副本不存在，先 start"; exit 1; }
    for pid in $(bed_running); do kill "$pid" 2>/dev/null; done
    sleep 2
    node "$PATCHER" --usage-chart --menu-width --continue-btn --tps-footer --modelhub \
      --enhance-btn --quota-banner --edit-all "$BED" || exit 1
    echo "[√] 副本补丁已更新，scripts/dev-bed.sh start 重新拉起"
    ;;
  stop)
    PIDS=$(bed_running)
    [ -z "$PIDS" ] && { echo "[.] 副本未在运行"; exit 0; }
    # 杀完可能还有垂死的 helper 再生，轮询补杀直到清零（最多 5 轮），杜绝残留进程
    # 抢占下一轮实例的 crashpad/数据库锁（表现为新实例卡启动、mach_port FATAL）
    i=0
    while [ -n "$(bed_running)" ] && [ $i -lt 5 ]; do
      for pid in $(bed_running); do kill "$pid" 2>/dev/null; done
      sleep 1; i=$((i+1))
    done
    echo "[√] 副本已关闭（只匹配 $BED 路径，宿主无恙）"
    ;;
  reset)
    for pid in $(bed_running); do kill "$pid" 2>/dev/null; done
    sleep 1
    rm -rf "$UD" "$HOME_DIR"
    echo "[√] 副本数据目录已清空（下次启动回到未登录/全新态）"
    ;;
  url)
    echo "CDP: http://127.0.0.1:$PORT/json"
    echo "日志: /tmp/zcode-dev-bed.log"
    ;;
  *)
    sed -n '2,10p' "$0"
    ;;
esac
