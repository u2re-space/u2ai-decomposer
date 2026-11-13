# План перехода: Universal-AI (монолит 0.2.xx) → @u2ai/decomposer (0.3.xx)

> Актуальный статус: **шаги 1–6 завершены**, следующий — шаг 7 (стадия decompose).
> Рабочий дом переносимого кода: `submodules/u2ai-decomposer/`.

---

## 0. Цели и рамки

**Цель:** выделить пайплайн декомпозиции изображения из монолитного CLI `ai`
(`@u2ai/universal-ai`) в самостоятельный CLI `ai-decompose` (`@u2ai/decomposer`),
сохранив поведение фаз, записанных в `archive/reference-phases/`.

**Рамки нового пакета:**

| Параметр | Значение |
|---|---|
| Имя пакета | `@u2ai/decomposer` |
| Бинарь | `ai-decompose` (`bin/ai-decompose.{js,cmd,ps1,sh}`) |
| Версия | 0.3.xx (монолит остаётся на 0.2.xx и угасает по шагу 14) |
| Конфиг | `~/.ai-decompose/config.json` (оверрайд `AI_DECOMPOSE_HOME`) |
| Префикс env | `AI_DECOMPOSE_*` (совместимость с `OPENAI_*`, `AI_MODEL`, `AI_IMAGE_MODEL`) |
| Runtime | Node.js >= 26, ESM, без SDK (чистый fetch) |
| Зависимости | `sharp`, `canvas`, `@resvg/resvg-js`, `@modelcontextprotocol/*` |

**Pipeline (6 стадий, порядок фиксирован):**

```
original.png
   │
   ├─ 0 extend      → ./decomposition/extended/     (доращивание кадра, seam-stitch)
   ├─ 1 decompose   → ./decomposition/screens/      (crop to screens, суб-референсы)
   ├─ 2 rectify     → ./decomposition/rectified/    (un-rotate / recover projection)
   ├─ 3 reconstruct → ./decomposition/restored/     (box-patch утраченных деталей)
   ├─ 4 overlap     → ./decomposition/overlap/      (вычитание чужих областей между экранами)
   └─ 5 resolve     → ./decomposition.json (+ layers/)  (финальная сборка + layer split)
```

**Роли:** `extender`, `decomposer`, `rectifier`, `restorer`, `overlap`, `director`
(+ `default` для общих вызовов). Разрешение модели/effort:
роль → `roles.default` → верхний уровень конфига.

---

## 1. Каркас пакета + зависимости — ✅ ЗАВЕРШЁН

Что сделано:

- [x] `package.json`: `@u2ai/decomposer`, `bin: ai-decompose`, `engines: node>=26`,
      deps перенесены из монолита (`sharp`, `canvas`, `@resvg/resvg-js`,
      `@modelcontextprotocol/node`, `@modelcontextprotocol/server`).
- [x] `index.js` (публичный API) + `src/index.js` (barrel-ре-экспорт всех модулей).
- [x] `src/cli.js`: `parseArgv` (node:util parseArgs) — флаги `-i/--image`,
      `-o/--out`, `--stages`, `-c/--config`, `-m/--model`, `--effort`,
      `--image-model`, `-v/--verbose`, `--dry-run`, `--advanced`,
      `--stop-after`, `--help`, `--version`; `main()` с маппингом ошибок в exit-коды.
- [x] `src/help.js`: справка по стадиям и командам.
- [x] `bin/ai-decompose.{js,cmd,ps1,sh}` — entry-обёртки для Windows/POSIX.
- [x] Скелеты каталогов: `src/openai/`, `src/image/`, `src/roles/`, `src/agent/`,
      `src/stages/`, `src/shared/`, `src/cli/`, `src/model/`, `test/`, `examples/`.
- [x] Все файлы проходят `node --check`; `--help`/`--version`/`--dry-run` → exit 0.

---

## 2. Система конфигурации в `src/config/*.js` — ✅ ЗАВЕРШЕНА

Модули (каждый — отдельный файл каталога, `src/config.js` = ре-экспорт):

- [x] `constants.js` — `ENUMS` (reasoningEfforts, contextLevels, stages,
      decomposerModes, rasterEngines, image-formats), `ENV_PREFIX`,
      `SUPPORT_ALIASES`, `HEADER_NAME`, `BUILTIN_ROLE_NAMES`, KiB/MiB.
- [x] `defaults.js` — дефолты домена: `model`/`imageModel`/`baseURL` из монолита
      (`moonshotai/kimi-k3.1-pro`, `openai/gpt-image-2.6-sunburst`, routerai),
      `backends`/`imagesBackends` с полем `env` (ROUTERAI/PROXYAPI/SPRUTDOCK/GPTUNNEL),
      `limits`, `tools`, `raster`, `image.*` (seamDeltaMin, residualSkewLimitDeg,
      alphaThreshold…), `stages.*` по всем 6 стадиям, `roles.*` + `ROLE_FIELDS`,
      `defaultConfigText()` (стартовый файл).
- [x] `env.js` — `fromEnv()`: `AI_DECOMPOSE_*` (MODEL, IMAGE_MODEL, EFFORT, RETRIES,
      TIMEOUT_MS, MAX_TURNS, BACKENDS, IMAGES_BACKENDS, RASTER_ENGINE, MAGICK_PATH,
      PAD_FRACTION, STAGE_<ID>=0|1, CONFIG, HOME) + совместимость `OPENAI_*`/`AI_*`.
- [x] `merge.js` — `deepMerge`, `isRecord`, `getPath`, `setPath`.
- [x] `parser.js` — `readConfigFile` (BOM, ≤256 KiB, строгий JSON, отсев неизвестных
      разделов), `writeConfigFile`, `{{env:NAME}}`/`{{file:path}}`/`{{fs:path}}`
      (отсутствующая переменная → пустая строка, как в монолите).
- [x] `paths.js` — `defaultHome()` = `AI_DECOMPOSE_HOME` или `~/.ai-decompose`.
- [x] `validate.js` — `validateConfig()`: enums, backends (URL/headers/supports),
      limits, стадии, роли; сообщения — с точным путём поля.
- [x] `index.js` — `loadConfig()`: defaults < config.json < --config < env < флаги
      → плейсхолдеры → primary-backend → валидация; `ensureConfigFile()`,
      `redactConfig()`.

Проверено: смоук-тест загрузчика (env-оверрайды, файл с ролями, отказ на
неизвестном разделе, редакт ключей, посев стартового файла) — зелёный.
Исправлены баги: провал `set()` вглубь дерева в `env.js`, потеря `error.code`
в `parser.js`. Стадии переведены со старого `config.agent.*` на `config.stages.*`.

---

## 3. ИИ-подсистема — ✅ ЗАВЕРШЕНА

Порт `src/openai/*` из монолита **без** team/loop/serve/channels:

- [x] `src/openai/http.js` — транспорт на `node:http(s)`: явный idle-таймаут
      (`config.timeoutMs`), connect-таймаут, чтение тела с потолком по байтам.
- [x] `src/openai/errors.js` — `ApiError` (статус, request id, retryAfter, apiCode,
      param, retryable), `isAbortError`.
- [x] `src/openai/sse.js` — разбор SSE: CRLF, комментарии, несколько `data:`,
      `[DONE]`, потолок события и потока.
- [x] `src/openai/stream.js` — `createStreamReducer` (text/reasoning/tool-события),
      `outputText`, `refusalText`, `normalizeUsage`.
- [x] `src/openai/client.js` — HTTP-клиент: Responses API как основной транспорт,
      Chat Completions как fallback; `images.generate` / `images.edit`;
      ротация бэкендов из `config.backends`/`imagesBackends`/`modelsBackends`
      (первичный + перебор при 4xx/5xx), ретраи с backoff, `timeoutMs`;
      `resolveBackends()`, `retryDelayMs()`.
- [x] `src/openai/responses.js` — сборка тела запроса (instructions, input,
      reasoning.effort/summary/mode, tools, schema → `text.format`), разбор ответа
      (`parseResponse`, `extractToolCalls`), помощники `imagePart`/`textPart`.
- [x] `src/openai/chat.js` (+ `completions.js` как ре-экспорт) — адаптер Chat
      Completions для хостов без Responses: `toChatBody`, `fromChatCompletion`,
      `responsesRouteUnsupported`, `stripRejectedFields`, `chatGaps`.
- [x] `src/openai/images.js` — размеры/формат/quality из `config.image`,
      multipart-тело (`encodeMultipart`), маска, разбор b64Json/url-ответов.
- [x] `src/openai/fallback.js` — цепочка `fallback.models` (`fallbackChain`,
      `fallbackModels`, `withModelFallback`) + ротация бэкендов.
- [x] `src/model/profiles.js` — `MODEL_PROFILES`: window/maxOutput/ceiling по
      каждому модельному семейству; `getModelProfile()`, `snapEffort()`,
      `contextBytes()` (слова small/normal/large/max → байты), `maxOutputFor()`.
- [x] Убрана из перенесённых файлов apimart/decompose-специфика монолита:
      `src/openai/apimart.js`, `src/openai/decompose.js` и `src/roles/vectorizer.js`
      удалены — их логика растворилась в client/fallback, а vectorize в декомпозере
      не нужен.
- [x] `src/roles/index.js` переписан под новый контракт клиента: `resolveRole()`
      (роль → `roles.default` → верх), `snapEffort` + потолок роли, разбор JSON по
      схеме, tool-цикл (вызовы модели → `toolset.execute` → ответы обратно в модель).

Проверено: `test/openai.test.js` (19 тестов) и `test/roles.test.js` (7 тестов) —
тело запроса, разбор ответа, multipart, ключи бэкендов из env, цепочка fallback,
профили моделей, клиент против локального mock-хоста (Responses, откат на Chat
Completions, ротация бэкендов, generate/edit → байты PNG).

Критерий готовности: `createClient({ config })` делает generate/edit по цепочке
ротации и возвращает байты PNG — закрыт (mock-хост + chain-ротация).

---

## 4. Image-слой — ✅ ЗАВЕРШЕН

Порт `src/shared/image-*` из монолита, fallback-цепочка sharp → canvas → ImageMagick:

- [x] `src/image/raster.js` — порт монолитного `src/shared/image-raster.js`:
      `rasterCrop`, `rasterPatch` (box-patch вставка), `decodeRgba(bytes, engine, maxSide)`,
      `encodeRgba`, `rasterScale`, `rasterInfo`, `rasterCompare`, `rasterTrim`, `rasterSplit`,
      `rasterPadImageBytes`, `rasterRemoveImagePadding`, `rasterFitToSourceFrame`,
      `rasterizeSvg` (ReSVG → sharp → canvas), альфа-маски. Движок выбирается по
      `config.raster.engine` (auto = probe sharp → canvas).
- [x] `src/image/canvas.js` — движок node-canvas (единственная точка загрузки нативного
      модуля, кэш на процесс); `src/image/magick.js` — порт `src/shared/image-magick.js`
      (`detectMagick`, `magickCrop`, `magickSplit`, `magickResize`, `magickConvert`,
      `magickIdentify`, `magickPadImageBytes`, `magickRemoveImagePadding`) на `execFile`
      **без shell**, `magickPath` из `config.raster.magickPath`.
- [x] `src/image/crop.js` — rect-кроп с clamp (`clampRect`, `cropRect`, `cropToBuffer`);
      `src/image/padding.js` — pad полосы (`padToSize`, `padBand`, `detectPadding`,
      `removePadding`).
- [x] `src/image/distort.js` — гомография без внешних программ: `solveHomography`
      (Гаусс с частичным выбором ведущего элемента), `quadToRect`, `solveQuadError`,
      `perspectiveRectify` — обратное отображение + билинейная выборка, одно
      пересемплирование, прозрачные пиксели вне квада.
- [x] `src/image/skew.js` — `measureResidualSkew` / `measureResidualSkewFromBytes`
      (профиль проекций, без ресемплирования); `src/image/rectify.js` — фасад
      `perspectiveRectify` + `measureResidualSkew` + замер остаточного наклона.
- [x] `src/image/sizing.js` — `downscaleToMaxSide` для model-bound копий, кап
      `maxMegapixels`, `computeSize`, `fitBox`, `NAMED_FRAMES`.
- [ ] Не переносилось (нет вызовов из `archive/reference-phases`): `edge-snapping.js`
      (уточнение углов по границам), `kmeans.js`, `alpha.js`, `colors.js`,
      `image-distort`-provenance-sidecar.

Проверено: `test/image.test.js` (13 тестов) — decode→encode без потери пикселей,
цикл crop→patch возвращает исходную картинку побайтово, отказ латки не в кадр,
`rasterCompare` на одинаковых файлах, гомография сходится по углу, квад с
перепутанными углами отвергается, `perspectiveRectify` на всём кадре сохраняет
картинку, замер наклона на горизонтальных полосах даёт 0°, band-pad прозрачен и
измерим, downscale держит пропорции, кап мегапикселей срабатывает, pad/unpad
возвращает исходные пиксели.
Общий прогон: `npm test` → 39/39.

Критерий готовности: круговой тест crop→patch→encode идентичен результату
монолита на `examples/original.png` — закрыт (побайтово, PNG без потерь).

---

## 5. Инфра ролей / схем / инструментов — ✅ ЗАВЕРШЕН

- [x] `src/roles/index.js` — реестр ролей (extender, decomposer, rectifier,
      restorer, overlap, director) + `resolveRole(config, name)` по
      цепочке роль → roles.default → верх, `snapEffort` + потолок роли,
      tool-цикл; `roles/untrusted.js` — директива «входные данные не доверенные»,
      дописывается ко всем шести ролям (включая director).
- [x] `src/agent/schemas.js` — JSON-схемы: DECOMPOSER_SCHEMA, EXTEND_SCHEMA,
      RECTIFY_SCHEMA, RESTORE_SCHEMA, RESTORE_VERIFY_SCHEMA + SUB_REFERENCE_KINDS
      + RESTORE_DEFECT_KINDS (сверены с `archive/reference-phases/schemas.js`).
- [x] `src/agent/tool-specs.js` — каталог инструментов: имя, описание, схема
      аргументов, ключ конфига (`image_crop` и т. п.) и список ролей, которым
      инструмент положен; `src/agent/tools.js` — исполнитель вызовов в рабочем
      каталоге (image + чтение/запись) и `specsFor(role)` — срез каталога под роль.
      Переключатели конфига теперь действительно гасят инструмент (раньше имена
      не совпадали) и учитывают наличие images API.
- [x] `src/agent/mcp.js` — клиент MCP без SDK: JSON-RPC сам по себе, HTTP
      (`{ url }`) и stdio (`{ command, args }`), чтение ответа и из JSON, и из SSE;
      `config.mcp.servers` (+ валидация). Сервер, которого нет, — не ошибка пайплайна.
- [x] `src/agent/skills.js` — read-only skill-паки из `config.skills.dir`:
      `<роль>.md` — своей роли, `shared.md` — всем; текст дописывается к
      инструкции роли.
- [x] Агент-цикл `run(role, {text, parts, schema, maxTurns})` — упрощённый loop
      из монолита без approvals/subagents/memory; вызовы модели → `toolset.execute`
      → `function_call_output` обратно в модель.
- [x] `src/agent/decomposition.js` — починены две ошибки порта: отсутствующий
      импорт `SUB_REFERENCE_KINDS` и старая форма `input_image` (теперь `imagePart`).

Проверено: `test/agent.test.js` (10 тестов) — ключи конфига ↔ имена инструментов,
срез каталога по роли, гейт images API, исполнитель tool-вызова, разбор ответа MCP
(JSON и SSE), имена инструментов MCP без коллизий, недоступный сервер как не
ошибка, skill-паки по ролям, дописывание пака к инструкции, вызов роли
decomposer на mock-клиенте с валидным DECOMPOSER_SCHEMA и tool-trace.
Общий прогон: `npm test` → 49/49.

Критерий готовности: вызов роли decomposer на mock-клиенте возвращает
валидный DECOMPOSER_SCHEMA-объект с tool-trace — закрыт.

---

## 6. Стадия extension (port `archive/reference-phases/extend.js`) — ✅ ЗАВЕРШЕН

- [x] Локальный pad канвы: `stages.extend.padFraction` от длинной стороны → полоса;
      исходные пиксели остаются в левом верхнем углу без ресемплирования.
- [x] Роль `extender` пишет prompt продолжения полосы (EXTEND_SCHEMA).
- [x] Приём по шву: генерация → `seamDelta` против `image.seamDeltaMin`,
      до `stages.extend.maxAttempts` попыток; порог объединяет цветовой drift
      и долю изменённых seam-пикселей.
- [x] Band-stitch через `rasterPatch`: перекрывающийся шов, alpha-feather;
      исходная область берётся из исходного файла, из ответа — только полоса.
- [x] Артефакты → `./decomposition/extended/`, состояние `state.canvas`.

Проверено: `test/extension.test.js` — расчёт целевого холста, seam-метрика,
успешный band-stitch с сохранением исходных пикселей, отказ при сдвинутом шве,
повтор до `maxAttempts`, отсутствие артефакта у отклонённого ответа.
Дополнительно: `test/cli.test.js` — dry-run печатает план, не создаёт каталоги
и не вызывает клиент. Общий прогон: `npm test` → 55/55.

Критерий готовности: роль `extender` даёт план, локально выросший холст
проходит seam-проверку, а итоговый файл сохраняет исходные пиксели — закрыт.

---

## 7. Стадия decompose (порт `roles/decomposer.js` + `decomposition.js`) — ⏳

- [ ] Режимы `agent` (инструменты view/crop/split) и `inline` ( rects в JSON-ответе).
- [ ] Роль называет экраны и кроит суб-референсы → `./decomposition/screens/`.
- [ ] Caps: `maxSubReferences`, `maxRects`, `maxInlinePixels`, `minScreenSide`.
- [ ] Запись decomposition-объекта в `state`.

---

## 8. Стадия rectify (port `archive/reference-phases/rectify.js`) — ⏳

- [ ] Un-rotate / recover projection: quad от роли → `perspectiveRectify`
      (magick и/или AI-редактор).
- [ ] Верификация `measureResidualSkew` ≤ `residualSkewLimitDeg`, цикл
      re-correct при превышении.
- [ ] Резка коллажа на экраны (split pass, `maxSplitTurns`).
- [ ] Артефакты → `./decomposition/rectified/`.

---

## 9. Стадия reconstruct (port `archive/restore.js` + `restore-plan.js`) — ⏳

- [ ] План утраченных деталей (restore-plan): box'ы из сравнения rectified ↔ screens.
- [ ] Box-patch через AI-редактор (`image_edit` с маской), `boxPadding`,
      `maxAttempts` на деталь.
- [ ] Verify-проход (RESTORE_VERIFY_SCHEMA) — принять/отклонить патч.
- [ ] Артефакты → `./decomposition/restored/`.

---

## 10. Стадия overlap (новая, через AI-процесс) — ⏳

- [ ] Попарное сравнение экранов (`image_compare`) — поиск элементов,
      принадлежащих чужому экрану (перкрытия, наложения, «приведённые» куски).
- [ ] Решение роли `overlap` → erase-list → вычитание областей через
      `image_edit`/mask, `maxAttempts` на элемент.
- [ ] Артефакты → `./decomposition/overlap/`.

---

## 11. Стадия resolve (финальная) — ⏳

- [ ] Сборка resolved JSON: все пути/скидки разрешены в финальные артефакты
      (screens → rectified → restored → overlap) → `./decomposition.json`.
- [ ] `--advanced` / `stages.resolve.layers`: layer split (порт
      `src/agent/advanced.js`, seedream-5.5) → `./layers/` + поле `layers`.
- [ ] Валидация выхода: каждый screen имеет существующий файл.

---

## 12. Pipeline-оркестрация + CLI-обвязка — ⏳

- [ ] `src/shared/pipeline.js` — `runPipeline`: порядок 6 стадий, пропуск по
      `stages.<id>.enabled` и `--stages`, `--stop-after <stage>`, передача state,
      dry-run (план без вызовов API).
- [ ] `src/stages/index.js` — реестр стадий { id → module }.
- [ ] `src/cli/renderer.js` + `colors.js` — TTY-рендер событий стадий
      (start/attempt/artifact/warn/fail), exit-коды; `compatibility.js`.
- [ ] Артефакты строго в `./decomposition/{extended,screens,rectified,restored,overlap}/`
      + `decomposition.json`.
- [ ] `--dry-run` печатает план: стадии, модели, пути выхода.

---

## 13. Тесты / проверка — ⏳

- [ ] Порт `archive/reference-phases.test.js` (~536 строк) → `test/phases.test.js`
      с новыми путями импорта.
- [ ] Смоук-тесты конфигов закрепить как `test/config.test.js`
      (precedence, env, placeholders, validate, redact).
- [ ] `npm test` = `node --test --test-timeout=60000 "test/*.test.js"`.
- [ ] Прогон на `examples/original.png`: сравнение выходов с
      `examples/ai-extended.png`, `ai-rectified.png`, `screens/` (референсы
      монолита лежат в `examples/`).
- [ ] Границы: отсутствие ключей (понятная ошибка), битый конфиг, jpg/png,
      малые изображения (<minScreenSide).

---

## 14. Поэтапное затухание в монолите — ⏳

- [ ] Каждый портированный `src/*` монолита помечать header-тегом
      `@ai.hint legacy-0.2` по мере переноса (openai/*, image-утилиты,
      roles/decomposer, agent/advanced).
- [ ] Фазы `archive/reference-phases/{extend,rectify,restore}.js` остаются
      эталоном до зелёных тестов шага 13, затем — только archive.
- [ ] Обновить README монолита: `ai decompose` делегирует в `ai-decompose`.
- [ ] Обновить `archive/reference-phases/README.md`: ссылка на новый дом фаз
      (`submodules/u2ai-decomposer/src/stages/`).
- [ ] В 0.2.xx удалять перенесённое только после релиза соответствующих
      стадий в 0.3.xx.

---

## Порядок работы и зависимости шагов

```
1 каркас ──► 2 конфиг ──► 3 openai ──► 4 image ──► 5 роли/схемы/тулзы
                                             │
                     ┌───────────────────────┼───────────────────────┐
                     ▼                       ▼                       ▼
              6 extend            7 decompose            (оба нужны для)
                     └───────────┬───────────┘
                                 ▼
                    8 rectify ──► 9 reconstruct ──► 10 overlap ──► 11 resolve
                                                                        
12 pipeline-обвязка (параллельно со 6–11, финализируется после 11)      
13 тесты (после 12)  ──► 14 затухание монолита (после релиза 0.3.x)     
```

## Риски и заметки

- **raster.js (~1314 строк)** — самый большой перенос; портировать по движкам,
  каждый шаг фиксировать тестом кругового преобразования.
- **Тесты reference-phases** завязаны на живые ключи гейтвеев — оставить
  «network»-тесты за флагом, по умолчанию mock-клиент.
- **overlap** — единственная принципиально новая стадия: схема решений и
  критерий приёмки erase'а проектируются с нуля, референс — поведение
  decomposer+compare из монолита.
- Файлы `src/config/*.js` могут быть открыты в редакторе — после изменений на
  диске делать reload, чтобы не затереть актуальное содержимое.
