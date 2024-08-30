async function storageUpdateHandler(changes) {
  const template = changes.rules.newValue.slice();

  const newRules = template.map((rule, i) => {
    const newRule = rule.redirectURL !== '' ?
      JSON.parse(`{
        "action": {
          "redirect": {
            "url": "${rule.redirectURL}"
          },
          "type": "redirect"
        },
        "condition": {
          "urlFilter": "||${rule.blockURL}",
          "resourceTypes": [
            "main_frame"
          ]
        },
        "id": ${i + 1},
        "priority": 1
      }`) :
      JSON.parse(`{
        "id": ${i + 1},
        "condition": {
          "urlFilter": "||${rule.blockURL}",
          "resourceTypes": ["main_frame"],
          "excludedResourceTypes": []
        },
        "action": {
          "type": "block"
        },
        "priority": 1
      }`);

    return newRule;
  });

  try {
    const oldRules = await browser.declarativeNetRequest.getDynamicRules();
    await browser.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: oldRules.map(rule => rule.id),
      addRules: newRules,
    });
  } catch (error) {
    console.log(error);
  }
}

browser.storage.sync.onChanged.addListener(storageUpdateHandler);
