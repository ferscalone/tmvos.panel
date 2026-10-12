# Развёртывание шлюза на сервере — пошагово

План: шлюз ставим новый, дашборды пересобираем, **климатику не трогаем** (старая
версия остаётся на `:8000`, карточка ведёт туда). Переход климатики на `/climatica/` —
в последнем разделе, когда будет готова новая версия.

Обозначения: **[ПК]** — команда в PowerShell на Windows, **[СЕРВЕР]** — в SSH-сессии
(`ssh student@192.168.1.11`).

---

## Шаг 0. Разведка на сервере (ничего не меняет)

**[СЕРВЕР]**

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
```

Запишите имя контейнера backend климатики (скорее всего `climatica-web-backend-1`).

Где лежат проекты дашбордов (нужно, чтобы обновить их на месте и не потерять `logs/`):

```bash
docker inspect dashboard1 --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}'
docker inspect dashboard2 --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}'
```

Дальше эти папки называются `<DASH1>` и `<DASH2>`.

Свободен ли порт 80 и есть ли образы:

```bash
sudo ss -ltnp | grep ':80 ' || echo "порт 80 свободен"
docker images | grep -E 'nginx|node'
```

- Порт 80 занят → на шаге 3 в `.env` поставить другой `HTTP_PORT` (например 8080;
  тогда адрес будет `http://tmvos.panel:8080`), либо освободить 80.
- Нет образа `nginx` → шаг 1б. Образ `node:24-alpine` на сервере должен быть
  (на нём собирались дашборды).

Видит ли сервер стенды (от этого зависит «Включен/Выключен» на карточках):

```bash
curl -m 3 http://192.168.3.53/v1/health; echo
curl -m 3 http://192.168.3.54/v1/health; echo
```

Нет ответа при включённом стенде → панели работать будут, но карточки покажут
«Выключен». Тогда напишите — переделаем опрос.

---

## Шаг 1. Упаковать и отправить файлы

**[ПК]** (архивы — чтобы не тащить `node_modules`, `dist` и локальные `logs`)

```powershell
cd C:\Users\karta\Documents
tar -czf gateway.tgz -C mainpage --exclude=.git --exclude=.claude .
tar -czf dashboard1.tgz -C server\dashboard1 --exclude=node_modules --exclude=dist --exclude=logs --exclude=.env --exclude=tsconfig.tsbuildinfo .
tar -czf dashboard2.tgz -C server\dashboard2 --exclude=node_modules --exclude=dist --exclude=logs --exclude=.env --exclude=tsconfig.tsbuildinfo .
scp gateway.tgz dashboard1.tgz dashboard2.tgz student@192.168.1.11:~/
```

### Шаг 1б. Только если на сервере нет образа nginx

**[ПК]**

```powershell
docker save nginx:alpine -o nginx-alpine.tar
scp nginx-alpine.tar student@192.168.1.11:~/
```

**[СЕРВЕР]**

```bash
docker load -i ~/nginx-alpine.tar
```

---

## Шаг 2. Сеть и дашборды

**[СЕРВЕР]**

```bash
docker network create tmvos
```

Обновить дашборды на месте (файлы распаковываются поверх старых, `logs/` не
затрагивается):

```bash
tar -xzf ~/dashboard1.tgz -C <DASH1>
cd <DASH1> && docker compose up -d --build

tar -xzf ~/dashboard2.tgz -C <DASH2>
cd <DASH2> && docker compose up -d --build
```

Проверка — старые адреса должны работать как раньше:

```bash
curl -s localhost:5173/api/health; echo
curl -s localhost:5174/api/health; echo
```

> Если сборка не удалась — старый контейнер продолжит работать (compose заменяет
> его только после успешной сборки). Пришлите вывод ошибки.

Климатику к сети подключаем **без пересборки и без остановки**:

```bash
docker network connect --alias climatica tmvos climatica-web-backend-1
```

(имя контейнера — из шага 0).

---

## Шаг 3. Шлюз

**[СЕРВЕР]**

```bash
mkdir -p ~/tmvos/gateway
tar -xzf ~/gateway.tgz -C ~/tmvos/gateway
cd ~/tmvos/gateway
cp .env.example .env
```

Временная карточка климатики (ведёт на старый порт 8000):

```bash
cp portal/apps.json portal/apps.new-climatica.json
cp portal/apps.old-climatica.json portal/apps.json
```

Если порт 80 занят или образ nginx называется иначе — поправить `.env` (`nano .env`).
Запуск:

```bash
docker compose up -d
docker compose ps
```

---

## Шаг 4. Проверка

**[СЕРВЕР]**

```bash
curl -s -o /dev/null -w '%{http_code}\n' localhost/
curl -s -o /dev/null -w '%{http_code}\n' localhost/press/
curl -s -o /dev/null -w '%{http_code}\n' localhost/bend/
curl -s localhost/portal-api/status; echo
```

Ожидается `200 200 200` и JSON с тремя приложениями.

**[ПК]** открыть в браузере `http://192.168.1.11/`:

- три карточки, статусы обновляются;
- «Стенд на пресс» → открывается `/press/`, панель подключается к стенду,
  «Занять управление» работает;
- то же для `/bend/`;
- «Климатика» → открывается старая климатика на `:8000`.

Адрес стенда в шапке каждой панели после обновления проверьте один раз (ключ
хранения изменился, см. README).

---

## Шаг 5. Имя tmvos.panel

**[ПК]** на каждом компьютере, с которого открывают панель. Блокнот **от имени
администратора** → файл `C:\Windows\System32\drivers\etc\hosts` → добавить строку:

```
192.168.1.11  tmvos.panel
```

После этого работает `http://tmvos.panel/`.

---

## Если что-то пошло не так

Шлюз ничего не ломает в старой схеме — порты 5173 / 5174 / 8000 работают независимо
от него. Убрать шлюз целиком:

```bash
cd ~/tmvos/gateway && docker compose down
```

Диагностика:

```bash
docker compose logs --tail 50 nginx
docker compose logs --tail 50 portal
docker network inspect tmvos --format '{{range .Containers}}{{.Name}} {{end}}'
```

В последней команде должны быть: `tmvos-nginx tmvos-portal dashboard1 dashboard2`
и контейнер климатики. Заглушка «панель недоступна» по какому-то адресу почти
всегда означает, что контейнера нет в этом списке.

---

## Позже: переход климатики на новую версию (/climatica/)

1. **[ПК]** упаковать и отправить:

   ```powershell
   cd C:\Users\karta\Documents
   tar -czf climatica.tgz -C climatica-web --exclude=.git --exclude=.claude --exclude=logs --exclude=.env --exclude=__pycache__ --exclude=.pytest_cache .
   scp climatica.tgz student@192.168.1.11:~/
   ```

2. **[СЕРВЕР]** сначала резервная копия базы, затем обновление на месте
   (`<CLIM>` — папка проекта, узнаётся как в шаге 0 по контейнеру backend):

   ```bash
   cd <CLIM>
   docker compose exec db pg_dump -U climatica climatica > ~/climatica-backup-$(date +%F).sql
   tar -xzf ~/climatica.tgz -C <CLIM>
   docker compose up -d --build
   ```

   База лежит в томе `climatica_pgdata` и при пересборке сохраняется; `.env` с
   токеном бота на сервере не перезаписывается (исключён из архива).

3. **[СЕРВЕР]** вернуть полноценную карточку (с температурой, ссылка на `/climatica/`):

   ```bash
   cd ~/tmvos/gateway
   cp portal/apps.new-climatica.json portal/apps.json
   ```

   Перезапуск не нужен — карточка обновится через несколько секунд.
