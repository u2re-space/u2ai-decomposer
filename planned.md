# План перехода: Universal-AI (монолит 0.2.xx) → @u2ai/decomposer (0.3.xx)

> Актуальный статус: **шаги 1–31 завершены** — переход сделан; дальше релиз 0.3.xx
> и затухание монолита по факту релиза.
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

## 7. Стадия decompose (порт `roles/decomposer.js` + `decomposition.js`) — ✅ ЗАВЕРШЕН

Два режима, один результат: экраны, файлы, на которые они указывают, и объект
декомпозиции.

**Режим `agent`** (по умолчанию): роль `decomposer` сама кроит экраны
инструментами (`view_image`, `crop_image`, `split_image`, `compare_images`,
`correct_perspective`, при наличии images API — `generate_image`/`edit_image`)
и пишет их в `./decomposition/screens/`.

**Режим `inline`**: роль не пишет ничего — она возвращает прямоугольник
каждого экрана (`x`, `y`, `width`, `height` в пикселях картинки, которую видела
модель), а harness сам режет пиксели. Экран в файле — это экран в исходнике,
байт в байт; координаты переводятся из масштаба model-bound копии в пиксели
исходника.

- [x] Режимы `agent` (инструменты view/crop/split) и `inline` (rects в JSON-ответе):
      `stages.decompose.mode` ∈ {`agent`, `inline`}, роль получает разные списки
      инструментов (`AGENT_TOOLS` / `INLINE_TOOLS`); схема ответа — `DECOMPOSER_SCHEMA`
      либо `DECOMPOSER_INLINE_SCHEMA`.
- [x] Роль называет экраны и кроит суб-референсы → `./decomposition/screens/`;
      пути в ответе и в состоянии — POSIX-relative от корня проекта.
- [x] Caps: `maxSubReferences` (агент), `maxRects`, `maxInlinePixels`,
      `minScreenSide` (inline); `stages.decompose.maxTurns` (по умолчанию 32)
      ограничивает агентный tool-цикл.
- [x] Запись decomposition-объекта в `state` (`state.decomposition`,
      `state.screens`, `state.screensFiles`, `state.images`) и в
      `<workDir>/decompose.json`.
- [x] Песочница инструментов: `src/agent/paths.js` (`resolveInside`, `isInside`,
      `toPosix`) — чтение и запись только внутри рабочего каталога, запись — только
      в каталоги, открытые стадией (`toolset.setWriteDirs([<workDir>/screens])`);
      `crop_image` обрезает рамку по пикселям кадра.
- [x] `src/stages/decompose-screens.js` — планировщик прямоугольников
      (`planScreens`) и резка (`cropScreens`), имя файла — порядок + slug.

Проверено: `test/decompose.test.js` (18 тестов) — инструменты агентного режима и
запрет инструментов записи в inline, сбор написанного файла, отказ пути вне
рабочего каталога, кап числа суб-референсов, запрет записи вне открытого каталога,
clamp рамки кропа, соответствие `minScreenSide`/`maxRects`/`maxInlinePixels`,
перевод координат из картинки модели в исходник, резка inline-экрана с
побайтовой сверкой пикселей, запись `decompose.json`, пустой state при ошибке
роли, `maxTurns` и оба режима в валидаторе конфига.
Общий прогон: `npm test` → 75/75.

Критерий готовности: роль `decomposer` отдаёт декомпозицию, а каждый экран
указывает на существующий файл в `./decomposition/screens/` — закрыт.

---

## 8. Стадия rectify (port `archive/reference-phases/rectify.js`) — ✅ ЗАВЕРШЕН

Роль не отвечает на вопрос «ровная ли картинка»: она ставит углы, детерминированная
проекция работает по ним, а результат судит измеримый остаточный наклон.

- [x] Un-rotate / recover projection: роль `rectifier` получает инструменты
      `view_image`, `correct_perspective`, `compare_images` (только геометрия — ни
      `crop_image`, ни генерации) и пишет результат в `./decomposition/rectified/`.
- [x] Верификация `measureResidualSkew` ≤ `stages.rectify.residualSkewLimitDeg`
      (0.8°), иначе результат не считается улучшением
      (`stages.rectify.minImprovementDeg`, 0.4°) и файл удаляется.
- [x] Цикл re-correct: если наклон не уменьшился, роль спрашивается ещё раз, а в
      тексте задачи стоит измеренный остаток; попыток — `stages.rectify.maxAttempts`.
- [x] Split-pass: если роль не дала ни одного файла (`unresolved`), идёт второй
      проход с бюджетом `stages.rectify.maxSplitTurns` и заданием «порезать
      картинку на экраны по одному».
- [x] Коллаж: один quad → один экран; один исходник может дать несколько экранов,
      тогда он распадается на несколько экранов в `state.screens`.
- [x] Артефакты → `./decomposition/rectified/`; принятые файлы заменяют исходник в
      `state.screens`, `state.screensFiles` и `state.images` (пути — POSIX-relative),
      отвергнутые не остаются на диске.

Проверено: `test/rectify.test.js` (14 тестов) — правило приёмки по наклону,
инструменты роли и каталог выхода, ровный кадр остаётся на месте, исправленный файл
заменяет исходник, файл вне каталога выхода не результат, файл без улучшения
удаляется, re-correct и split-pass (бюджет и текст второй попытки), коллаж
распадается на два экрана, разбор ответа роли, проверка файла результата,
`swapReferencePaths`, пороги наклона в конфиге.
Общий прогон: `npm test` → 89/89.

Критерий готовности: экран, спроецированный по углам, принимается только когда
измеримый остаточный наклон меньше исходного — закрыт.

---

## 9. Стадия reconstruct (port `archive/restore.js` + `restore-plan.js`) — ✅ ЗАВЕРШЕН

Правка — это вырезанный кусок, а не правка экрана целиком: модель получает только
рамку, а ответ вклеивается ровно в неё; всё остальное копируется из нетронутого
исходника.

- [x] План утраченных деталей: `src/stages/restore-plan.js` — роль `restorer`
      называет дефект (kind, box, текст правки), а harness отбирает только
      точечные правки этого кадра: `pickPatches` (свой вид дефекта, координаты
      внутри кадра, покрытие ≤ 45 %, непустая инструкция, без пересечений,
      не больше `stages.reconstruct.maxPatches` регионов).
- [x] Box-patch: `planFragment` расширяет рамку на `stages.reconstruct.boxPadding`
      и до минимальной стороны 64 px, `rasterCrop` вырезает фрагмент, images API
      редактирует его (`editorPrompt` + контракт `EDITOR_FRAME`), `rasterPatch`
      вклеивает ответ обратно в ту же рамку; попыток на деталь —
      `stages.reconstruct.maxAttempts`.
- [x] Verify-проход (RESTORE_VERIFY_SCHEMA, роль `restorerVerify`): «better» —
      файл принимается, иначе он удаляется и остаётся исходный экран.
- [x] Артефакты → `./decomposition/restored/`; принятые файлы заменяют исходник в
      `state.screens`, `state.screensFiles` и `state.images` (kind → `repaired`).

Проверено: `test/reconstruct.test.js` (10 тестов) — рост рамки до минимальной
стороны, отказ неприцельным правкам (чужой вид дефекта, выход за кадр, 90 % кадра,
короткая инструкция, пересечение), контракт фрагмента в промпте, роль видит экран
и исходник, чистый экран остаётся на месте, редактор получает только фрагмент и
ответ вклеивается в рамку (размеры экрана не меняются), отказ по верификации
удаляет файл, упавший редактор оставляет экран как был, без images API стадия
пропускается, лимиты в конфиге.
Общий прогон: `npm test` → 99/99.

Критерий готовности: правка одного дефекта не меняет ни одного пикселя вне своей
рамки, а непрошедший верификацию результат не попадает в состояние — закрыт.

---

## 10. Стадия overlap (новая, через AI-процесс) — ✅ ЗАВЕРШЁН

Чужое содержимое вырезается тем же способом, что и правка детали в стадии reconstruct:
роль называет рамку, harness режет фрагмент, редактор чистит только его, ответ
вклеивается ровно на место — всё остальное копируется из нетронутого исходника.

- [x] Схема решения роли: `OVERLAP_SCHEMA` (`verdict` clean/overlap, `assessment`,
      `patches[]` со `screen`, `kind`, `x`, `y`, `width`, `height`, `finding`,
      `prompt`) и список видов дефекта `OVERLAP_DEFECT_KINDS`
      (`overlap`, `shared-frame`, `shared-bg`).
- [x] Сравнение экранов: роль `overlap` получает все экраны сразу и инструменты
      `view_image` + `compare_images` (только чтение — ни кропа, ни генераций) и
      называет область, принадлежащую чужому экрану; экран определяется по имени,
      по имени файла или по пути.
- [x] Отбор рамок: `pickPatches` с `kinds = OVERLAP_DEFECT_KINDS` — координаты
      внутри кадра, покрытие ≤ 45 %, непустая инструкция, без пересечений, не
      больше `stages.overlap.maxPatches` регионов на экран.
- [x] Вычитание области: `planFragment` расширяет рамку на
      `stages.overlap.boxPadding` и до минимальной стороны 64 px, `rasterCrop`
      вырезает фрагмент, images API редактирует его (`editorPrompt` + контракт
      `EDITOR_FRAME`), `rasterPatch` вклеивает ответ обратно; попыток на область —
      `stages.overlap.maxAttempts`.
- [x] Артефакты → `./decomposition/overlap/`; очищенные файлы заменяют исходник в
      `state.screens`, `state.screensFiles` и `state.images`, непочиненные экраны
      остаются на месте, отказ попадает в `state.warnings`.

Проверено: `test/overlap.test.js` (9 тестов) — один экран сравнивать не с чем,
без images API стадия пропускается, роль видит все экраны и только инструменты
сравнения, чистый вердикт оставляет файлы на месте, чужая область вырезается,
чистится и вклеивается обратно (размеры экрана не меняются), область чужого
экрана и область за пределами кадра отклоняются, упавший редактор оставляет экран
как был, лимиты в конфиге.
Общий прогон: `npm test` → 108/108.

Критерий готовности: пиксели вне рамки чужого содержимого не меняются, а отказ
роли не оставляет ни файла, ни записи в состоянии — закрыт.

---

## 11. Стадия resolve (финальная) — ✅ ЗАВЕРШЁН

Финальный ответ — не первый файл, а последний в цепочке стадий, и он обязан существовать:
декомпозиция, которая называет картинку, которую никто не может открыть, декомпозицией не
является.

- [x] Цепочка файлов: `buildChain` собирает из `state.rectified`, `state.restored`,
      `state.overlapResolved` карту «что кем заменено», `followChain` идёт по ней от
      исходного экрана до последнего файла (`screens → rectified → restored → overlap`).
- [x] Валидация выхода: каждый экран проверяется на диске (`resolveInside` + `stat`);
      экран без файла помечается `missing: true`, его путь обнуляется, а в `notes`
      попадает строка о нём — в `subReferences` он не идёт.
- [x] Сборка `./decomposition.json` (`summary`, `screens`, `subReferences` с цепочкой
      правок в `note`, `notes`, `layers`); пути — POSIX-relative от корня проекта.
- [x] Advanced-режим (`--advanced` / `stages.resolve.layers`): роль `director` смотрит на
      первый плоский экран и называет слои с рамками (`LAYERS_SCHEMA`), harness режет эти
      рамки из исходных пикселей и пишет `layers/NN-<slug>.png`; рамки переводятся из
      кадра model-bound копии в кадр исходника и зажимаются в него; слоёв не больше
      `stages.resolve.maxLayers`.
- [x] Отличие от монолита: разложение на слои сделано через роль и локальный кроп, а
      порт клиента seedream-5.5 вынесен в шаг 15 (vendor-специфичный API, отдельный
      модуль, отдельный источник слоёв).

Проверено: `test/resolve.test.js` (10 тестов) — цепочка файлов и её конец, файл, который
никто не заменял, имя слоя как имя файла, зажим рамки в кадр, финальный путь и цепочка
правок в `decomposition.json`, экран без файла (`missing`, пустая ссылка, запись в
`notes`), без advanced-режима слоёв нет и каталога `layers/` тоже, advanced-режим режет
слои из пикселей экрана (размер слоя = размер рамки), слой без годной рамки отброшен,
лимит слоёв в конфиге.
Общий прогон: `npm test` → 118/118.

Критерий готовности: `decomposition.json` указывает на существующие файлы последних
стадий, а экран без файла не остаётся в выдаче как ссылка — закрыт.

---

## 12. Pipeline-оркестрация + CLI-обвязка — ✅ ЗАВЕРШЁН

- [x] `src/stages/index.js` — реестр стадий: порядок, заголовок, роль, каталог
      артефактов; `src/shared/pipeline.js` берёт стадии из реестра, а не из
      собственного списка.
- [x] `src/shared/pipeline.js` — `runPipeline`: порядок 6 стадий, пропуск по
      `stages.<id>.enabled` и `--stages`, `--stop-after <stage>`, передача state,
      dry-run (план без вызовов API); `runStages` вынесен отдельно и тестируется
      на своих стадиях.
- [x] Падение стадии не роняет прогон: ошибка попадает в `state.warnings`, в
      событие `stage.error` и в exit-код; прерывание (`AbortError`) останавливает
      прогон сразу.
- [x] `src/cli/renderer.js` + `colors.js` — TTY-рендер событий стадий
      (start/done/error/артефакт/warning), плоский рендер для pipe; `compatibility.js`
      (проверка версии Node) подключён к `main()`.
- [x] Exit-коды: 0 — успех, 1 — упавшая стадия или ошибка, 130 — прерывание.
- [x] Артефакты строго в `./decomposition/{extended,screens,rectified,restored,overlap}/`
      + `decomposition.json` (+ `layers/` в advanced-режиме).
- [x] `--dry-run` печатает план: стадии, модели, пути выхода.

Проверено: `test/pipeline.test.js` (8 тестов) — фиксированный порядок стадий и
каталоги артефактов, план из шести стадий, `--stages` выбирает стадии, но не их
порядок, выключенная стадия не идёт, `--stop-after` обрывает прогон, упавшая
стадия не мешает остальным (и её предупреждение доходит до читателя), прерывание
останавливает прогон.
Общий прогон: `npm test` → 126/126.

Критерий готовности: порядок стадий зафиксирован реестром, упавшая стадия
видна и не скрывает результат остальных — закрыт.

---

## 13. Тесты / проверка — ✅ ЗАВЕРШЁН

- [x] Порт `archive/reference-phases.test.js` → `test/phases.test.js` (поведенческий, не
      построчный): новые пути импорта, новые имена ролей и английские сообщения.
      Перенесённое поведение: локальный pad вместо модельного пресета, seam против
      дрейфа всей области, пустая полоса — не рост, контракт фрагмента, рост
      маленького бокса, `verdict: keep` не трогает референс.
      Переключателей режима (`auto`/`always`/`off`) в новом пакете нет — стадия
      выключается целиком через `stages.<id>.enabled`; единственный оставшийся
      `mode` — `stages.decompose.mode` (`agent`/`inline`), он выбирает, кто режет
      экраны. Разделение инструментов по стадиям закреплено явно
      (`AGENT_TOOLS`, `INLINE_TOOLS`, `RECTIFIER_TOOLS`, `OVERLAP_TOOLS`,
      `DIRECTOR_TOOLS`): проекция принадлежит стадиям геометрии, стадия overlap
      только смотрит и сравнивает, director только читает.
- [x] Смоук-тесты конфигов закреплены как `test/config.test.js` (8 тестов):
      дефолты валидны, приоритет file > env > CLI, placeholders `{{env:...}}` и
      `{{file:...}}`, понятные сообщения о битом JSON и неизвестном разделе,
      `redactConfig`, `ensureConfigFile`.
- [x] `npm test` = `node --test --test-timeout=60000 "test/*.test.js"`.
- [x] Границы — `test/boundaries.test.js` (6 тестов): локальный сервер работает без
      ключа, без ключа CLI объясняет, что делать (exit 1, называет
      `AI_DECOMPOSE_API_KEY`), `--dry-run` работает без ключа, битый конфиг даёт
      понятную ошибку, JPEG-референс уходит в модель как `image/jpeg`, картинка
      меньше `minScreenSide` отвергается.
- [x] Примеры — `test/examples.test.js` (3 теста): `examples/original.png` — это
      JPEG под именем `.png`, поэтому формат берётся из содержимого; примеры
      сохраняют форму (1254×1254 и 360×800); inline-путь режет экран из
      `examples/ai-rectified.png` пиксель в пиксель.
- [x] Прогон на примере: `node bin/ai-decompose.js -i examples/original.png
      --dry-run` печатает план шести стадий и выходов, exit 0, API не вызывается.

Проверено: `npm test` → 153/153 (было 126/126 после шага 12).

Критерий готовности: поведение фаз, границы и примеры закреплены тестами,
общий прогон зелёный — закрыт.

---

## 14. Поэтапное затухание в монолите — ✅ ЗАВЕРШЁН

- [x] Каждый портированный `src/*` монолита помечен header-тегом
      `@ai.hint legacy-0.2`: openai-слой (`chat`, `client`, `errors`, `fallback`,
      `http`, `images`, `sse`, `stream`), image-слой (`raster`, `skew`, `distort`,
      `magick`, `canvas`, `rectify`), agent-слой (`decomposition`, `mcp`, `paths`,
      `schemas`, `skills`, `tool-specs`, `tools`), роли (`decomposer`, `untrusted`,
      `extender`, `rectifier`, `restorer`) и три стадии, выросшие из архивных фаз
      (`stages/extension`, `stages/rectify`, `stages/reconstruct`,
      `stages/restore-plan`). Написанные для нового пакета файлы тега не имеют.
- [x] Фазы `archive/reference-phases/{extend,rectify,restore}.js` остаются
      эталоном до зелёных тестов шага 13, затем — только archive: шаг 13 закрыт,
      README архива переписан (где фазы живут теперь и как их вернуть).
- [x] README монолита: `ai decompose` делегирует в `ai-decompose` — описана
      команда, поиск бинарника и то, что конфиг нового CLI свой
      (`~/.ai-decompose/config.json`, `AI_DECOMPOSE_*`).
- [x] Обновлён `archive/reference-phases/README.md`: ссылка на новый дом фаз
      (`submodules/u2ai-decomposer/src/stages/`).
- [x] В монолите добавлена команда-мост: `src/commands/decompose.js` переводит
      флаги монолита в флаги нового CLI (`--image`, `--out`, `--config`,
      `--model`, `--effort`, `--image-model`, `--stop-after`, `--stages`,
      `--dry-run`, `--advanced`), находит бинарник (`AI_DECOMPOSE_BIN` →
      `submodules/u2ai-decomposer` → `node_modules/@u2ai/decomposer` → `PATH`)
      и возвращает его exit-код. Команда зарегистрирована в `src/cli.js`, её флаги
      добавлены в таблицу опций, справка — в `src/cli-help.js`.
      Проверено: `test/decompose-command.test.js` (4 теста) в репозитории монолита.
- [x] В 0.2.xx удалять перенесённое только после релиза соответствующих стадий
      в 0.3.xx: в монолите ничего не удалено, фазы уже живут в архиве, а
      мост только делегирует.

Проверено: `npm test` в новом пакете → 153/153; `npm test` в монолите — зелёный
(в том числе `test/decompose-command.test.js`).

Критерий готовности: фазы живут в своём пакете, монолит на них ссылается и
делегирует, архив помечен как архив — закрыт.

---

## 15. Порт клиента seedream-5.5 (разложение на слои) — ✅ ЗАВЕРШЁН

Шаг 11 оставил vendor-специфичный API за скобками: разложение на слои делалось ролью
`director` и локальным кропом. Теперь в пакете есть и второй источник слоёв — сама
картинка-модель, как это описано в документации apimart.

Спецификация: <https://docs.apimart.ai/ru/api-reference/images/seedream-5-5/generation>

- [x] `src/openai/seedream.js` — клиент модели: тело разложения (`layer_decomposition`,
      ровно одно входное изображение, без `background`, `n` не передаётся, `size` только
      тайлы `1K`/`1.5K`/`2K`/`auto`), тело генерации (`image_urls`, прозрачность только
      в PNG), опрос задачи (`data[0].task_id` → `GET /tasks/{id}`, 3 с первые 30 с, потом
      5 с, потолок 14 мин), разбор ответа и скачивание файлов.
- [x] Геометрия рамок по документации: `absolute` — `[left, top, right, bottom]` в
      пикселях базового изображения; `normalized` — та же рамка в диапазоне 0–1000,
      пересчитывается на холст `W × H` (`x = left / 1000 * W`, `w = (right - left) / 1000 * W`,
      и так далее). У базы рамки нет.
- [x] **Коррекция размеров слоёв при fetch:** модель масштабирует каждый слой отдельно,
      поэтому размер файла слоя не совпадает с `bounding_box`; файл приводится к
      `w × h` рамки (`rasterFitToBox`), и рамка говорит, где слой лежит — `(x, y)` поверх
      базы. Пиксели файла слоя не считаются координатами базы.
- [x] `src/openai/client.js` — липкие каналы (`client.channels('images', model)`): задача
      опрашивается на том хосте, который её создал, иначе `task_id` другому хосту ничего
      не значит.
- [x] `src/stages/resolve.js` — advanced-режим умеет брать слои у модели: база пишется в
      `layers/00-base.png`, слои — в `layers/NN-<name>.png` (приведённые к рамке), в
      `decomposition.json` попадают `layersTarget`, `layerFrame` (холст рамок), `layerBase`
      и по слою `box`, `z`, `text` (OCR). Источник выбирается через
      `stages.resolve.layerSource`: `auto` берёт модель, когда она seedream, иначе роль.
- [x] Конфиг: `stages.resolve.layerSource` (`auto`/`seedream`/`director`),
      `layerSize` (`auto`/`1K`/`1.5K`/`2K`), `textRecognition`, `layerPrompt`; всё
      проверяется валидатором.

Проверено: `test/seedream.test.js` (19 тестов) — тела обоих режимов, тайлы, рамки
(абсолютные и нормализованные), разбор ответа по индексам, OCR, опрос задачи, отказ
модерации, переход на другой хост; `test/resolve.test.js` (14 тестов) — выбор источника
и разложение моделью с проверкой, что файл слоя приведён к `w × h` рамки.
Общий прогон: `npm test` → 176/176.

Критерий готовности: слои модели читаются по спецификации, а файл каждого слоя совпадает
с рамкой, в которую его надо поставить — закрыт.

---

## 16. Живой прогресс и длинные запросы — ✅ ЗАВЕРШЁН

Пользователь пожаловался: `ai-decompose --effort xhigh --image app.png` печатает
`▶ Extend reference` и замолкает на минуты — «запрос проходит, а ничего не видно, что
происходит». Замер показал, что запрос не зависал: текстовый вызов роли `extender` шёл
78 с, а правка картинки — ещё 50 с, и оба молчали.

Причина была тройной:

1. Ответ роли запрашивался **без потока**, поэтому терминал получал результат только
   после конца генерации — минуты тишины.
2. `timeoutMs` был **120 с** и это был не «бюджет запроса», а окно молчания сокета:
   не- streamed запрос укладывается в него целиком, и правка картинки (картинка приходит
   одним куском, потока нет) его упиралась.
3. Ретраи и смены хоста прятались: событие `request.retry` уходило в лог, который
   виден только с `--verbose`.

- [x] `src/roles/index.js` — роль просит **потоковый** ответ (`stream: true`): пока модель
      думает, идут события, и хост не может «замолчать» посреди работы. Роль также
      сообщает своё состояние событиями `role.start` / `role.done` (роль, модель, ход).
- [x] `src/openai/client.js` — окно молчания стало **окном застоя**, а не бюджетом:
      `requestTimeoutMs(config, kind)` возвращает `timeoutMs` (по умолчанию **600 000 мс**)
      для текста и `imageTimeoutMs` (**900 000 мс**) для картинки. Окно живого ответа
      делается в секундах, а не в минутах.
- [x] `src/openai/client.js` — если хост не умеет поток на маршруте `responses`
      (400/422/501 со словом «stream»), запрос повторяется без флага и всё равно
      отвечает; событие `transport.adjust` сообщает об этом читателю.
- [x] `src/openai/stream.js` — `finalResponse()` восстанавливает элементы ответа, если
      хост прислал «тонкий» `response.completed` без тела: иначе потерянный `output`
      выглядел бы как пустой ответ.
- [x] `src/cli/renderer.js` — живая строка под заголовком стадии: спиннер, что делает
      модель сейчас и сколько времени это идёт (`0 s`, `1 m 12 s`, `1 h 04 m`). Строка
      стирается на финише стадии, а сама стадия оставляет после себя длительность.
      Ошибки, ретраи, пропуски хостов и смены транспорта печатаются всегда, а не только
      с `--verbose`.
- [x] `src/cli/renderer.js` — простой рендерер (когда вывод в файл или в конвейер)
      печатает те же события строками: лог прогона тоже показывает прогресс.
- [x] `src/cli.js` — события транспорта доходят до рендерера: `createClient({ onEvent })`.
- [x] Конфиг: `timeoutMs` (5 000…600 000), `imageTimeoutMs` (5 000…1 800 000),
      `streaming` (`true` | `false`); env — `AI_DECOMPOSE_TIMEOUT_MS`,
      `AI_DECOMPOSE_IMAGE_TIMEOUT_MS`, `AI_DECOMPOSE_STREAMING`. Всё проверяется
      валидатором.

Проверено: `test/progress.test.js` (6 тестов) — поток запрашивается, события роли
приходят, живая строка перерисовывается и несёт время, простой рендерер пишет прогресс,
окна у маршрутов разные, отказ хоста от потока распознаётся, «тонкий» финал сохраняет
элементы ответа. Живой прогон на `C:\Projects\Decomp\app.png` со `--effort xhigh`:
стадия extend печатает «the extender role is answering (moonshotai/kimi-k3.1-pro)» и
успевает и текст, и правку картинки без таймаута и без молчаливых ретраев.
Общий прогон: `npm test` → 182/182.

Критерий готовности: длинный запрос виден в терминале и не обрывается молча —
закрыт.

---

## 17. Любое ребро, коллаж и отчёт о каждом решении — ✅ ЗАВЕРШЁН

Пользователь пожаловался на два конкретных дефекта прогона:

- «Выбрано не то ребро» — картинка расширялась не с той стороны: чёрный промо-телефон был
  срезан сверху, а модель называла только `bottom`, потому что роль проверяла одно ребро,
  а схема приглашала писать `top`/`left`, которых стадия не умела растить.
- «Да, резать на экраны» — коллаж из трёх телефонов надо было разрезать на три экрана,
  а пайплайн отдавал два «экрана», каждый из которых держал по полколлажа.

И третье, общее: «Оно ничего толком даже не вывело» — стадия принимала решение и молчала.

1. **Расширение — любое ребро и сразу несколько.**
   - `src/stages/extension.js` — `edgeList()` нормализует ответ роли (одно ребро или список);
     `extensionTarget()` возвращает `{width, height, band, offsets}`, где `offsets` говорят,
     где в новом холсте лежит исходник; `bandRects()` описывает полосы нового холста,
     `bandInnerSide()` — сторону полосы, которая касается исходника, `bandPatchRect()` —
     прямоугольник патча с тонкой полосой исходника (фейд ложится на неё, а не оставляет
     пустую линию между старым и новым).
   - `src/image/raster.js` — `rasterPadImageBytes()` получил `offsetX`/`offsetY`: исходник
     может стоять не в левом верхнем углу, поэтому полосу можно дорастить и сверху, и слева.
   - `src/agent/schemas.js` — `EXTEND_SCHEMA` требует `edges` (массив) рядом с `edge`;
     `src/roles/extender.js` — роль проверяет все четыре ребра и называет все срезанные.

2. **Коллаж режется на экраны.**
   - `src/stages/rectify.js` — если роль назвала углы, но не написала файл, проекцию делает
     сама стадия (`projectQuad`, `quadCorners`, `screenFileName`): проекция — это и есть разрез.
     Пустая проекция (меньше половины пикселей) не принимается (`opaqueShare`).
     Проверка наклона не применяется, когда из одной картинки получилось несколько экранов:
     наклон коллажа ничего не говорит о наклонах экранов внутри него.
   - **Коллаж режется из исходника, а не из крошек декомпозитора.** Живой прогон показал:
     модель-декомпозер прочитала три наклонённых телефона как «одну панель управления» и
     разрезала картинку пополам; резать по крошкам — резать не там. Теперь референс
     (`state.references`, его кладёт стадия `extend`) — источник истины: `rectify` режет его
     сам, называет углы каждого экрана и заменяет крошки декомпозитора своим разрезом
     (`referenceFiles`, `cropOfReference`). Если референс разрезать не удалось, крошки
     обрабатываются как раньше — хорошая крошка не теряется. Перегенерированный или
     привезённый из Figma субличный файл крошкой не считается и обрабатывается сам по себе.
   - `src/roles/rectifier.js` — роль называет **каждый** экран коллажа и углы каждого.
   - `src/agent/schemas.js`, `src/roles/decomposer.js` — схема декомпозитора требует
     `rect` у каждого экрана, роль просит называть все экраны коллажа, включая те, что
     видны частично.
   - `src/stages/decompose.js` — если роль назвала экран, но не написала файл, харнесс режет
     сам по её `rect` (`src/stages/decompose-screens.js`, `skipExisting` не даёт затереть
     уже написанный файл).
   - `src/stages/resolve.js` — цепочка файлов (`buildChain`, `followChain`) идёт по **всем**
     ветвям: одна картинка, разрезанная на три, — это три экрана в `decomposition.json`,
     а не один. Если декомпозер не назвал ни одного экрана, экранами считаются файлы,
     которые произвели поздние стадии.

3. **Каждая стадия говорит, что решила и что произвела.**
   - События: `extend.decision` (вердикт, рёбра, полоса, размеры), `extend.done` (файл и
     размеры), `decompose.cut` (экран → файл), `decompose.screens` (имена и файлы экранов),
     `rectify.projected`, `rectify.file`, `resolve.json`, `resolve.done`.
   - `src/cli/renderer.js` — эти строки печатаются всегда, а не только с `--verbose`;
     добавлен `summaryLines()` и финальная сводка CLI: путь к `decomposition.json`,
     список экранов с файлами, число слоёв и число предупреждений.
   - `src/stages/resolve.js` — `decomposition.json` пишется **до** разбиения на слои:
     ответ существует, даже если разбиение долгое или упало.

Проверено: `test/extension.test.js` (14 тестов) — новая API расширения, все четыре ребра,
несколько рёбер сразу, seam по краю и заливка полосы, отступы при паддинге;
`test/rectify.test.js` (20) — углы ответа, имя файла экрана, проекция силами стадии, разрез
референса вместо крошек и откат к крошкам; `test/decompose.test.js` (19) — экран без файла
режется харнессом; `test/resolve.test.js` (16) — разрез на несколько экранов и цепочка по всем
ветвям; `test/progress.test.js` (8) — новые строки отчёта и финальная сводка.
Общий прогон: `npm test` → 201/201.

Живая проверка на `C:\Projects\Decomp` (коллаж 1024×768 из трёх телефонов,
`ai-decompose --advanced --effort xhigh --image app.png`):
- `extend` — роль назвала **top + bottom**, полоса 256 px, холст вырос до 1024×1280;
  редактор дважды упёрся в «Insufficient balance», но полосы всё равно дорисовались
  (вторая попытка прошла) — шов и заливка приняты.
- `decompose` — как и раньше, прочитал коллаж неверно («payment-history», один экран),
  и именно поэтому разрез делает следующая стадия.
- `rectify` — референс разрезан на **три** экрана: `01-payment-history-left` (240×700),
  `-middle` (252×643), `-right` (273×676) — все три выровнены, наклон коллажа не мешает.
- `resolve` — в `decomposition.json` три экрана со своими файлами, 15 слоёв;
  `reconstruct` и `overlap` ничего не испортили (ремонт отклонён проверкой, оригинал остался).

Критерий готовности: любое ребро доращивается, коллаж режется на экраны, а прогон
рассказывает, что решил и что произвёл, — закрыт.

---

## 18. Узкий рез, полоса вдвое больше нужного и отсутствие резервного пути — ✅ ЗАВЕРШЁН

Пользователь разобрал результат живого прогона и назвал четыре дефекта:

1. «`rectify`, обрезки слишком сужены» — вместо примерно 288×640…304×720 стадия выдала
   240×700, 252×643 и 273×676: углы стояли на **контенте** экрана, а не на краях дисплея,
   поэтому у каждого среза срезало поля экрана, статус-бар и последнюю строку.
2. «`restored` ничего нету (возможно мой косяк с балансом)» — хосты картинок отвечали
   «Insufficient balance», а **резервного пути по модели** не было вовсе.
3. «нельзя было обрезать признаки overlap, нужно было убрать их при помощи ИИ» — срезанные
   куски экрана выглядели как работа `overlap`, хотя резала `rectify`; сам `overlap` убирает
   чужое содержимое только редактором изображений, но в прогоне отработал вхолостую.
4. «для `extended` достаточно было бы 1024×1024, а не 1024×1280» — полоса была четвертью
   длинной стороны (256 px на ребро) вместо нужной восьмой (128 px).

1. **Рез не уже экрана.**
   - `src/roles/rectifier.js` — углы принадлежат **дисплею устройства**, а не содержимому:
     «the corners belong to the screen itself: the four outer corners of the display area»,
     «not the content inside the screen», плюс несколько пикселей запаса снаружи дисплея.
   - `src/agent/schemas.js` — `RECTIFY_REVIEW_SCHEMA`: ответ роли на проверку среза
     (`ok` / `recut` + углы по срезанным экранам).
   - `src/stages/rectify.js` — `reviewCuts()`: роль получает референс **и** свои срезы
     и отвечает, не срезан ли экран; ответ `recut` с более широкими углами перепроецируется
     стадией в тот же файл (старый рез восстанавливается, если новая проекция пустая или
     меньше прежней — срезанный экран по определению меньше полного).
     Выключается `stages.rectify.review: false`.
   - `src/cli/renderer.js` — строка `re-cut: … — the screen was cut off`.

2. **Резервный путь по модели для картинок.**
   - `src/openai/client.js` — `images.generate` и `images.edit` идут по цепочке
     `fallbackChain(config, model)`: сначала модель, потом её запасные из `fallback.models`.
     Событие `model.fallback` (`from`, `to`, `error`).
   - `src/config/defaults.js` — по умолчанию `fallback.models['openai/gpt-image-2.6-sunburst'] =
     ['openai/gpt-image-2.6-flare']`; цепочка хостов `imagesBackends` работала и раньше.
   - `src/cli/renderer.js` — «the model … failed: … — trying …».

3. **Полоса расширения — восьмая часть длинной стороны.**
   - `src/config/defaults.js`, `src/stages/extension.js`, `src/image/padding.js` —
     `padFraction` 0.25 → 0.125: 1024×768, срезанная сверху и снизу, → 1024×1024.

4. **Отчёт.** Ничего не молчит: полоса, рез, пере-рез и резервная модель видны в логе.

Проверено: `test/rectify.test.js` (23) — в том числе проверка среза, повторный рез и отказ
пере-резу, который меньше прежнего; `test/openai.test.js` (20) — в том числе резервная модель
картинки; `test/extension.test.js`, `test/phases.test.js` — полоса и её доля от длинной стороны.
Общий прогон: `npm test` → 205/205.

Критерий готовности: рез не уже дисплея, у полосы есть разумный размер, у картинок есть
резервная модель, а `overlap` по-прежнему чинит чужое содержимое редактором, а не срезом, —
закрыт.

---

## 19. Геометрия и скруглённые углы в `restorer` — ✅ ЗАВЕРШЁН

Пользователь: «в restorer нужно заложить ещё и свою поправку с проекцией (в том числе с теми
самыми 3% или какими-то градусами), а не только восстановление утраченных деталей или убирание
каких-то overlap или круглых углов экрана». Решение — **гибрид**: ИИ чинит пиксели (включая
скруглённые углы дисплея), доводка геометрии делается детерминированно и проверяется замером.

1. **Скруглённые углы — это работа ИИ.**
   - `src/agent/schemas.js` — `RESTORE_DEFECT_KINDS` дополнен видом дефекта `rounded-corner`:
     угол скруглён потому, что дисплей устройства скруглён; угол принадлежит дисплею, а не
     содержимому, поэтому содержимое надо продолжить в него.
   - `src/roles/restorer.js` — пятый вид дефекта и отдельная часть про геометрию: роль **называет
     числа** (наклон в градусах, размер в процентах), но сама ничего не выпрямляет.

2. **Геометрия — работа харнесса, с замером и откатом.**
   - `src/image/geometry.js` (новый) — `applyGeometry()`: поворот и поправка размера по пикселям,
     обратная карта и билинейные веса, холст растёт под исправленную картинку (ничего не
     обрезается), клином открытые углы заполняются пикселями ближайшей кромки. До и после
     измеряется остаточный наклон (`image/skew`).
   - `src/stages/reconstruct.js` — порядок: сначала ИИ-патчи, потом геометрия. Проверка ИИ-починки
     идёт **до** поворота (поворот двигает все элементы, и верификатор счёл бы это порчей).
     Доводка принимается, только если экран стал ровнее (`minImprovementDeg`), иначе она
     откатывается и об этом пишется в лог. Событие `reconstruct.geometry`.
   - `src/agent/schemas.js` — `RESTORE_SCHEMA`: `verdict` дополнен значением `straighten`, добавлен
     объект `geometry` (`rotateDeg`, `scalePercent`, `reason`).
   - `src/config/defaults.js`, `src/config/validate.js` — `stages.reconstruct.geometry`:
     `enabled`, `maxRotateDeg` (6), `maxScalePercent` (10), `minImprovementDeg` (0.2). Число выше
     предела отклоняется с предупреждением, а не обрезается молча.
   - `src/cli/renderer.js` — строка `geometry: … — tilt 3°, size 0% (2.9° → 0.4°, applied)`.

Проверено: `test/geometry.test.js` (4) — поворот снимает наклон и не режет картинку, неверный
знак делает хуже, поправка размера растит холст, клин заполнен картинкой; `test/reconstruct.test.js`
(13) — геометрия роли применяется и откатывается, когда экран не стал ровнее, плюс валидация
конфига. Общий прогон: `npm test` → 212/212.

Критерий готовности: restorer называет градусы и проценты, углы чинит редактором, а доводка
геометрии детерминированная, измеренная и откатываемая — закрыт.

---

## 20. Экономия починки: дешёвое качество и fail-fast — ✅ ЗАВЕРШЁН

Пользователь: «Какие стадии резать: оставить обе, но удешевить. Что делать с ИИ-починкой:
fail-fast — не делать вторую починку, если первую отвергли. Слои: оставить только за
`--advanced`». Решение — стадии не режем, а удешевляем: дешёвое качество ответа редактора и
проверка каждой починки по отдельности.

1. **Общий модуль починки — `src/stages/repair.js` (новый).**
   - `editFragment()` — вызов редактора для одного фрагмента (с повторами и `quality`).
   - `verifyRepair()` — второй взгляд на «до/после». До этого обе функции были продублированы
     в `reconstruct` и `overlap`; теперь одно место решает, как дорого просить и что считать
     удачной починкой.

2. **Fail-fast в обеих починяющих стадиях.**
   - `src/stages/reconstruct.js` — каждая починка проверяется сразу после слияния, а не один раз
     в конце. Отказ верификатора → экран заканчивается на этом месте: вторую починку не делаем,
     а в лог пишется, что починка отвергнута. Сохраняется последнее принятое состояние.
   - `src/stages/overlap.js` — то же самое: чужая область чистится и проверяется, отказ
     оставляет экран как есть.

3. **Качество — настройка стадии, а не прогона.**
   - `src/config/defaults.js` — `stages.extend.quality`, `stages.reconstruct.quality`,
     `stages.overlap.quality` = `low`. Глобальный `image.quality` (`high`) остаётся для картинок,
     которые прогон генерирует сам (слои, разложение), а не для фрагментов, которые он чинит.
   - `src/config/validate.js` — `quality` проверяется на `low | medium | high | auto`.
   - `src/stages/extension.js` — полоса расширения просит качество своей стадии.

4. **Слои — только за `--advanced`** (`wantLayers = advanced || config.stages.resolve.layers`).
   Правило уже было таким, менять не пришлось.

Проверено: `test/reconstruct.test.js` — отвергнутая починка удаляется, отказ заканчивает экран
(редактор не зовётся второй раз), редактору задано дешёвое качество; `test/overlap.test.js` —
то же для чистки чужого. Общий прогон: `npm test` → 216/216.

Критерий готовности: починка экрана стоит одного вызова картинки, а не трёх, и не тратит деньги
на `high` там, где хватает `low`, — закрыт.

---

## 21. Хост без денег: следующий бэкенд, следующая модель — ✅ ЗАВЕРШЁН

Пользователь: «Именно в таких случаях: `the host failed: {"detail":"Insufficient balance to run
this request."}` И нужны fallback на другие backend'ы, вроде routerai…».

1. **Хост без денег запоминается.**
   - `src/openai/client.js` — `outOfCredit(error)`: отказ по деньгам узнаётся по `402`, по коду
     `insufficient_quota` и по формулировке («Insufficient balance», «payment required»).
     Такой хост добавляется в список «сломанных» и больше не спрашивается в этом прогоне —
     иначе каждый вызов картинки платил бы за один и тот же отказ.
   - `src/openai/client.js` — в `call()` такой хост пропускается с событием `request.skip`, а
     следующий хост списка (`imagesBackends` для картинок, `backends` для текста) берёт запрос.
   - `src/cli/renderer.js` — новая строка: `⚠ the host … has no balance: … — the next host takes
     the request`, и в `request.error` теперь видно, какой именно хост упал.

2. **Причина отказа читается из ответа.** Раньше текст отказа был сырым JSON
   (`{"detail":"Insufficient balance…"}`), теперь `apiErrorFrom` берёт `detail` наравне с
   `message`, и в логе видно причину, а не JSON.

3. **Резервная модель работает и для текста.** Раньше цепочка `fallback.models` применялась
   только к картинкам: если текстовая модель недоступна на всех хостах, прогон просто падал.
   Теперь `responsesCreate` идёт по той же цепочке моделей, и в `fallback.models` можно
   прописать запасную модель для ролей (например, для `moonshotai/kimi-k3.1-pro`).

4. **Маршрут seedream (слои) — тоже.** `isHostUnavailable` считает отказ по деньгам таким же,
   как «хост не отдаёт эту модель», и задача уходит следующему хосту. Помощник `outOfCredit`
   живёт в `src/openai/errors.js`, его используют и клиент, и seedream.

Проверено: `test/openai.test.js` — картинка уходит к следующему хосту, когда у первого нет денег;
хост без денег не спрашивается второй раз; причина отказа читается; `outOfCredit` отличает отказ
по деньгам от любого другого; текстовый запрос уходит к следующему хосту и следующей модели.
`test/seedream.test.js` — задача уходит следующему хосту, когда у первого нет денег.
Общий прогон: `npm test` → 222/222.

Критерий готовности: отказ «Insufficient balance» не убивает прогон — запрос уходит другому
хосту, а если и у него нет денег, то следующей модели, — закрыт.

---

## 22. Прогон одной стадии на артефактах прошлого прогона — ✅ ЗАВЕРШЁН

Пользователь: «С целью экономии, можно (было бы) прогнать только отдельные этапы, вроде
restorer и исправить именно его». Стадии и раньше можно было выбрать через `--stages`, но
выбранная стадия брала на вход картинку из `--image` — то есть рестorer чинил коллаж, а не
экраны. Теперь прогон продолжается с того места, где остановился прошлый.

1. **Манифест рабочего каталога — `src/shared/manifest.js` (новый).**
   - После каждой стадии пайплайн пишет `decomposition/manifest.json`: какие файлы стадия
     произвела, каким экранам они принадлежат, что что заменило (`chain`) и какие экраны есть
     в итоге.
   - `filesOfStage()`, `chainOfState()`, `saveStageManifest()` — сбор данных из состояния прогона.

2. **Продолжение прогона — `src/shared/resume.js` (новый).**
   - `resumeFromWorkDir()` читает манифест и, если его нет, сами картинки каталогов, и заполняет
     состояние прогона: `screens`, `screensFiles`, `images`. Дальше стадия работает ровно с теми
     файлами, которые оставил прошлый прогон.
   - Порядок каталогов зависит от того, что запускают: `rectify` берёт результат `decompose`,
     `reconstruct` — результат `rectify`, `overlap` — результат `reconstruct` (а если его нет,
     то `rectify` или `decompose`).
   - `src/shared/pipeline.js` — продолжение вызывается перед стадиями; стадия `decompose` в
     списке означает, что продолжать нечего: экраны нарезаются заново.
   - `src/cli/renderer.js` — строка `the screens of the last run are used: 3 file(s) from
     decomposition/rectified`.

3. **Имена экранов переживают прогон.** Раньше имя экрана жилось только в состоянии прогона;
   теперь оно лежит в манифесте (`stages.*.files[].screen`), поэтому `resolve` и повторный
   прогон знают, как называется каждый файл. Без манифеста имя берётся из имени файла
   (`01-home.png` → `home`).

Проверено: `test/resume.test.js` (8) — рестorer берёт экраны прошлого прогона, `rectify` берёт
нарезанные экраны, `overlap` берёт восстановленные, прогон с `decompose` не продолжается, имена
экранов берутся из манифеста, манифест пишется по итогам стадии. Общий прогон: `npm test` →
230/230.

Критерий готовности: `--stages reconstruct` чинит экраны прошлого прогона и не тратит деньги на
повторное нарезание и выпрямление, — закрыт.

---

## 23. Продолжение берёт только файлы последнего прогона — ✅ ЗАВЕРШЁН

Живая проверка шага 22 показала дефект: `--stages reconstruct` в каталоге, где картинки
писали несколько прогонов, взял 9 файлов вместо 3 — каталог хранит файлы всех прошлых
прогонов, а не только последнего.

1. **Отбор новейшей партии файлов — `src/shared/resume.js`.**
   - `picturesIn()` читает время файла (`mtimeMs`) вместе с размером.
   - `latestBatch()` возвращает файлы последнего прогона: файлы одного прогона пишутся подряд,
     а пауза длиннее 10 минут между двумя файлами означает, что старый файл принадлежит более
     раннему прогону. Файлы возвращаются в порядке имён — порядок экранов не зависит от
     времени записи.

2. **Манифест не ведёт в пустоту.** Файл, названный манифестом, но уже удалённый с диска, не
   попадает в прогон: иначе стадия упала бы на несуществующем файле.

3. **Документация.** README: «Running one stage on its own» — уточнено, что без манифеста берутся
   файлы последнего прогона.

Проверено: `test/resume.test.js` (11) — каталог с тремя прогонами (9 файлов) даёт 3 файла
последнего прогона, `latestBatch()` отбирает новейшую партию, манифест с удалённым файлом не
ломает прогон. Общий прогон: `npm test` → 233/233.

Критерий готовности: прогон отдельной стадии работает ровно с экранами последнего прогона, а не
со всеми файлами, что остались в каталоге, — закрыт.

---

## 24. Маршрут слоёв: APIMart (seedream-5.5) — ✅ ЗАВЕРШЁН

Пользователь: «Нужно подключить https://docs.apimart.ai/ru/api-reference/images/seedream-5-5/generation
для Layer Decomposition. https://api.apimart.ai/v1/images/generations, с API key по ENV
`APIMART_API_KEY`».

Дефект: разложение на слои ходило на маршрут картинок (`imagesBackends`) и выбиралось по
`imageModel`. Но seedream-5.5 живёт на другом хосте: картинковые хосты этой модели не знают, а
модель починки (`gpt-image`) слои не раскладывает. Нужен отдельный маршрут слоёв.

1. **Маршрут слоёв — свой список хостов.** `defaults.layerBackends` =
   `[{ baseURL: 'https://api.apimart.ai/v1', env: 'APIMART_API_KEY' }]`. Ключ читается из
   переменной окружения, в файл конфига он не попадает; порядок хостов, как и у остальных
   маршрутов, меняется в `~/.ai-decompose/config.json`.
2. **Модель маршрута — своя.** `stages.resolve.layerModel` = `seedream-5.5`. Раньше маршрут слоёв
   брал `imageModel` — то есть модель починки.
3. **Клиент** (`src/openai/client.js`). `resolveBackends(config, { kind: 'layers' })` берёт
   `layerBackends`; ключ обязателен (хост без ключа seedream не отвечает), и хост текстового
   маршрута подставляться не должен. `client.channels('layers', model)` отдаёт sticky-каналы
   этого маршрута — задача опрашивается на том хосте, который её создал.
4. **Стадия resolve** (`src/stages/resolve.js`). `resolveLayerModel()` — модель маршрута;
   `resolveLayerSource()` в режиме `auto` берёт seedream, когда модель seedream и у маршрута есть
   хост с ключом, а иначе отдаёт экран текстовой роли (это бесплатно) и пишет в лог, почему.
   Каналы маршрута передаются в `splitLayersWithSeedream()`.
5. **Проверка на моке APIMart** (локальный сервер, без внешних запросов): `POST
   /v1/images/generations` с `Authorization: Bearer`, телом `layer_decomposition: true`, ровно
   одним изображением, без поля `background`, без `n`, с `layer_decomposition_options`; опрос
   `GET /v1/tasks/{task_id}` на том же хосте; разбор ответа — база, слой с рамкой и OCR.

Критерий готовности: `--advanced` разлагает экран на слои через APIMart по ключу из
`APIMART_API_KEY`, а без ключа не платит и отдаёт экран текстовой роли, — закрыт.

---

## 25. Правки после прогона тестов — ✅ ЗАВЕРШЁН

Пользователь прогнал тесты сам и прислал два падения.

1. **Формулировка предупреждения о маршруте слоёв.** Тест ждёт слова «no image backend» —
   это устоявшееся имя маршрута в коде (`src/openai/seedream.js`). Формулировка шага 24
   («no host of the layer route has a key») тест не узнавал. Имя маршрута возвращено:
   «resolve: no image backend of the layer route has a key — the text role splits the screen
   instead» и «resolve: no image backend is configured for the seedream layer split».
2. **Молчащий мок в `test/openai.test.js`.** В коммите «change models on use…» ответ мока на
   неизвестную модель (`404 The model is not available here.`) был закомментирован, и сервер
   не отвечал на запрос вовсе: клиент ждал ответа до окна тишины (15 минут для картинок),
   тест зависал, а файл падал с «Promise resolution is still pending but the event loop has
   already resolved». Ответ мока возвращён: сценарий «модель не доступна» проверяется снова,
   а следующая модель (`bytedance-seed/seedream-5-5`) получает запрос.

---

## 26. Попытки rectifier'а: до трёх на экран, лучший побеждает — ✅ ЗАВЕРШЁН

Стадия `rectify` работала по принципу «одна попытка на экран плюс один re-cut»: если модель
поставила углы неточно, результат либо принимался как есть, либо откатывался, и второй шанс
не давался. На живом коллаже из трёх телефонов это означало, что один плохо спроецированный
экран портил весь результат.

Теперь у каждого экрана свой бюджет попыток — `stages.rectify.maxAttempts` (три по умолчанию):

1. **Попытка — это проекция из исходного crop'а.** Углы, которые вернула модель, всегда
   проецируются стадией от оригинала, а не от уже поправленного кадра: проекция поверх
   проекции только складывает ошибки. Файл, который написала сама роль, берётся кандидатом
   только тогда, когда модель не назвала углов вовсе.
2. **Лучший побеждает, худший откатывается.** Наклон измеряется в пикселях (`image/skew`),
   а не оценивается моделью. Кандидат, который не ровнее уже принятого, откатывается по
   байтам — принятый файл сохраняет прежнее содержимое.
3. **Остановка при отсутствии улучшения.** Экран, чья попытка не приблизила его к ровному,
   больше не пробуют: улучшать больше нечего. Экран, который уже ровный, тоже не спрашивают:
   лишний вызов модели только тратит деньги. Сравнение идёт по абсолютному значению угла,
   чтобы знак наклона не влиял на решение.
4. **Re-cut — тоже попытка.** Повторный рез после ревью расходует часть того же бюджета,
   а не идёт сверх него; проверяется наклон и размер: ре-кат, который уже обрезанного экрана
   касается, не заменяет его. Ревью проходит после всех попыток, когда результат уже известен.
5. **Имена файлов канонические.** Принятый экран лежит под именем `screenFileName(label, index)`,
   кандидаты раунда — в scratch-каталоге `decomposition/rectified/.try-N/`, поэтому файл принятого
   экрана никогда не перезаписывается более поздней попыткой. Два экрана не делят один файл.
6. **Чистка каталога вывода** трогает только файлы текущего прогона (по `mtime`) и не трогает
   ни файлы прошлых прогонов, ни принятые файлы текущего.

Файлы: `src/stages/rectify.js` (`processUnit`, `screenKey`, `betterAngle`), комментарий
`stages.rectify.maxAttempts` в `src/config/defaults.js`, раздел README «Cutting a collage into
screens», тесты `test/rectify.test.js` (лучший результат побеждает, ровный экран не спрашивают,
re-cut делит бюджет попыток с проекциями).

---

## 27. Restorer: не больше трёх проходов на экран — ✅ ЗАВЕРШЁН

Стадия `reconstruct` делала ровно один заход ИИ на экран: роль называла дефекты, редактор их
чинил, и всё. Если дефектов было больше одного, или если роль в первый раз ошиблась с областью,
экран оставался с половиной проблем — а повторного захода не было.

Теперь у экрана свой бюджет проходов — `stages.reconstruct.maxPasses` (три по умолчанию):

1. **Проход — это полный заход ИИ.** План роли плюс починка названных областей. Не «три вызова
   редактора», а три посещения экрана: в каждом роль смотрит на экран заново и решает, что ещё
   сломано.
2. **Первый проход — по rectified-результату.** Вход стадии — файл, на который указывает
   состояние прогона: это скрин, принятый стадией `rectify`, а если `rectify` ничего не дал —
   исходный crop. Следующие проходы видят результат предыдущих починок.
3. **Область не чинится дважды.** Роль во втором и третьем проходе получает список уже
   починенных областей и просит называть только то, что ещё сломано. На уровне харнесса
   `pickPatches` получает `taken` — список уже закрытых боксов — и отбрасывает patch,
   пересекающийся с ними: второй ответ на тот же вопрос молча затёр бы первый.
4. **`gpt-image-2.6` не видит уже починенных пикселей.** Эта линия перерисовывает то, что ей
   дают, поэтому фрагмент ей режется всегда из rectified-картинки (`prefersStartPicture`), а ответ
   вклеивается в рабочий кадр. `seedream-5-5` сохраняет данные пикселей и спокойно работает по
   уже починенному — он и дочиняет экран.
5. **Геометрия применяется один раз, в конце.** Поворот двигает все элементы экрана, поэтому
   он идёт после всех починок, а не между ними; решение о геометрии принимает последний план,
   который её назвал.

Файлы: `src/stages/reconstruct.js` (`askRestorer` с `pass`/`maxPasses`/`repaired`/`picture`,
`runReconstruct` с циклом проходов, `prefersStartPicture`), `src/stages/restore-plan.js` (опция
`taken` у `pickPatches`), `src/config/defaults.js` (`stages.reconstruct.maxPasses`), проверка
целочисленного поля в `src/config/validate.js`, раздел README «Restoring a screen (reconstruct)»,
тесты `test/reconstruct.test.js` (второй проход, запрет повторной починки, `prefersStartPicture`).

---

## 28. Транспорт batch: журнал ответов, submit и fetch — ✅ ЗАВЕРШЁН

У прокси (proxyapi, sprutdock) есть OpenAI-совместимый маршрут batch: файл запросов уходит
одним файлом, хост работает с ним в фоне (окно 24 ч), ответы приходят отдельным файлом. Скидка
около половины цены, но маршрут **двухфазный**: ответов в момент отправки ещё нет.

Что сделано:

1. **Журнал ответов (`src/openai/journal.js`).** Content-addressed хранилище в рабочем каталоге:
   имя запроса — это хэш его тела (`sha256` от канонического JSON), ответ лежит под тем же
   именем. Каталог: `requests/<hash>.json`, `answers/<hash>.json`, `answers/<hash>.bin`,
   `batches/<id>.json`. Благодаря журналу вторая фаза не платит за то, что уже оплачено, и
   ответ на тот же вопрос находится по хэшу, а не по порядку вызовов.
2. **Транспорт (`src/openai/batch.js`).** `buildBatchJsonl` (строка `{custom_id, method, url,
   body}`), `parseBatchResults` (ответы по `custom_id`; битая строка не роняет пакет),
   `batchEndpointFor` (маршрут из base URL), `submitBatch` (`POST /v1/files` c `purpose=batch` →
   `POST /v1/batches`), `fetchBatch` (опрос `GET /v1/batches/{id}` → `GET /v1/files/{id}/content`).
3. **Клиент (`src/openai/client.js`).** `client.batches` — хосты с флагом, `fetch()`, размер
   очереди. Ответ на запрос ищется в журнале до сети; ответ после обычного вызова кладётся в
   журнал. Байты правок картинок (`images.edit`) тоже кэшируются: правка не часть пакета, но она
   стоит между двумя фазами прогона.
4. **Конфиг.** Секция `batch` (`enabled`, `endpoint`, `window`, `collectMs`, `pollMs`, `waitMs`,
   `maxRequests`, `journalDir`) + флаг хоста `supports: { batch: true }` (`'batch'` добавлен в
   `ENUMS.backendRoutes` и в allow-list `validate.js`), пример в `defaultConfigText()`.

---

## 29. Двухфазный batch на уровне прогона: `--batch` и `--batch-fetch` — ✅ ЗАВЕРШЁН

1. **Только параллельные стадии.** Стадия `reconstruct` переписана: экраны обрабатываются
   параллельно (`Promise.allSettled` по файлам), у каждого экрана свой scratch-каталог, чтобы
   два экрана не писали один и тот же фрагмент. План каждого экрана — один запрос раунда, и
   раунд из нескольких запросов уходит в батч. Один запрос — не батч, он идёт обычным путём.
2. **Submit.** `--batch` собирает запросы раунда, отправляет их одним пакетом и **останавливает
   прогон**: ответов ещё нет. Код выхода — 2, сообщение — «run again with --batch-fetch».
3. **Fetch.** `--batch-fetch` сначала забирает ответы готовых пакетов в журнал, потом продолжает
   прогон. Если пакет ещё не готов — код выхода 3, «run --batch-fetch again later». Продолжение
   может потребовать нового пакета (следующий раунд) — тогда прогон снова останавливается.
4. **Ошибка `BATCH_SUBMITTED` идёт сквозь.** Раннер роли (`src/roles/index.js`) не превращает её
   в «ответ не пришёл», стадия (`src/stages/reconstruct.js`) не превращает её в warning, а
   `runStages` (`src/shared/pipeline.js`) не превращает её в падение стадии — она останавливает
   прогон. Это не ошибка, а ожидание второй фазы.
5. **Откат.** Если хост не умеет батч (404/405/501) или батч не собрался — запросы раунда
   уходят по одному, обычным путём. Прогон не падает.

---

## 30. Документация и тесты batch — ✅ ЗАВЕРШЁН

- README, раздел «Batch (cheaper calls)»: две фазы, журнал, флаг хоста, коды выхода.
- `src/help.js`: флаги `--batch` / `--batch-fetch` и раздел «Batch».
- `test/batch.test.js`: JSONL, разбор ответов по `custom_id`, битая строка, журнал, очередь
  (одиночный запрос — обычный путь, группа — батч, откат батча, `BATCH_SUBMITTED`).

---

## 31. Режим `ai-mode` стадии `rectify`: конфиг и флаг — ✅ ЗАВЕРШЁН

Стадия `rectify` до сих пор умела только одно: роль называет четыре угла, харнесс проецирует
пиксели. Режим `ai-mode` добавляет к этому работу ИИ над reference целиком, но **включается
явно** — по умолчанию поведение прежнее.

1. **Режим стадии.** `stages.rectify.mode`: `geometry` (по умолчанию) или `ai-mode`. Значение
   проверяется в `src/config/validate.js` (`ENUMS.rectifyModes` в `src/config/constants.js`).
2. **Разовый флаг.** `--ai-mode` включает режим на один прогон и перекрывает файл конфига:
   `loadConfig({ overrides: { stages: { rectify: { mode: 'ai-mode' } } } })`.
3. **Ручки режима** (в `src/config/defaults.js`, все проверяются): `straightenAttempts` — сколько
   раз ИИ может выпрямить reference; `maxRepairPasses` — сколько раз ИИ заходит на один экран;
   `maxPatches` — сколько областей одного экрана чинится за один проход; `boxPadding` — поле
   вокруг бокса починки; `quality` — качество ответа редактора; `cleanOverlap` — чистить ли
   overlap внутри этой же стадии.
4. **Порядок работ (вариант B, затем A).** Сначала ИИ выпрямляет reference целиком, потом
   геометрия режет по нему, потом ИИ чинит обрезки. Убирание overlap — **шаг внутри** `ai-mode`,
   а не отдельная подкоманда CLI: отдельная стадия `overlap` в этом режиме не платит за ту же
   работу второй раз.
5. **Приёмка по измерению.** Выпрямленный reference принимается, только если остаточный наклон
   измеримо не хуже исходного; иначе — откат к исходным байтам. Починка обрезка принимается
   только если результат лучше исходного, иначе — откат.

Файлы: `src/config/constants.js` (`ENUMS.rectifyModes`), `src/config/defaults.js` (секция
`stages.rectify`), `src/config/validate.js` (`validateStage` для `rectify`), `src/cli.js`
(`parseArgv`, `main`), `src/help.js` (флаг `--ai-mode`), README (раздел «The AI mode of the
rectify stage»), тесты `test/rectify.test.js` (валидация режима и ручек), `test/cli.test.js`
(флаг), `test/phases.test.js` (у `rectify` теперь есть `mode`, по умолчанию `geometry`).

Попутно исправлены два падения, которые были до этих правок: тесты `test/reconstruct.test.js`
не записывали вызовы редактора (`edits` оставался пустым), поэтому проверка «второй проход не
видит пиксежей первой починки» всегда падала; и в `src/stages/rectify.js` время старта
считалось через `Date.now()` — миллисекунды обрезались, и файл, записанный в ту же
миллисекунду, выглядел файлом текущего прогона и удалялся чисткой каталога вывода
(`performance.timeOrigin + performance.now()`).

Дальше: шаг 32 (выпрямление reference ИИ + приёмка по `measureResidualSkew`), шаг 33 (починка
обрезков ИИ с выбором источника `screen`/`reference` и маппингом бокса через гомографию),
шаг 34 (чистка overlap внутри `ai-mode` и пропуск отдельной стадии `overlap`).

---

## 32. Первая половина режима `ai-mode`: ИИ выпрямляет reference целиком — ✅ ЗАВЕРШЁН

Порядок режима — **вариант B, затем A**: сначала ИИ выпрямляет reference целиком, потом геометрия
режет, потом ИИ чинит обрезки. Этот шаг делает первую часть.

1. **Новый модуль `src/stages/rectify-ai.js`.** Выпрямленный reference лежит в
   `decomposition/straightened/` (`STRAIGHTENED_DIR`) — оригинал не переписывается никогда.
2. **`straightenReference` — приёмка по измерению, а не по мнению модели.** Остаточный наклон
   исходного reference измеряется (`measureResidualSkew`); если картинка уже ровная, ИИ не
   зовётся вовсе. Ответ редактора измеряется так же, и он принимается, только если он **ровнее
   исходника**; иначе файл ответа удаляется, и стадия работает с исходными байтами. Попытка,
   которая не выпрямила, ничего не стоит: лучший из ответов побеждает, худшие удаляются.
3. **Каждая попытка начинается с оригинала.** Как и в геометрии: проекция поверх проекции
   только складывает ошибки.
4. **Нарезка остаётся геометрической.** Роль по-прежнему называет четыре угла, харнесс по-прежнему
   проецирует пиксели — просто теперь это делается на выпрямленной картинке. Стадия
   `runRectify` вызывается как есть, а её `references` и `source` кропов переключаются на
   выпрямленный файл.
5. **Переключатель режима — в реестре стадий** (`src/stages/index.js`): `stages.rectify.mode` решает,
   какая из двух стадий работает. Событие `rectify.straightened` печатается рендерером.

Файлы: `src/stages/rectify-ai.js`, `src/stages/index.js`, `src/cli/renderer.js` (событие
`rectify.straightened`), `src/stages/rectify.js` (чистка каталога вывода по списку файлов, а не по
времени — часы процесса и часы файловой системы не совпадают до микросекунды, и файл, написанный
за мгновение до старта, выглядел файлом текущего прогона), README (раздел «The AI mode of the
rectify stage»), тесты `test/rectify-ai.test.js` (выпрямление принимается, откат при отсутствии
улучшения, ровная картинка не зовёт редактор, попытки начинаются с оригинала, режим выбирается
конфигом).

---

## 33. Вторая половина режима `ai-mode`: ИИ чинит обрезки геометрии — ✅ ЗАВЕРШЁН

Порядок режима — **вариант B, затем A**: сначала ИИ выпрямляет reference целиком, потом геометрия
режет, потом ИИ чинит обрезки. Этот шаг делает вторую часть.

1. **Новая роль `rectifyRepair`** (`src/roles/rectify-repair.js`) и схема `RECTIFY_REPAIR_SCHEMA`
   (`src/agent/schemas.js`): роль называет сломанные регионы экрана, для каждого — инструкцию
   редактору и **источник пикселей**: `screen` (сам экран) или `reference` (оригинал).
2. **Фрагмент из reference.** Углы нарезки известны, поэтому регион экрана переносится обратно на
   reference той же гомографией (`mapBoxToReference`) и режется оттуда (`cutFromReference` →
   `perspectiveRectify`). Размер фрагмента равен размеру рамки, поэтому ответ редактора вклеивается
   обратно без изменения масштаба.
3. **Починка идёт по экранам и по проходам.** Каждый экран спрашивается отдельно (до
   `maxRepairPasses` проходов, до `maxPatches` регионов за проход). Регион, пересекающийся с уже
   починенным, отбрасывается (`pickPatches` и список `taken`), как и вылезающий за кадр или с
   слишком короткой инструкцией.
4. **Приёмка по измерению, а не по мнению.** Ответ редактора вклеивается в свою рамку, и
   проверяющий (`restorerVerify`) сравнивает результат с тем, что было. Ответ не «лучше» — откат:
   экран сохраняет прежние байты, починенный файл не пишется вовсе.
5. **Починенный экран — отдельный файл** (`decomposition/repaired/`, `REPAIRED_DIR`); результат
   геометрии остаётся на месте, а состояние прогона указывает на починенный файл
   (`subReferenceKind: 'repaired'`). Имена файлов не повторяются (`uniqueName`).

Свойство, которое стоит знать и на котором стоит строить тесты: **экран — это ре-проекция
reference**, поэтому фрагмент «из экрана» и фрагмент «из reference» совпадают побайтово, пока
рабочий файл экрана не изменён починкой. Различие проявляется во втором проходе — и именно на
этом построен тест выбора источника: первый проход красит регион синим, второй берёт соседний
регион из reference, и фрагмент обязан остаться серым.

Файлы: `src/stages/rectify-ai.js`, `src/roles/rectify-repair.js`, `src/roles/index.js`,
`src/agent/schemas.js`, `src/stages/repair.js` (`prefersStartPicture` переехал сюда),
`src/stages/restore-plan.js` (`source` у patch'а), `src/image/distort.js` (`applyHomography` стал
экспортом), `src/image/rectify.js`, `src/stages/rectify.js` (`quad` в принятых записях),
`src/stages/reconstruct.js`, `src/cli/renderer.js` (события `rectify.repair.start` и
`rectify.repair.file`), README (раздел «The AI mode of the rectify stage»), тесты
`test/rectify-ai.test.js`.

---

## 34. Убирание overlap внутри `ai-mode` — ✅ ЗАВЕРШЁН

Последняя часть режима: **чистка overlap — шаг внутри `ai-mode`**, а не отдельная подкоманда
CLI. Отдельная стадия `overlap` в этом режиме не платит за ту же работу второй раз.

1. **Работа та же, что у стадии `overlap`.** Внутри `ai-mode` вызывается готовый `runOverlap`
   (`src/stages/overlap.js`): экраны сравниваются попарно, роль называет чужие регионы, харнесс
   режет их, отдаёт редактору и вклеивает ответ обратно в свою рамку. Свой код не дублируется.
2. **Порядок режима.** Выпрямление reference → геометрическая нарезка → починка обрезков →
   **чистка overlap**. То есть отдельная стадия `overlap` в пайплайне (она идёт после
   `reconstruct`) в режиме `ai-mode` оказывается уже сделанной работой.
3. **Пропуск отдельной стадии.** Флаг состояния `state.overlapCleanedInAiMode` ставится, когда
   режим взял чистку на себя. Стадия `overlap` в реестре (`src/stages/index.js`) смотрит на флаг
   и, не задавая вопросов модели, сообщает событием `overlap.skipped`, что работа уже сделана.
   Второй оплаты нет.
4. **Ручка `stages.rectify.cleanOverlap`** (`true` по умолчанию) выключает шаг — тогда стадия
   `overlap` работает как обычно. Снят с неё и флаг пропуска.
5. **Один экран — сравнивать не с кем.** Экранов меньше двух — чистка не нужна, и отдельная
   стадия тоже ничего бы не сказала; пропуск всё равно помечается, чтобы стадия не сыпала
   предупреждением.
6. **Цепочка файлов.** Починенный экран и очищенный экран — разные файлы, и состояние прогона
   указывает на последний: `state.images`, `state.screens`, `state.screensFiles` и
   `state.overlapResolved` ведут всю цепочку (нарезка → починка → чистка).

Файлы: `src/stages/rectify-ai.js` (`cleanOverlap`, вызов `runOverlap`, цепочка файлов),
`src/stages/index.js` (`runOverlapStage` — стадия, которая умеет пропустить себя),
`src/shared/pipeline.js` (флаг `overlapCleanedInAiMode` в состоянии прогона),
`src/cli/renderer.js` (событие `overlap.skipped`), README (раздел «The AI mode of the rectify
stage»), тесты `test/rectify-ai.test.js` (чистка внутри режима, пропуск отдельной стадии,
выключенная ручка).

---

## 35. Копия библиотеки доступа: список файлов и копирование (step-c6) — ✅ ЗАВЕРШЁН

Слой доступа развивается в `u2ai-server`, остальные пакеты получают его копией: правки
идут в `u2ai-server` первыми, `src/access/*` расходится копией.

- `src/access/native.js` — операция `copy` (нативный `cp`, `dereference: false`) и состояние
  пути свойствами (`isDirectory`, `isFile`, `isSymbolicLink`), а не методами Node.js
- `src/access/memory.js` — копирование файла и поддерева в памяти
- `src/access/fs.js` — `listFiles(relative, { depth, limit, includeHidden })` и
  `copy(source, destination, { overwrite })`: правила путей, секреты, запрет симлинков и
  копирования каталога в себя

Файлы: `src/access/fs.js`, `src/access/memory.js`, `src/access/native.js`, README (EN),
planned.md (RU). Проверка: `npm test` — 277 тестов, все проходят.

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
15 клиент seedream-5.5 (после 11: второй источник слоёв)                
16 живой прогресс и длинные запросы (после 3: поток, окна, рендерер)       
 17 любое ребро, коллаж и отчёт о решениях (после 6, 7, 8, 11)            
 18 узкий рез, полоса вдвое больше нужного, резервная модель (после 7, 8, 3)
 19 геометрия и скруглённые углы в restorer (после 9, 4)                   
 20 экономия починки: дешёвое качество и fail-fast (после 9, 10)             
 21 хост без денег: следующий бэкенд, следующая модель (после 3)               
 22 прогон одной стадии на артефактах прошлого прогона (после 12)            
  23 продолжение берёт только файлы последнего прогона (после 22)            
  24 маршрут слоёв: APIMart, seedream-5.5 (после 22)                         
  25 правки после прогона тестов (после 24)                                                           
  26 попытки rectifier'а: три на экран, лучший побеждает (после 8)                                     
  27 restorer: три прохода на экран, без двойной починки (после 9)                                     
  28 транспорт batch: журнал ответов, submit и fetch (после 3)                                         
  29 batch на уровне прогона: --batch/--batch-fetch, параллельные стадии (после 28, 9)                  
  30 документация и тесты batch (после 29)                                                              
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
