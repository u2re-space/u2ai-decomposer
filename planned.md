# План перехода: Universal-AI (монолит 0.2.xx) → @u2ai/decomposer (0.3.xx)

> Актуальный статус: **шаги 1–11 завершены**, следующий — шаг 12 (pipeline-обвязка).
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
- [x] Отличие от монолита: разложение на слои сделано через роль и локальный кроп, а не
      портом клиента seedream-5.5 (`src/openai/seedream-5-5.js`) — такого клиента в
      новом пакете нет, а порт vendor-специфичного API вынесен в шаг 14.

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
