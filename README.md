# Шлюз TMVOS

Единая точка входа для всех панелей на сервере `192.168.1.11` (`http://tmvos.panel`).

```
Браузер ──► :80  tmvos-nginx ─┬─ /              стартовая страница (portal/public)
                              ├─ /portal-api/   tmvos-portal  (статусы для карточек)
                              ├─ /press/     ─► dashboard1:80     (проект server/dashboard1)
                              ├─ /bend/      ─► dashboard2:80     (проект server/dashboard2)
                              └─ /climatica/ ─► climatica:8000    (проект climatica-web)
                   все в docker-сети "tmvos"
```

**Главный принцип:** каждое приложение — отдельный compose-проект в своей папке. Шлюз
ничего не знает о том, как они собраны, — только имя контейнера в сети `tmvos`.
Поэтому:

- обновление / пересборка / остановка одной панели не трогает остальные и шлюз
  (на время перезапуска по её адресу будет страница «панель недоступна», которая
  сама обновится);
- nginx стартует, даже если какая-то панель не запущена или ещё не создана;
- старые порты (5173, 5174, 8000) продолжают работать — можно закрыть их позже.

## Структура

```
docker-compose.yml        nginx + portal
.env.example              порт и имена образов
reload-nginx.sh           проверить и применить конфиг nginx без остановки
nginx/conf.d/default.conf общие настройки (WebSocket, SSE, заглушка 502)
nginx/apps/*.conf         ПО ОДНОМУ ФАЙЛУ НА ПАНЕЛЬ — маршрут /имя/ -> контейнер
nginx/apps/_template.conf.example  шаблон для новой панели
portal/apps.json          список карточек стартовой страницы и что опрашивать
portal/server.mjs         сервис статусов (Node без зависимостей)
portal/public/            стартовая страница и заглушка _down.html
```

## Первое развёртывание на сервере

Раскладка папок на сервере (пример; главное — чтобы каждая панель была в своей папке):

```
~/tmvos/gateway/        <- содержимое этой папки (mainpage)
~/tmvos/dashboard1/
~/tmvos/dashboard2/
~/tmvos/climatica-web/
```

1. Скопировать обновлённые папки на сервер (с Windows):

   ```bash
   scp -r C:/Users/karta/Documents/mainpage student@192.168.1.11:~/tmvos/gateway
   ```

   (так же — `dashboard1`, `dashboard2`, `climatica-web`, если они ещё не там;
   если они уже лежат на сервере в другом месте, скопируйте только изменённые файлы,
   см. «Что изменено в приложениях» ниже).

2. Один раз создать общую сеть:

   ```bash
   docker network create tmvos
   ```

3. Пересоздать приложения (они подключатся к сети `tmvos`):

   ```bash
   cd ~/tmvos/dashboard1 && docker compose up -d --build
   cd ~/tmvos/dashboard2 && docker compose up -d --build
   cd ~/tmvos/climatica-web && docker compose up -d --build
   ```

4. Запустить шлюз:

   ```bash
   cd ~/tmvos/gateway
   cp .env.example .env      # проверить имена образов: docker images
   docker compose up -d
   ```

   Если на сервере нет доступа к Docker Hub, в `.env` должны стоять уже загруженные
   образы nginx и node (на сервере уже есть `node:24-alpine` — на нём собраны
   дашборды). Загрузить образ из файла: `docker load -i nginx.tar`.

5. Открыть `http://192.168.1.11/`. На клиентских ПК добавить в
   `C:\Windows\System32\drivers\etc\hosts` строку:

   ```
   192.168.1.11  tmvos.panel
   ```

   Сервис статусов опрашивает стенды **с сервера**. Проверить, что сервер их видит:
   `curl http://192.168.3.53/v1/health` (на сервере). Если нет — стенды будут
   показаны «Выключен», хотя из браузера панели работают.

## Обновление приложения

Шлюз при этом не трогается. Пример для климатики:

```bash
cd ~/tmvos/climatica-web
# заменить файлы новой версией (git pull / scp)
docker compose up -d --build
```

Для дашбордов то же самое в их папках. Журналы (`logs/`) и база климатики лежат в
томах и переживают пересборку.

**Требование к новой версии любого приложения — все пути во фронтенде относительные**:
`api/...`, `vendor/...`, `assets/...` — без ведущего `/`. Приложение открывается по
адресу `/climatica/`, и запрос на `/api/...` уйдёт мимо него, на стартовую страницу.
WebSocket строится от каталога страницы (см. `connectWebSocket()` в
`climatica-web/app/static/index.html`). Для Vite-проектов достаточно `base: "./"`.
Бэкенд переделывать не нужно: nginx отрезает префикс, приложение видит запросы
как раньше, от корня.

Если имя контейнера или внутренний порт приложения изменились — поправить
`nginx/apps/<имя>.conf` и выполнить `./reload-nginx.sh`.

## Добавление новой панели

1. В `docker-compose.yml` новой панели: задать `container_name` (или алиас) и
   подключить к сети `tmvos` — как в `server/dashboard1/docker-compose.yml`:

   ```yaml
   services:
     myapp:
       container_name: myapp
       # ports можно не публиковать - доступ будет через шлюз
       networks: [tmvos]
   networks:
     tmvos:
       external: true
   ```

   Фронтенд — только с относительными путями (см. выше). `docker compose up -d --build`.

2. Маршрут: `cp nginx/apps/_template.conf.example nginx/apps/myapp.conf`, заменить
   `NAME`, `CONTAINER`, `PORT`, затем `./reload-nginx.sh`. При ошибке в конфиге
   nginx откажется применять его и продолжит работать со старым.

3. Карточка: добавить объект в `portal/apps.json`. Перезапуск не нужен —
   файл перечитывается каждые несколько секунд. Если в JSON ошибка, на странице
   появится предупреждение, а карточки останутся по последней рабочей версии.

   ```json
   {
     "id": "myapp",
     "title": "Новый стенд",
     "subtitle": "Короткое описание",
     "path": "/myapp/",
     "status": { "type": "http", "url": "http://myapp/health" }
   }
   ```

   Типы проверок (`portal/server.mjs`, объект `checks`):

   | type        | поля              | что показывает |
   |-------------|-------------------|----------------|
   | `http`      | `url`             | ответил 2xx — «Включен», иначе «Выключен» |
   | `stand`     | `device`, `panel` | стенд ESP32 вкл/выкл + предупреждение, если контейнер панели не запущен |
   | `climatica` | `url`             | вкл/выкл + температура по каждой камере |

   Без `status` карточка — просто ссылка. Чтобы вывести на карточке больше данных
   (например, силу или число циклов стенда), добавьте свою функцию в `checks` и
   верните из неё `details: [{ label, value, state }]` — страница нарисует их сама.
   После правки `server.mjs`: `docker compose restart portal`.

## Что изменено в приложениях

- **dashboard1 / dashboard2** — `docker-compose.yml`: подключение к сети `tmvos`.
  `src/config.ts`: ключ адреса стенда в `localStorage` стал `press.stand_host` /
  `bend.stand_host`. Раньше панели были на разных портах (разные «сайты» для
  браузера), теперь на одном адресе и делят `localStorage`: с общим ключом
  `stand_host` адрес, введённый на `/bend`, подменял бы адрес на `/press`.
  После обновления адрес стенда в шапке панели нужно один раз ввести заново,
  если он отличается от встроенного по умолчанию. Тема и имя оператора теперь общие
  для всех панелей и стартовой страницы (так и задумано).
- **climatica-web** — `docker-compose.yml`: сеть `tmvos` с алиасом `climatica`.
  `app/static/index.html`: относительные пути. `app/services/poller.py`: в
  `/api/health` добавлена текущая температура каждой камеры (её показывает
  стартовая страница). Тесты проходят (38 passed).

## Полезные команды

```bash
docker compose ps                      # состояние шлюза
docker compose logs -f nginx           # логи nginx
docker compose logs -f portal          # логи опроса статусов
curl -s localhost/portal-api/status    # сводка статусов (JSON)
docker network inspect tmvos           # кто подключён к сети шлюза
```
