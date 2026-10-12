// ── Сервис статусов стартовой страницы TMVOS ─────────────────────────────────
// Раз в pollIntervalSec секунд опрашивает всё, что перечислено в apps.json, и
// держит сводку в памяти. Страница забирает её через GET /portal-api/status.
//
// Опрос идёт с сервера, а не из браузера: так стенды не получают по запросу от
// каждой открытой вкладки, нет проблем с CORS, а адреса стендов задаются в
// одном месте.
//
// apps.json перечитывается на каждом цикле - новая карточка появляется без
// перезапуска. Если файл сломан, работает последняя удачная версия.
//
// Без npm-зависимостей: только стандартная библиотека Node (>= 18).

import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const PORT = Number(process.env.PORT) || 8080;
const CONFIG = path.resolve(process.env.APPS_CONFIG || "apps.json");
const TIMEOUT_MS = 2500;

// ── Проверки ─────────────────────────────────────────────────────────────────
// Каждая проверка получает блок "status" из apps.json и возвращает:
//   state    - "on" | "off" | "unknown" (цвет индикатора)
//   text     - подпись состояния ("Включен", "Выключен", ...)
//   details  - необязательные строки [{ label, value, state }]
//   warning  - необязательное предупреждение (например, панель не запущена)
// Новый вид устройства = новая функция здесь + "type" в apps.json.

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    return null; // ответ есть, но не JSON - для проверки "жив/не жив" этого достаточно
  }
}

async function reachable(url) {
  if (!url) return null;
  try {
    await getJson(url);
    return true;
  } catch {
    return false;
  }
}

const checks = {
  /** Любой HTTP-адрес: ответил 2xx - включен. */
  async http(cfg) {
    const ok = await reachable(cfg.url);
    return { state: ok ? "on" : "off", text: ok ? "Включен" : "Выключен" };
  },

  /** Стенд на ESP32 (press, bend): device - сам стенд, panel - контейнер панели. */
  async stand(cfg) {
    const [device, panel] = await Promise.all([reachable(cfg.device), reachable(cfg.panel)]);
    return {
      state: device ? "on" : "off",
      text: device ? "Включен" : "Выключен",
      warning: panel === false ? "Веб-панель не запущена" : null,
    };
  },

  /** Климатика: /api/health backend'а со списком камер и их температурой. */
  async climatica(cfg) {
    let health;
    try {
      health = await getJson(cfg.url);
    } catch {
      return { state: "off", text: "Выключен", warning: "Сервис климатики не отвечает" };
    }
    const chambers = Array.isArray(health?.chambers) ? health.chambers : [];
    const details = chambers.map((c) => {
      const online = c.online === true;
      const t = typeof c.temperature === "number" ? `${c.temperature.toFixed(1).replace(".", ",")} °C` : "—";
      return {
        label: `Камера ${c.chamber_id}`,
        value: online ? t : c.online === null ? "опрос…" : "нет связи",
        state: online ? "on" : c.online === null ? "unknown" : "off",
      };
    });
    const anyOn = chambers.some((c) => c.online === true);
    return {
      state: anyOn ? "on" : "off",
      text: anyOn ? "Включен" : "Выключен",
      details,
    };
  },
};

// ── Конфигурация ─────────────────────────────────────────────────────────────
let config = { pollIntervalSec: 5, apps: [] };
let configError = null;

async function loadConfig() {
  try {
    const raw = JSON.parse(await readFile(CONFIG, "utf8"));
    if (!raw || !Array.isArray(raw.apps)) throw new Error('нет массива "apps"');
    if (configError) console.log("[portal] apps.json снова в порядке");
    config = raw;
    configError = null;
  } catch (e) {
    const msg = `apps.json: ${e.message}`;
    if (msg !== configError) console.error(`[portal] ${msg} - использую предыдущую версию`);
    configError = msg;
  }
}

// ── Опрос ────────────────────────────────────────────────────────────────────
/** id приложения -> последний результат проверки */
const results = new Map();

async function checkApp(app) {
  const st = app.status;
  const fn = st && checks[st.type];
  if (!st) return { state: "none", text: "" };
  if (!fn) return { state: "unknown", text: "Неизвестный тип проверки", warning: `type: ${st.type}` };
  try {
    return await fn(st);
  } catch (e) {
    return { state: "unknown", text: "Ошибка проверки", warning: e.message };
  }
}

async function pollOnce() {
  await loadConfig();
  const apps = config.apps.filter((a) => a && a.id);
  await Promise.all(
    apps.map(async (a) => {
      const r = await checkApp(a);
      results.set(a.id, { ...r, checkedAt: Date.now() });
    }),
  );
  // Забыть результаты удалённых из apps.json приложений.
  const ids = new Set(apps.map((a) => a.id));
  for (const id of results.keys()) if (!ids.has(id)) results.delete(id);
}

async function loop() {
  try {
    await pollOnce();
  } catch (e) {
    console.error("[portal] ошибка цикла опроса:", e);
  }
  const sec = Number(config.pollIntervalSec);
  setTimeout(loop, (Number.isFinite(sec) && sec >= 1 ? sec : 5) * 1000);
}

function snapshot() {
  return {
    generatedAt: Date.now(),
    configError,
    apps: config.apps
      .filter((a) => a && a.id)
      .map((a) => ({
        id: a.id,
        title: a.title ?? a.id,
        subtitle: a.subtitle ?? "",
        path: a.path ?? `/${a.id}/`,
        ...(results.get(a.id) ?? { state: "unknown", text: "Проверка…" }),
      })),
  };
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
function sendJson(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url ?? "/", "http://local");
  if (req.method === "GET" && pathname === "/portal-api/status") return sendJson(res, 200, snapshot());
  if (req.method === "GET" && pathname === "/portal-api/health") return sendJson(res, 200, { ok: true });
  sendJson(res, 404, { ok: false, error: "not_found" });
});

server.listen(PORT, () => {
  console.log(`[portal] http://0.0.0.0:${PORT}  config=${CONFIG}`);
  loop();
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
