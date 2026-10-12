#!/bin/sh
# Проверить конфигурацию nginx и применить её без остановки шлюза.
# Если в конфиге ошибка - перезагрузки не будет, текущая конфигурация продолжит работать.
set -e
cd "$(dirname "$0")"
docker compose exec nginx nginx -t
docker compose exec nginx nginx -s reload
echo "nginx: конфигурация применена"
