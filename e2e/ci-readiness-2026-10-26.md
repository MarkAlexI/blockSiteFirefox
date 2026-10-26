# Корекція готовності CI, 2026-10-26

Це тестові зміни поверх Chromium `23fae31a53377ad0af027908600e2ae7fb4c230e`
та Firefox `7d76a8d971bbe187119df106fe525bf1861783d4`. Runtime лишається **5.4.15**.

## Діагноз за реальними CI artifacts

[Chromium run 40292986658](https://github.com/MarkAlexI/blockSiteExtension/actions/runs/40292986658):
core **52/53**, lifecycle **9/10**, overdue **1/1**. Extension CI успішний.
Прочитані results.json, JSON attachments та native browser trace обох падінь.

### Scenario 66: навантаження завершилося до вимірювання

`cold-startup-popup-measurement` підтвердив новий browser PID, 12 restored
tabs, відсутність reinstall/session/global marker, один перший callback,
trusted Add/Save та одне збережене правило. Assertion CPU overlap справедливо
відхилив вимірювання: підготовка тривала **36437 ms**, а кожен Worker мав
фіксовані **20 s** від завантаження. Останній chunk найпізнішого Worker
закінчився приблизно за **3976.5 ms до open click**; двох активних джерел
навантаження під час Popup measurement не було.

First reply **2.9 ms**, readiness **426.1 ms** та launch-to-ready приблизно
**37.1 s** з того невдалого звіту не є прийнятим benchmark під CPU pressure.
Останнє число також включає приєднання Playwright, tracing/routes та підготовку
host page. Воно не встановлює тривалість ініціалізації BlockDistraction.

Виправлення: живий loopback owner підтверджує отримані CPU chunks і поновлює
ту саму **20-second lease**. Worker перевіряє її до наступного CPU chunk;
втрата owner або запізніла відповідь не відновлює expired workload. Закриття
HTTP owner припиняє обмін і завершує Worker. Збережені **8 ms / 32 ms**,
12 вкладок, required overlap щонайменше двох fresh producers, 15-second UI
deadline, 120-second test deadline і zero retries. Поновлення продовжує
загальну тривалість workload за наявності живого owner; watchdog обмежує
період без підтверджень. Межі очікування тесту не змінені.

Звіт тепер містить policy/producer renewals і окремі `preparation` durations:
CDP attachment, tracing/routes, pressure wait та host setup. Readiness
залишається виміряною верхньою межею; результат не створюється без CPU proof.

### Scenario 54: Stop надійшов до завершення Start

У trace після storage refresh Start уже приховав початковий view і заблокував
rule toggles. У `after@call@1713` (18431.859 ms) `focus-controls` ще має
`aria-busy="true"`; останній повний button snapshot має
`aria-disabled="true"`. Stop отримує focus в `call@1715`, а Enter надсилається
в `call@1717` на **18439.236 ms**. У наступному повному snapshot pending уже
знятий, але сам ранній Enter був обґрунтовано відхилений production guard.
Final storage залишив `focusActive:true`, і DNR обох правил мав `reason=focus`.

Спільний Chromium/Firefox scenario тепер read-only перевіряє одночасно
видимість action/view, native disabled, aria-disabled і aria-busy перед
Start/Stop. Надсилається один Enter, без повторення або synthetic click.
Після Stop перевіряються і UI unlock, і збережений `focusActive:false`.
У production змін для цього діагнозу не потрібно.

## Перевірки та межі

- Node regression використовує справжні production Popup Focus methods з
  утриманою відповіддю Start: старе очікування lock уже проходить, Stop ще
  guarded; після відповіді дозволений один Stop і inactive state.
- Worker API-model виконує HTTP-served script із контрольованим годинником.
  Replay **36 s** падає на точній базі й проходить після виправлення. Окремо
  перевірені відсутній owner, malformed lease, expiry і пізні відповіді.
- Попередній receipt oracle продовжує відхиляти expired/non-overlapping та
  old-process CPU records, duplicate messages, synthetic inputs і duplicate
  mutations. Обмеження не видалені.
- `npm run check`: Chromium **2240/2240**, Firefox **2213/2213**, без skips;
  extension validation і всі 70 palette checks успішні.
- Встановлений Firefox Developer Edition **158.0b2**, Linux x64,
  geckodriver **0.37.1**, Node **24.22.1**, headless persistent development
  profile: змінений native scenario **54 passed**, 0 failed, body started.
- Native Firefox Web Worker probe також пройшов: дві справжні вкладки,
  **21058 ms** після setup, **1311 CPU receipts**, обидва Workers працюють
  після старої 20-second межі. Це перевірка HTTP/Worker wiring;
  вона не доводить Chromium timing або 12-tab measurement.
- [Повний Firefox CI бази](https://github.com/MarkAlexI/blockSiteFirefox/actions/runs/40293709328)
  успішний: core та overdue зелені. Це результат базового commit, а не повний
  CI цього коригувального патчу.
- Нові Chromium 54/66 потребують повторного CI після owner push. Локальний
  контейнер не дозволяє ProcessSingleton AF_UNIX socket; нативних чисел для
  виправленого Chromium measurement тут немає. Патч не містить результату
  майбутнього запуску або production performance claims.

Корисні джерела: [Chrome storage](https://developer.chrome.com/docs/extensions/reference/api/storage)
описує asynchronous API; [MDN aria-disabled](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-disabled)
пояснює потребу власного JS guard; [Worker.postMessage](https://developer.mozilla.org/en-US/docs/Web/API/Worker/postMessage)
описує асинхронну доставку. Історичний
[коментар wOxxOm, 2020-04-29](https://stackoverflow.com/questions/61507548/why-i-cant-get-chrome-storage-instantly-in-popup)
нагадує, що завершення async операції потрібно очікувати; поточний діагноз
ґрунтується на CI trace та production source, а не на припущенні зі старої дискусії.
