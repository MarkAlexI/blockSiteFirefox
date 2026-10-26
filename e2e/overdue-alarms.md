# Прострочені таймери після паузи браузера

2026-10-26. Тестове доповнення до **5.4.15**, без зміни runtime-версії.
База Chromium: `a7754bfae4013be785bf1a3cb602b62fb326696c`;
Firefox: `d9b0dbe56793edc23cbe6cd67c8cbb250e5c30a6`.

## Що доводить сценарій 65

`overdue-scenarios.mjs` виконує дві фази в одному ізольованому профілі:

1. Справжній runtime-запит починає хвилинний Focus; реальний контролер
   зберігає майбутній хвилинний розклад і створює alarms. Усі процеси браузера
   зупиняються до початку occurrence і відновлюються після її завершення.
   Перевіряються одна natural completion, відсутність повторної активації,
   незмінний розклад/claims, наступний майбутній alarm і дозволена навігація.
2. Видима HTTP-вкладка встановленого розширення створює справжній Daily Limit
   segment/deadline. За бюджету 45/60 секунд весь браузер зупиняється на
   95 секунд. Після справжнього overdue alarm ліміт ще не вичерпаний; новий
   deadline відповідає залишку. Подальший реальний foreground час доводить
   бюджет до 60 і перевіряється native DNR navigation з `reason=daily_limit`.
   Інший профіль зберігає 840 секунд, правила та journal не змінюються.

Сторінка Options лише читає storage/DNR та слухає native events. Після
пробудження тест не викликає force-sync, не емітує alarms, не підміняє Date,
visibility, API results чи production callbacks. Порядок alarms записується,
але не нав'язується. Перестановки callbacks уже мають окремі API-model тести.

## Контроль процесів

`pause-owned-browser.py` перевіряє ancestry від runner і точний профіль у
командному рядку, розрізняє PID namespaces, закріплює кожен PID через pidfd,
зупиняє дерево SIGSTOP та перевіряє `T`, start identity й незмінні CPU ticks.
Власний watchdog відновлює pinned процеси SIGCONT навіть при частковому
збої або втраті runner. Один stop обмежений 180 секундами. Сигнали не
надсилаються за назвою процесу; системний чи особистий браузер не вибирається.
Потрібні Linux, Python >= 3.9 та kernel pidfds. Окремі Node controls перевіряють
справжнє дерево parent/child, неправильний профіль/PID/duration і перерваний
stop з обов'язковим cleanup.

## Отримані докази

- `npm run check`: Chromium **2232/2232**, Firefox **2210/2210**, 0 skips;
  extension validation і 70 palette checks успішні.
- Firefox Developer Edition **158.0b2**, geckodriver **0.37.1**, Linux x64,
  Node **24.22.1**, headless, persistent unsigned development installation:
  сценарій 65 пройшов, **1 passed / 0 failed**, body started. Увесь Firefox
  suite цим локальним запуском не перевірявся.
- Фактичні hold: **111943.6 ms** для Focus/розкладу, **95001.6 ms** для Daily
  Limit. Usage до/після паузи: **45 → 45**, потім **60** від awake time;
  інший профіль: **840 → 840 → 840**. DNR: `[] → [] → [902]`.
- Спочатку контейнерний procfs показував зовнішні PID, тому рання версія
  helper не знайшла browser PID і завершилася до STOP. Виправлено саме
  namespace resolution; наступний запуск перевірив справжню зупинку дерева.
- Chromium for Testing **151.0.7922.34**, повний офіційний ZIP з перевіреним
  digest/CRC: запуск зупинився **до scenario body** на
  `ProcessSingleton: socket() failed: Operation not permitted`. Native
  Chromium assertions і числові результати startup measurement локально
  не підтверджені; потрібен Linux CI.

## Межі: process pause і сон ОС

Це **процесна пауза**, а не справжній sleep/hibernate пристрою. Вона перевіряє
доставку прострочених таймерів і відновлення реального встановленого runtime.
Browser clocks, kernel power notifications, Android lifecycle та зміна
timezone/північ/DST під час сну залишаються окремими перевірками.

У production уже є `MAX_ACCOUNTING_GAP_MS = 90000`: більша перерва
відкидається. Коротша пауза без native visibility/focus boundary може виглядати
як звичайний foreground interval. Цей патч не доводить виключення кожної
короткої sleep-паузи. `performance.now()` не є універсальним sleep detector:
його ticking під час сну відрізняється між ОС. Підтвердженого device-specific
дефекту чи достатнього нового сигналу для runtime-зміни цей аудит не отримав.

Для справжньої device acceptance: на окремому тестовому профілі повторити
Focus + пропущений розклад і Daily Limit після 2–3 хвилин sleep; додатково
перевірити 20–40 секунд sleep без закриття активної вкладки. Зафіксувати ОС,
browser/version, usage до/після, visibility/focus events, alarm order, DNR та
навігацію. Firefox Android перевіряти на самому пристрої; desktop не є доказом.

## Запуск і CI

Chromium: `cd e2e && BD_E2E_GROUP=overdue xvfb-run -a npm test`.
Firefox: `cd e2e && BD_E2E_GROUP=overdue xvfb-run -a npm run test:headed`.
Для локального headless Firefox: `npm test -- --filter=65`.

Chromium CI: **53 core + 10 lifecycle + 1 overdue = 64**. Firefox:
**63 core + 1 overdue = 64**. Групи ізольовані; спільний required check `e2e`
залежить від успіху всіх груп. Попередні job/step deadlines і retries
збережені. Новий довгий тест не додає чотири хвилини до Firefox core, який
на базовому commit уже займав приблизно 22 хвилини з 25.

## Джерела та історичні застереження

- [Chrome alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms):
  missed alarms після device wake; повторний alarm доставляється щонайбільше
  один раз; unpacked timers відрізняються від store throttling.
- [MDN alarms](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/alarms):
  Firefox alarms не зберігаються між browser sessions; restart і process pause
  потрібно розрізняти.
- [MDN performance.now](https://developer.mozilla.org/en-US/docs/Web/API/Performance/now#ticking_during_sleep):
  OS-dependent ticking під час сну.
- [Дискусія Chromium Extensions, 16 квітня 2022, wOxxOm та інші](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/u82xI5SrOh0):
  історичне застереження щодо console/unpacked timing і тодішньої хвилинної
  межі. Стару межу не перенесено в поточний контракт; актуальна документація
  Chrome описує 30 секунд і можливі додаткові затримки.
