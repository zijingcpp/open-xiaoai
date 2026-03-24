#!/bin/sh

WORK_DIR="/data/open-xiaoai"
CLIENT_BIN="$WORK_DIR/client"
SERVER_ADDRESS="wss://127.0.0.1:4399"

if [ -f "$WORK_DIR/server.txt" ]; then
    SERVER_ADDRESS=$(cat "$WORK_DIR/server.txt")
fi

kill -9 $(ps | grep "open-xiaoai/client" | grep -v grep | awk '{print $1}') > /dev/null 2>&1 || true

"$CLIENT_BIN" "$SERVER_ADDRESS" > /dev/null 2>&1 &
