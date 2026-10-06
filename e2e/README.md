# Firefox Desktop E2E — BlockDistraction **5.3.18**

Окремий Selenium/WebDriver runner для нативного Firefox. Він відповідає
13 початковим сценаріям Chromium E2E, але використовує Firefox event page, `browser.*`,
`moz-extension://` і WebDriver BiDi. Playwright Firefox не використовується
для встановлення WebExtensions.

Версія розширення, runtime-файли, permissions і нативний Firefox data consent
цим патчем не змінюються. Підготовлене покриття не означає успішного E2E:
фактичний результат кожного запуску міститься в `results.json`.

## Повний запуск

Потрібні Node.js >=22, Firefox Developer Edition або Nightly і geckodriver.
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
npm run test:headed
```

Указуйте свої фактичні шляхи. Runner створює новий профіль для кожного
сценарію й видаляє його після перевірки. Особистий Firefox-профіль не
використовується. Для 05/06 зберігається той самий тестовий профіль між
двома процесами браузера; додаток після restart не перевстановлюється.

За замовчуванням `BD_INSTALLATION=persistent`. Для unsigned test XPI runner
ставить `xpinstall.signatures.required=false` тільки в новому тестовому
профілі. Це офіційно підтримуваний режим розробки в Developer Edition/Nightly;
звичайний Release Firefox його не підтримує. Захист процесів браузера й
ізоляція sandbox не вимикаються.

Звичайний Firefox Release може виконати повний набір із підписаним AMO XPI
саме версії 5.3.18: установіть `BD_SIGNED_XPI=/absolute/path/to/target.xpi`.
Цей файл є фактичним target для всіх сценаріїв; `BD_EXTENSION_PATH` тоді
не використовується. Runner перевіряє version, ID та event-page manifest,
але підписаний XPI може мати інші runtime-байти. Саме його потрібно
зазначати як протестований артефакт.

Для unsigned XPI у Release можливе `BD_INSTALLATION=temporary`, але
05/06 отримають статус `blocked` і весь набір поверне exit code 1.
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
Delete/import перевіряє завершення usage cleanup окремим bounded poll:
спостереження rules/DNR storage ще не означає завершення post-commit задач.

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
цього desktop набору; legacy fallback лишається в Node regression suite. Синтетичні `.bd-e2e.test` HTTP-сторінки
й verification endpoint обслуговуються BiDi network interception. Для
activation потрібне спостереження фактичного background HTTP request;
невидимий або непідтримуваний interception не дає green result.

Створений локальний deny proxy блокує зовнішній трафік до підключення BiDi,
зокрема при startup після restart. Він нічого не пересилає. Тестові профілі
містять лише dummy key `BD-E2E-VALID-KEY`; BiDi RequestData не містить POST
body, тому runner не заявляє перевірку вмісту цього body. Production backend,
реальні ліцензії, Paddle та купівлі цим набором не перевіряються.

05 починається із заданого durable post-commit/pre-recovery journal і
перевіряє чистий restart, а не штучно викликаний crash. Автоматичне idle
вивантаження Firefox event page та Scheduled Focus crash tradeoff не
перевіряються. H1 stale post-commit prune у production залишається
непідтвердженим; цей E2E-патч не є доказом його досяжності.

Firefox Android потребує окремого ручного проходу. Desktop Firefox E2E
не підтверджує Android, Chromium, Edge або Kiwi.

Deferred-sync сценарій перевіряє реальний browser capacity через oversized
fixture, а не всі можливі API rejection чи OS failure. Ані DNR methods, ані
alarm delivery не замінено doubles. Наступний retry — фактичний native alarm,
запланований у тимчасовому профілі, без виклику production listener вручну.

## Результати й CI

`results.json` містить `passed/failed/blocked/not-run`, `bodyStarted`, phase,
помилку, target і browser capabilities. У `test-results/<ID>/` зберігаються
geckodriver logs, screenshots Options, final state, HTTP mock events та
JavaScript/interception errors. Після restart є артефакти до й після нього.
Це Selenium diagnostics, а не Playwright trace viewer archive.

`BD_E2E_RESULTS` і `BD_E2E_JSON` задають інші місця результатів.
`BD_EXTENSION_PATH` вибирає unpacked AMO runtime target;
`BD_EXPECTED_VERSION` за замовчуванням береться з `manifest.json` поточного checkout.
Runner і перевірка пакета використовують одне значення з `target-version.mjs`.
Для підписаного XPI іншої версії override задають явно; це не підтверджує
сумісність сценаріїв із тією версією.

Помилка setup зупиняє решту набору як `not-run`. `blocked` чи `failed`
повертає exit code 1. Повне green можливе лише коли всі 17 scenario bodies
виконані та пройшли. Запуск із `--filter` повертає результат тільки вибраних
сценаріїв. GitHub workflow `e2e-firefox.yml` запускається для pull request, push у `main`
та вручну через **Actions → Firefox Desktop extension E2E → Run workflow**.
Він збирає й перевіряє AMO runtime через `npm run package:amo`, зберігає
діагностику на 14 днів і нічого не публікує. Окремий **Extension CI** зберігає
AMO upload ZIP, checksum і build metadata на 30 днів.

Офіційні джерела:

- https://firefox-source-docs.mozilla.org/testing/geckodriver/Flags.html
- https://www.selenium.dev/documentation/webdriver/bidi/w3c/network/
- https://www.selenium.dev/selenium/docs/api/javascript/firefox.js.html
- https://www.w3.org/TR/webdriver-bidi/
- https://firefox-source-docs.mozilla.org/testing/geckodriver/Profiles.html
- https://extensionworkshop.com/documentation/develop/testing-persistent-and-restart-features/
- https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/
