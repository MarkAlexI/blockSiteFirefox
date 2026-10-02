# Firefox Desktop E2E — BlockDistraction 5.3.4

Окремий Selenium/WebDriver runner для нативного Firefox. Він відповідає
13 сценаріям Chromium E2E, але використовує Firefox event page, `browser.*`,
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
npm test
```

Приклад PowerShell для Developer Edition:

```powershell
cd e2e
npm ci
$env:BD_FIREFOX_BINARY = 'C:\Program Files\Firefox Developer Edition\firefox.exe'
$env:BD_GECKODRIVER = 'C:\Tools\geckodriver.exe'
npm test
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
саме версії 5.3.4: установіть `BD_SIGNED_XPI=/absolute/path/to/target.xpi`.
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
У середовищах без GUI використовуйте headless або власний Xvfb display.

## Відповідність Chromium

| ID | Спільний сценарій | Перевірка Firefox |
| --- | --- | --- |
| 01 | Два Options, одночасні додавання | Два нативні runtime callers, обидва UI, унікальні ID, DNR і redirect |
| 02 | UI split спільного Daily Limit | 840 секунд збережено, старий scoped key прибрано, обидва UI, реальний redirect |
| 03 | Split/move з v1 до migration | Одночасні Options messages, успадкування 840 секунд обома assignments |
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

01/03 використовують одночасні runtime messages з двох справжніх Options,
а не одночасні фізичні натискання. UI add/edit/delete/import та Pro actions
в інших сценаріях виконуються нативними WebDriver clicks/keys/select/file input.
BiDi reads та runtime calls адресуються конкретній сторінці й не активують
вкладку: accounting polls не забирають foreground у сторінки, що вимірюється.

## Межі перевірки

Початкові rules/credentials/usage/journal задаються через справжній
`browser.storage`. Нативні runtime, storage, DNR, tabs, scripting, alarms та
реальний годинник не підмінюються. Синтетичні `.bd-e2e.test` HTTP-сторінки
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

## Результати й CI

`results.json` містить `passed/failed/blocked/not-run`, `bodyStarted`, phase,
помилку, target і browser capabilities. У `test-results/<ID>/` зберігаються
geckodriver logs, screenshots Options, final state, HTTP mock events та
JavaScript/interception errors. Після restart є артефакти до й після нього.
Це Selenium diagnostics, а не Playwright trace viewer archive.

`BD_E2E_RESULTS` і `BD_E2E_JSON` задають інші місця результатів.
`BD_EXTENSION_PATH` вибирає unpacked AMO runtime target;
`BD_EXPECTED_VERSION` за замовчуванням `5.3.4`.

Помилка setup зупиняє решту набору як `not-run`. `blocked` чи `failed`
повертає exit code 1. Повне green можливе лише коли всі 13 scenario bodies
виконані та пройшли. Запуск із `--filter` повертає результат тільки вибраних
сценаріїв. GitHub workflow `e2e-firefox.yml` має тільки `workflow_dispatch`;
він не запускається від цього локального патча і нічого не публікує.

Офіційні джерела:

- https://www.selenium.dev/documentation/webdriver/bidi/w3c/network/
- https://www.selenium.dev/selenium/docs/api/javascript/firefox.js.html
- https://www.w3.org/TR/webdriver-bidi/
- https://firefox-source-docs.mozilla.org/testing/geckodriver/Profiles.html
- https://extensionworkshop.com/documentation/develop/testing-persistent-and-restart-features/
- https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/
