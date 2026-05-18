#!/bin/bash
set -e

echo "正在执行数据库迁移..."
cd "$(dirname "$0")/../backend"

alembic revision --autogenerate -m "$1"
alembic upgrade head
echo "数据库迁移完成。"
