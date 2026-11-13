Будем поэтапно переходить из монолитного к модели модульному, в несколько CLI ИИ/агентных утилит (и новое поколение `0.3.xx`).

И первый этап будет `u2ai-decomposer` (лежит в `submodules/u2ai-decomposer`, его проект `https://github.com/u2re-space/u2ai-decomposer`), туда портируются идеи которые до этого не смогли реализовать...

Из новых фич будет...
- Свой конфиг
- Своя под-система ИИ
- Свои роли и функции
- Свой набор инструментов
- Даже рефакторинг из SRC (попутно, туда)

Новый pipeline...
- Extend reference image (например `original.png` расширится сверху и снизу)
- Crop to screens
- Rectify (un-rotate, recover projections, etc.) those screens (by image-magick or/and by AI-processing)
- Restore lost details of rectified results (that made by image-magick)
  - Or remove overlap elements from/by other screens

Поэтому предлагаю портировать из `src/*` (и возможно и `archive/*`) к `submodules/u2ai-decomposer` как уже отдельный CLI проект.
