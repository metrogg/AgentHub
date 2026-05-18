#!/bin/bash
set -e

echo "正在初始化数据库..."
cd "$(dirname "$0")/../backend"

alembic upgrade head
echo "数据库初始化完成。"
