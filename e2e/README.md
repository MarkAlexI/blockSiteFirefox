# Firefox Desktop E2E — BlockDistraction **5.3.20**

Окремий Selenium/WebDriver runner для нативного Firefox. Він відповідає
19 сценаріям Chromium E2E та окремій перевірці Firefox consent. Використовує Firefox event page, `browser.*`,
`moz-extension://` і WebDriver BiDi. Playwright Firefox не використовується
для встановлення WebExtensions.

У 5.3.20 виправлено відкладений autofocus у Options і застарілі
refresh/callback вставлення рядків у Popup. Підготовлене покриття не означає успішного E2E:
фактичний результат кожного запуску міститься в `results.json`.

## Повний запуск

Потрібні Node.js >=22, Firefox Developer Edition або Nightly, geckodriver
і OpenSSL 3 на PATH. `BD_OPENSSL` задає абсолютний шлях до OpenSSL, якщо
його немає на PATH; для Git for Windows це може бути
`C:\Program Files\Git\usr\bin\openssl.exe`.
CI закріплено на Developer Edition 158.0b2 та geckodriver 0.37.1 із перевіркою
SHA-256 офіційних завантажень. Selenium 4.50.0 і fflate 0.8.2 закріплені lockfile.

```bash
cd e2e
npm ci
export BD_FIREFOX_BINARY=/absolute/path/to/firefox
export BD_GECKODRIVER=/absolute/path/to/geckodriver
npm run test:list
npm run test:headed
```

Приклад PowerShell для Developer Edition:

```powershell
cd e2e
npm ci
$env:BD_FIREFOX_BINARY = 'C:\Program Files\Firefox Developer Edition\firefox.exe'
$env:BD_GECKODRIVER = 'C:\Tools\geckodriver.exe'
$env:BD_OPENSSL = 'C:\Program Files\Git\usr\bin\openssl.exe'
npm run test:headed
```

Указуйте свої фактичні шляхи. Runner створює новий профіль для кожного
сценарію й видаляє його після перевірки. Особистий Firefox-профіль не
використовується. Для 05/06/20 зберігається той самий тестовий профіль між
двома процесами браузера; додаток після restart не перевстановлюється.

За замовчуванням `BD_INSTALLATION=persistent`. Для unsigned test XPI runner
ставить `xpinstall.signatures.required=false` тільки в новому тестовому
профілі. Це офіційно підтримуваний режим розробки в Developer Edition/Nightly;
звичайний Release Firefox його не підтримує. Захист процесів браузера й
ізоляція sandbox не вимикаються.

Звичайний Firefox Release може виконати повний набір із підписаним AMO XPI
саме версії 5.3.20: установіть `BD_SIGNED_XPI=/absolute/path/to/target.xpi`.
Цей файл є фактичним target для всіх сценаріїв; `BD_EXTENSION_PATH` тоді
не використовується. Runner перевіряє version, ID та event-page manifest,
але підписаний XPI може мати інші runtime-байти. Саме його потрібно
зазначати як протестований артефакт.

Для unsigned XPI у Release можливе `BD_INSTALLATION=temporary`, але
05/06/20 отримають статус `blocked` і весь набір поверне exit code 1.
Тимчасове встановлення не підміняє перевірку restart повторним встановленням
додатка чи збереженням storage через спеціальні keep-on-uninstall prefs.

```bash
npm run test:headed
npm test -- --filter=05
npm test -- --max-failures=1
```

`--filter` приймає ID або частину назви. Відфільтрований запуск має
`completeSuite=false`; його результат не підтверджує весь набір.
Повний набір із нативним consent prompt запускайте у headed Firefox.
CI використовує `xvfb-run -a npm run test:headed`; на Linux без GUI потрібні
`xvfb` та `xauth`. Headless можна використовувати для окремих сценаріїв,
але він не підтверджує взаємодію з видимим системним permission panel.

## Відповідність Chromium

| ID | Спільний сценарій | Перевірка Firefox |
| --- | --- | --- |
| 01 | Два Options, одночасні додавання | Два нативні runtime callers, обидва UI, унікальні ID, DNR і redirect |
| 02 | UI split спільного Daily Limit | 840 секунд збережено, старий scoped key прибрано, обидва UI, реальний redirect |
| 03 | Stale split/move з v1 до migration | Одна з двох дій з однаковою revision відхиляється; після refresh/retry обидва assignments успадковують 840 секунд |
| 04 | UI delete та JSON import | Нативний file input, usage cleanup, обидва Options, DNR і navigation |
| 05 | Durable remap journal після restart | Чистий restart того самого профілю, recovery й exhausted budget |
| 06 | Mixed v1/scoped startup migration | max legacy/scoped після restart, DNR і blocked reason |
| 07 | Foreground accounting та deadline | Справжній час, видима вкладка й нативний `browser.alarms` |
| 08 | Hidden/foreground resume | Нативна visibility, 6 секунд pause й 2 секунди resume |
| 09 | Activation у процесі verification | HTTP mock утримано, Free діє, paid відхилено до commit, UI оновлюється |
| 10 | UI logout без reload | Обидва Options стають Free, наступний paid intent відхилено, basic block працює |
| 11 | Paid commit перед logout | Нативний `storage.onChanged`, порядок rules→Free без штучного manager hook |
| 12 | Trusted Legacy після logout | Збережена installationDate, paid controls і Daily Limit залишаються доступними |
| 13 | Тимчасовий verification HTTP 500 | Pro/key збережено, наступний paid intent працює |
| 14 | Payment suspension → manual recovery | Та сама збережена ліцензія; General лишається активним, cross-list Focus DNR відновлюється до відповіді, два Options стають Pro |
| 15 | Payment suspension → native alarm | Справжній `check_pro_expiry` alarm і HTTP mock; key, rules, profiles, settings збережено, інший профіль знову блокується |
| 16 | Deferred DNR sync → native retry | Oversized fixture перевищує фактичний browser capacity; `syncPending=true` і Pro/key збережено; після виправлення fixture нативний `update_scheduled_rules` відновлює DNR |
| 17 | Native consent deny → grant | WebDriver активує справжні кнопки Firefox prompt клавішею Space; denial не надсилає key і зберігає Pro, grant відкриває verification без telemetry consent |
| 18 | Readers: delete/import × 3 | Три послідовні цикли без retry сценарію; два Options і Popup, usage/journal cleanup, DNR і navigation |
| 19 | Readers: concurrent/chained move | Два незалежні move, потім fresh move; прийняті й сторонній бюджети збережено, усі три UI та DNR узгоджені |
| 20 | Readers: expired-day restart | Учорашній usage + pending remap; чистий restart, сьогоднішній бюджет, UI/DNR та облік нового foreground segment |

01/03 використовують одночасні runtime messages з двох справжніх Options,
а не одночасні фізичні натискання. UI add/edit/delete/import та Pro actions
в інших сценаріях виконуються нативними WebDriver clicks/keys/select/file input.
BiDi reads та runtime calls адресуються конкретній сторінці й не активують
вкладку: accounting polls не забирають foreground у сторінки, що вимірюється.
Для foreground та UI-кліків використовується classic WebDriver
`switchTo().window()`: Firefox BiDi не підтримує activation для privileged
`moz-extension:` сторінок.
Після закриття початкових вкладок runner вибирає живу probe-вкладку.
Якщо Classic WebDriver має discarded current context, `NoSuchWindowError`
дозволяє перейти до цільової вкладки; інші driver errors не перехоплюються.
Після активації Options runner чекає 500 мс без DOM-змін у таблиці та
списку профілів: `visibilitychange` запускає асинхронний refresh. Observer
лише читає зміни й не підміняє production callbacks. Повторне натискання
дозволене тільки після `StaleElementReferenceError`, коли WebDriver відхилив
дію до її виконання; максимум три спроби, кожна відображена у `uiRetries`.
Успішні кліки та сценарії не повторюються.
Для controls усередині Pro-панелі native click також чекає завершення
CSS-анімації `max-height` і повного розгортання контейнера. Наявність кнопки
в DOM сама по собі не означає, що Firefox може прокрутити її у видиму область.
Очікування читає geometry/animations, після нього виконується один native click.
`clickUnsettled`/`activateUnsettled` keyboard-focus regression лишаються без цієї паузи.
Delete/import перевіряє завершення usage cleanup окремим bounded poll:
спостереження rules/DNR storage ще не означає завершення post-commit задач.

## Календарний smoke (32–34)

Повний CI-набір містить 41 Firefox Desktop сценарій. Окремий Linux запуск:

```sh
xvfb-run -a npm run test:headed -- --filter='calendar smoke'
```

32 змінює процесний `TZ` з UTC на UTC+1 через чистий restart того самого
профілю: key та revision незмінні, absolute start інший. Старий Skip має
повернути `schedule_changed`, storage не змінюється, alarm переозброєно.
33 змінює UTC−12 на UTC+14: локальний occurrence key також змінюється.
Обидва сценарії перевіряють свіжий Skip через UI і його збереження після
наступного restart без повторного seed. TZ передається в середовищі
geckodriver та `moz:firefoxOptions.env`; перевіряється фактичний TZ процесу
Firefox. Date/Date.now та browser API залишаються нативними. Timezone
і offset звіряються в Options та справжній Firefox event page.

34 імпортує production `focusSchedule.js` у реальний браузер із процесним
`TZ=America/New_York`. Фіксовані instants є аргументами календарного модуля:
gap 02:30 пропускається, fold 01:30 має один key/start, handled і skipped
key ведуть на наступний тиждень. Це native Date/Intl integration, а не
очікування живого DST чи перевірка доставки alarm під час DST.
Покриття процесного TZ наразі призначене для Linux CI; інші OS потребують
окремого підтвердження. Невідповідність timezone в будь-якому realm є падінням.
32–34 потребують persistent installation; temporary має статус blocked.

## Daily Limit day-boundary smoke (35–36)

Повний набір реєструє ще два persistent сценарії. Окремий Linux запуск із
каталогу `e2e`:

```sh
xvfb-run -a npm run test:headed -- --filter='day-boundary smoke'
```

| ID | Native перевірка |
| --- | --- |
| 35 | Timezone змінюється, локальний day key залишається: journal одноразово переносить фактично накопичений foreground usage; exhausted budget і native DNR зберігаються після двох restart. |
| 36 | Date-line A-to-B-to-A: старі counters та journal з активним lastSample очищуються при зміні дня; новий foreground segment обліковується окремо; повернення до попереднього дня не відновлює жоден старий бюджет. |

В обох сценаріях Date/Intl перевіряються в Options і background. Один
disposable profile та storage marker переживають кожний restart без reseed.
Два Options і Popup reader показують committed assignments, точні budgets
та exhausted state; справжня navigation перевіряє DNR. Native recovery alarm
має бути відновлений. У 35 foreground segment завершено перед restart, тому
usage після recovery мусить збігтися точно; це не перевірка suspend активного
segment. У 36 збережений lastSample походить із фактичного активного segment.

Pending journal — durable post-commit fixture, записаний через native storage,
а не штучно індукований crash між production writes. Day key змінюється через
process TZ при clean restart, без Date override чи ручного виклику listener.
Жива північ, timezone change без restart, короткий suspend активного segment,
automatic idle unload і Android suspend/resume залишаються окремими кроками.

## Scheduled Focus expiry smoke (37–38)

Ці два persistent сценарії затримують **повернення** одного справжнього API
в background після його виконання. 37 утримує session read до durable claim;
38 утримує завершений claim write. Нативний Scheduled Focus alarm доставляється
у хвилинному occurrence; Date/Date.now/Intl та результати API не підміняються.
Тест чекає фактичного endTime, звільняє delivery і ставить незмінений save у
production transition queue як barrier завершення reconcile.

| ID | Обов’язкова перевірка |
| --- | --- |
| 37 | Після expiry немає handled key, жодної transient Focus activation чи Focus DNR; наступний occurrence має точний native alarm. |
| 38 | Claim уже збережений перед hold; після expiry немає transient Focus/DNR; той самий claim і schedule переживають restart профілю без reseed. |

Спостерігач записує storage write/commit, справжні storage.onChanged, native
DNR update arguments і rules після commit, доставлені alarms та час gate.
Позитивний контроль через ручний Focus start/stop мусить показати activation
обом спостерігачам до очищення history для основного сценарію. Перевіряється
вся history, а не лише фінальний eventually. Browser API errors лишаються
помилками; held delivery та observers відновлюються у finally.

Background heartbeat читає справжній storage під час контрольованого wait.
Це перевірка expiry всередині живого background, а не automatic idle unload,
OS suspend/resume, зміна timezone під час wait або Android. Restart чистий;
history стосується індукованого wait до закриття браузера. Після restart
перевіряються durable claim, schedule, Focus state, DNR, alarm і navigation.
Окремий timeout 240 секунд охоплює native запуск, до 75 секунд до start,
хвилинний occurrence та restart; retries вимкнено.

Окремий Linux запуск із каталогу `e2e`:

```sh
xvfb-run -a npm run test:headed -- --filter='scheduled expiry smoke'
```

## Межі перевірки

Початкові rules/credentials/usage/journal задаються через справжній
`browser.storage`. Нативні runtime, storage, DNR, tabs, scripting, alarms, permission API та
реальний годинник не підмінюються. Для кнопок системного consent prompt runner
використовує Firefox chrome context через geckodriver `--allow-system-access`.
Клавіша Space через WebDriver адресована справжньому HTML `buttonEl` усередині
`moz-button`; перед введенням перевіряються visibility та enabled, після нього —
trusted click від клавіатури. Pointer hit test не використовується для окремого
віджета popup. Import confirm приймає нативний `unhandledPromptBehavior=accept`;
BiDi-подія лише записується, без повторної команди `handleUserPrompt`.
Це привілейований доступ лише до нового тестового профілю на loopback;
особистий браузер не підключається. Browser sandbox залишається увімкненим.
09/13/14–16 приймають фактичний prompt; 17 перевіряє відмову та наступну згоду.
Старі Firefox без native data-collection consent не є цільовим середовищем
цього desktop набору; legacy fallback лишається в Node regression suite.

Синтетичні `.bd-e2e.test` HTTP-сторінки та незмінений verification URL
`https://blockdistraction.com/api/verifyKey` обслуговує локальний HTTP/HTTPS
проксі на `127.0.0.1`. HTTPS CONNECT допускається лише для
`blockdistraction.com:443`; TLS-сервер приймає тільки точний verification
path. Інші адреси відхиляються, пересилання назовні відсутнє, зокрема на
startup і restart. Background `fetch`, DNR та HTTP/TLS залишаються нативними.

OpenSSL створює окремі CA та server key/certificate для кожного тимчасового
сценарію. Runner імпортує CA через Firefox chrome context лише до нового
тестового профілю й перевіряє її SSL trust. `acceptInsecureCerts=false`;
перевірка TLS hostname та certificate chain не вимикається. Профіль, ключі
та CA видаляються після сценарію, у системне сховище CA не додається.

Проксі читає фактичний JSON POST і перевіряє точні dummy key
`BD-E2E-VALID-KEY` та target manifest version. `verificationCalls` записуються
до відповіді сервера, тож hold/release перевіряє справжнє очікування HTTP.
Відповіді 200/500 та recovery задає scenario handler. Невідповідний payload
є помилкою набору. TLS handshake errors додаються до діагностики.

BiDi використовується для читання сторінок, runtime calls та діагностики UI;
network interception і підписка на network events відсутні. Firefox BiDi
не забезпечує interception background WebExtension requests, а його
`context is null` відомий у Mozilla bugs 2048133/2049350. Production backend,
реальні ліцензії, Paddle та купівлі цим набором не перевіряються.

05 починається із заданого durable post-commit/pre-recovery journal і
перевіряє чистий restart, а не штучно викликаний crash. Сценарій 39 окремо
перевіряє автоматичне idle-вивантаження Firefox event page; Scheduled Focus
crash tradeoff не перевіряється. H1 stale post-commit prune у production залишається
непідтвердженим; цей E2E-патч не є доказом його досяжності.

Popup у 18–20 — справжня `index.html` сторінка розширення у вкладці. Це
не перевірка lifecycle toolbar Popup. Expired-day fixture не замінює Date
та не доводить живу північ. 35–36 перевіряють process timezone restart із
foreground usage/pending remap; live timezone change всередині pending API
wait не покрита. 32–34 перевіряють календар Scheduled Focus.

Firefox Android потребує окремого ручного проходу. Desktop Firefox E2E
не підтверджує Android, Chromium, Edge або Kiwi.

Deferred-sync сценарій перевіряє реальний browser capacity через oversized
fixture, а не всі можливі API rejection чи OS failure. Ані DNR methods, ані
alarm delivery не замінено doubles. Наступний retry — фактичний native alarm,
запланований у тимчасовому профілі, без виклику production listener вручну.

## Автоматичне idle-вивантаження Firefox event page (39)

Сценарій закриває всі extension views, включно зі службовим Popup reader,
і залишає одну вкладку `about:blank`. Marionette читає лише браузерний
parent process: `WebExtensionPolicy` та observer
`extension:background-script-status`. Toolbox не під'єднується;
`terminateBackground`, restart, heartbeat, extension API polling та зміна
`extensions.background.idle.timeout` під час idle не використовуються.

Focus починається через справжній UI за 6–10 секунд до native minute tick.
Після tick лишається понад 45 секунд до `end_focus_session`, який має бути
раніше кожного іншого native alarm. Потрібні natural unload через 25–45
секунд, спостережуваний `stopped` без views щонайменше секунду та перший wake
не раніше Focus alarm і до наступного конкурентного alarm. PID, справжній
шлях профілю та keeper не змінюються. Несподіваний wake або відсутній unload
падають, а не перетворюються на чистий restart.

До відкриття UI read-only snapshot із native storage.local/session та DNR
backend мусить показати завершений Focus, DNR `[21]`, незмінні 840 секунд,
rules/profiles/revisions і порожній remap journal. Це перевірка eventual
завершення cold handler; вона не доводить відсутності коротких stale-станів
усередині handler. Після wake новий background global не містить sentinel,
а native session storage його зберігає. Reopened Options/Popup reader,
alarms, credentials та реальна blocked/allowed navigation теж перевіряються.
Це Popup reader у вкладці; toolbar Popup покрито окремими сценаріями.

`native-idle-wake.json` зберігає timestamp history, parent-state samples,
native alarms, PID/profile, cold state та identity до/після wake; файл
записується й при падінні. Observer прибирається у `finally`. Node-тести
перевіряють protocol model для pinned background, раннього stop/wake,
відсутнього wake, конкурентного alarm, заміни браузера/профілю/keeper та
помилок спостереження. Вони не замінюють native сценарій.

Запуск із каталогу `e2e`:

```sh
xvfb-run -a npm run test:headed -- --filter=39
```

Офіційний контракт і релевантна історія:

- https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts
- https://extensionworkshop.com/documentation/develop/debugging/
- https://searchfox.org/firefox-main/source/toolkit/components/extensions/parent/ext-backgroundPage.js
- https://bugzilla.mozilla.org/show_bug.cgi?id=1905505 — native wake/idle timer bug, виправлений у Firefox 129 та ESR 128.

Новий сценарій не підтверджує Firefox minimum 113, Android 120, macOS,
OS suspend/resume або живу зміну дня. Runtime та source version 5.3.20
не змінено.

Підготовлений патч до `fbed5432be3465747c0fedf409a36ddf5349099f` пройшов
`npm run check`: 1560/1560 та extension validation. Новий сценарій пройшов
окремо у headed Linux Firefox 158.0b2/geckodriver 0.37.1: unload через
30 секунд, wake через 50.873 секунди, global очищено, session збережено.
Native fault control із навмисно пропущеним durable завершенням Focus
упав на cold-state assertion до відкриття UI. Під час підготовки виправлено
десеріалізацію session holder у probe зі збереженням його native даних;
початкові падіння probe не були runtime-регресією. Після коміту
`201ec6480645bb3efdf6140bda3b60b5b5f5378e` повний native CI
`37848223306` підтвердив 38/38, усі 38 bodies виконані; Extension CI теж зелений.

## Жива зміна локального дня під час durable remap wait (40)

Один Firefox-сценарій змінює нативний Date/Intl timezone у живому background
та reader views, поки delivery завершеної native journal write ще утримано.
Delete Study — справжній runtime intent з Options: обидві Daily Limit
assignments і active profile уже durably переміщено в General, journal
містить дві remap-записи, а storage ще має старі 120/840 секунд і справжній
активний `35:list-1` sample. Сам native `storage.local.set` виконується;
wrapper затримує лише Promise completion, не підміняє дані чи API errors.

Спочатку same-day позитивний контроль проходить той самий wait і зберігає
840 секунд, remap та foreground usage. Основний прохід змінює timezone
з GMT−12 на GMT+12: date key змінюється при тому самому `Date.now`, background
global, BrowsingContext, PID і профілі. Native recovery мусить очистити
старий exhausted budget; native foreground events починають і закривають
новий короткий segment. A→B→A не відновлює старі counters/assignment keys.
Перевіряються usage-write history, порожній journal, DNR, Options/Popup
reader та справжня allowed navigation на раніше exhausted URL.

Firefox BiDi `emulation.setTimezoneOverride` застосовується до reader tabs
через `userContexts: ['default']`, але в перевіреному Firefox 158 не зачіпає
приховану event page; її context ID через цей command повертає `no such frame`.
Для event page Marionette у browser chrome встановлює Gecko
`BrowsingContext.timezoneOverride` — те саме нативне поле, яке пише BiDi.
Date/Date.now та Intl залишаються native; їхні фактичні offset/date key
перевіряються до та після переходу. Override прибирається у `finally`.

Це **native timezone emulation**, а не зміна OS timezone, рух системного
годинника, жива північ, DST alarm delivery або OS suspend/resume. Extension
views тримають event page живою; idle unload покрито сценарієм 39. Цей
сценарій не перевіряє Scheduled Focus API wait, Android, macOS або minimum
Firefox 113. Runtime та source version 5.3.20 не змінено. Читачі/DNR
перевіряються після завершення recovery; короткий stale render під час
самого переходу не виключено. Usage-write history окремо відхиляє replay
старого дня або бюджету після переходу.

`native-live-day.json` записує clocks, native context/PID, durable journal
snapshot, API gate/stack, same-day control, usage writes та фінальні стани.
Node-тести probe перевіряють commit до gate, native error propagation,
passthrough інших writes та відновлення pending delivery у cleanup.

Запуск із каталогу `e2e`:

```sh
xvfb-run -a npm run test:headed -- --filter=40
```

Підготовлений патч до `201ec6480645bb3efdf6140bda3b60b5b5f5378e`:
1563/1563 та extension validation. Новий native сценарій пройшов окремо
в headed Linux Firefox 158.0b2/geckodriver 0.37.1. Native fault control,
який навмисно зберігає old-day budget/sample у normalization, упав на
`old exhausted budget is cleared after native journal recovery` (840 ≠ 0).
Повний native CI `37907084798` на
`21de3b61aaeff18bba763ae95318aa9ae36522c1` підтвердив 39/39,
усі 39 bodies виконані.

Офіційні джерела механізму та меж:

- https://www.w3.org/TR/webdriver-bidi/#command-emulation-setTimezoneOverride
- https://bugzilla.mozilla.org/show_bug.cgi?id=1978027 — BiDi timezone override, Firefox 144.
- https://github.com/mozilla-firefox/firefox/blob/main/remote/webdriver-bidi/modules/root/emulation.sys.mjs
- https://github.com/mozilla-firefox/firefox/blob/main/remote/webdriver-bidi/modules/root/_configuration.sys.mjs

## Кілька native alarms після idle unload (41–42)

Два сценарії починають ручний Focus через UI, зберігають durable schedule
fixture і через справжній `browser.alarms.create` призначають один timestamp
для `end_focus_session`, `start_scheduled_focus` та `update_scheduled_rules`.
Minute alarm залишається періодичним. У 41 timestamp збігається з реальним
кінцем хвилинного Focus; у 42 це completion fixture зі старим timestamp,
ранішим за кінець новішої трихвилинної Hardcore-сесії. Порядок створення
alarms між сценаріями різний; assertion не вимагає певного порядку доставки.

Усі extension views закриваються, залишається `about:blank`. Потрібні
автоматичний unload із незмінним idle timeout 30 секунд, спостережуваний
`stopped` без views та перший wake на timestamp batch до сторонніх alarms.
PID, профіль і keeper незмінні. Немає restart, debugger, heartbeat,
ручного виклику alarm listener чи extension API polling під час idle.

Parent observer додається до вже кешованого native alarm API, а не до
extension `onAlarm`. Він записує реальну послідовність native timer callbacks.
Окремий parent storage observer десеріалізує справжні committed зміни.
Observer native DNR manager викликає оригінальний `setDynamicRules` і
синхронно записує кожний застосований ruleset, зберігаючи його return value;
Promise delivery та timer dispatch не затримуються. До основного проходу
обидва observers мусять побачити справжню UI activation і Focus DNR.
Observers переживають unload та прибираються у `finally`; недоступний native
backend чи втрачений observer — помилка, без fallback на mock events.

| ID | Cold state та вся спостережувана history до відкриття UI |
| --- | --- |
| 41 | Прострочена schedule occurrence не активується й не отримує claim. Старий Focus durably завершується один раз; completion count збільшується на один, кожний cold DNR commit має лише exhausted Daily Limit `[21]`, наступна occurrence має точний alarm. |
| 42 | Stale completion не записує нічого у новішу ручну Hardcore-сесію. Поточна schedule occurrence отримує один durable claim без activation; кожний cold DNR commit зберігає Focus `[21,22]`, completion count незмінний, справжній session end і наступна occurrence переозброєні. |

В обох випадках 840 секунд, порожній journal, rules/profiles/revisions та
native session token зберігаються. Новий background global втрачає memory
sentinel. Після cold assertions reopened Options/Popup reader і справжня
blocked/allowed navigation підтверджують стан; повторне читання UI не
повторює claim чи activation. Popup тут — reader у вкладці.

`native-alarm-wake.json` містить native delivery order, parent lifecycle
samples, позитивний контроль, storage/DNR history, cold state та alarms.
Він зберігається і при падінні. Protocol-model тести окремо відхиляють
коротку activation, overwrite ручного Focus, неправильний DNR ruleset чи
втрату budget, навіть якщо фінальний snapshot уже правильний.

Запуск із каталогу `e2e`:

```sh
xvfb-run -a npm run test:headed -- --filter='native alarm batch'
```

Це справжні browser timers після автоматичного event-page idle, без зміни
годинника чи навмисного утримання callback. OS sleep/resume та накопичення
alarms під час сну цим не перевірені. Native сценарії записують фактичні
три delivery; усі 24 перестановки чотирьох overdue alarms, включно з
Daily Limit deadline, залишаються окремими production-module API-model
тестами. Повний CI на базі `21de3b61aaeff18bba763ae95318aa9ae36522c1`
підтвердив попередні 39/39; новий набір має 41 сценарій і потребує CI після
коміту. Runtime і source version 5.3.20 не змінено.

Первинні джерела для native observer та меж контракту:

- https://github.com/w3c/webextensions/issues/1107 — порядок overdue delivery обговорюється; гарантія порядку для однакових timestamps не встановлена.
- https://searchfox.org/firefox-main/source/toolkit/components/extensions/parent/ext-alarms.js
- https://searchfox.org/firefox-main/source/toolkit/components/extensions/ExtensionCommon.sys.mjs
- https://searchfox.org/firefox-main/source/toolkit/components/extensions/ExtensionStorageIDB.sys.mjs
- https://searchfox.org/firefox-main/source/toolkit/components/extensions/ExtensionDNR.sys.mjs

## Результати й CI

`results.json` містить `passed/failed/blocked/not-run`, `bodyStarted`, phase,
помилку, target і browser capabilities. У `test-results/<ID>/` зберігаються
geckodriver logs, screenshots Options, final state, HTTP mock events та
JavaScript/fixture errors та фактичні verification POST payloads. `driverPorts`
записує різні порти WebDriver, Marionette і BiDi. Вони виділяються одночасно
на loopback перед запуском через публічний Selenium `DriverService`; це
усуває вибір одного порту для HTTP geckodriver та BiDi WebSocket. Після restart є артефакти до й після нього.
Це Selenium diagnostics, а не Playwright trace viewer archive.

`BD_E2E_RESULTS` і `BD_E2E_JSON` задають інші місця результатів.
`BD_EXTENSION_PATH` вибирає unpacked AMO runtime target;
`BD_EXPECTED_VERSION` за замовчуванням береться з `manifest.json` поточного checkout.
Runner і перевірка пакета використовують одне значення з `target-version.mjs`.
Для підписаного XPI іншої версії override задають явно; це не підтверджує
сумісність сценаріїв із тією версією.

Помилка setup зупиняє решту набору як `not-run`. `blocked` чи `failed`
повертає exit code 1. Повне green можливе лише коли всі 42 scenario bodies
виконані та пройшли. Запуск із `--filter` повертає результат тільки вибраних
сценаріїв. GitHub workflow `e2e-firefox.yml` запускається для pull request, push у `main`
та вручну через **Actions → Firefox Desktop extension E2E → Run workflow**.
Він збирає й перевіряє AMO runtime через `npm run package:amo`, зберігає
діагностику на 14 днів і нічого не публікує. Окремий **Extension CI** зберігає
AMO upload ZIP, checksum і build metadata на 30 днів.

Офіційні джерела:

- https://firefox-source-docs.mozilla.org/testing/geckodriver/Flags.html
- https://www.selenium.dev/selenium/docs/api/javascript/firefox.js.html
- https://www.w3.org/TR/webdriver-bidi/
- https://firefox-source-docs.mozilla.org/testing/geckodriver/Profiles.html
- https://extensionworkshop.com/documentation/develop/testing-persistent-and-restart-features/
- https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/

- https://bugzilla.mozilla.org/show_bug.cgi?id=2049350
- https://bugzilla.mozilla.org/show_bug.cgi?id=2048133
- https://github.com/mozilla-firefox/firefox/blob/main/security/manager/ssl/nsIX509CertDB.idl


## Перші content messages після event-page idle unload (43)

Один новий native сценарій: загалом 42 tests, IDs не є кількістю тестів.

Сценарій також читає native Firefox ExtensionActivityLog у parent process:
рівно п’ять background runtime.onMessage callbacks із точними payload, sender
extension ID, producer URL і main-frame ID. Firefox передає payload/MessageSender;
Chromium ActivityLog має інший формат, тому його selector тут не використовується.
Parent callback із кешованого native alarms API записує всі фактичні deliveries.
Warm message та справжній minute alarm — позитивні controls перед idle; жоден
alarm після native history marker не має передувати завершенню first replies.
Timestamp message-події походить із native log, а не часу пізнішого читання Node.
Читання журналу не викликає extension API та не будить event page; observers
видаляються у finally, повна історія зберігається й при падінні assertion.


Durable fixture: Daily Limit 21 із 840 seconds, правило 22 у неактивному Study,
ручна 10-minute Hardcore Focus через справжній Popup reader UI, disabled
Scheduled Focus revision 7 та явно збережені ненульові generation/rule/list
revisions. Metadata і schedule записано справжнім storage.local API; це fixture,
а не імпорт або crash між writes. Production runtime і version 5.3.20 незмінні.

Після справжнього minute tick залишено лише HTTP producer із content script,
інжектованим native scripting.executeScript. Він не викликає runtime API до
явного trigger. Сценарій спочатку підтверджує automatic unload із native default
idle interval та sustained stopped/absent стан щонайменше 1 second. Жодного
readiness ping, reload, terminate або примусового restart перед cold request.

П’ять повідомлень надсилаються одним synchronous burst, без await між sends,
таймера або retry: check_pro_status, focus_schedule_get, валідний rename Study,
rename Work із застарілою generation, rename Work із застарілою list revision.
Усі перші callbacks мають завершитись до кожного native alarm. Перевіряються
саме початкові packets: paid true, schedule config/revision 7, повні rules/list
дані й успішний валідний intent, точний rules_state_changed для обох stale
intents. Пізніший правильний state не може виправити неправильну першу відповідь.

До відкриття читачів cold storage/DNR мають зберегти Focus, 840 seconds, порожній
journal, generation/rule revisions і всі незмінені list revisions. Лише rename
Study змінює name та його revision. JS global sentinel губиться, native session
sentinel і той самий process/profile зберігаються. Потім reopened Options/Popup
reader та реальна навігація перевіряють чинний Focus і exhausted budget. Це reader
у вкладці; справжній toolbar Popup покрито іншими сценаріями.

Node controls відхиляють pinned background, early/competing wake, відсутній
producer, погані first replies, прийняті stale intents і retry. Окремі два
production-worker тести (із контрольованими storage API waits) надсилають перший
burst без warm-up intent і під час утриманого startup; listener мусить лишити
канал відкритим, не відповідати default state до read completion і повернути
правильні дані. Це production modules із model APIs, не native browser proof.

Native cold wake перевіряє повторний module/context startup від message після
idle, а не browser runtime.onStartup overlap, install/reload registration gap,
OS suspend/resume, Android/macOS або весь проміжний state history. Для browser
onStartup overlap окремо наведено контрольований production-module тест. Додані
сценарії не підміняють Date, API results або browser alarm delivery; retries 0.

Marionette browser-chrome observer стежить за extension:background-script-status,
state/views і process/profile, без background toolbox чи extension API polling.
Після stopped interval лише ordinary HTTP page отримує BiDi evaluation, що
тригерить його content script. Native parent event мусить показати рівно один
wake між trigger та останнім first reply. До reopened UI storage/session/DNR
читаються безпосередньо з native parent backends. Worker-specific CDP helpers
із Chromium сюди не переносяться.

Артефакт: native-cold-message.json та coldMessage у results.json містять native
samples/events, first replies, before/cold state й втрачений global sentinel.

```sh
cd e2e
node runner.mjs --headed --filter=43 --max-failures=1
```

Офіційний опис event-page lifetime:
https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts
