/**
 * Fetches and displays declarativeNetRequest rules in a readable format.
 * Designed to be called from the browser console.
 */
export const checkDNR = async () => {
  try {
    const rules = await browser.declarativeNetRequest.getDynamicRules();

    if (rules.length === 0) {
      console.log(
        "%c[DNR] No active rules found in browser memory.",
        "color: #ffa500; font-weight: bold;"
      );
      return;
    }

    const readableRules = rules.map((r) => ({
      ID: r.id,
      Priority: r.priority,
      Filter: r.condition.urlFilter,
      Action: r.action.type,
      RedirectTo: r.action.redirect ? r.action.redirect.url : "–",
    }));

    console.log(
      `%c[DNR] Active rules count: ${rules.length}`,
      "color: #4CAF50; font-weight: bold;"
    );
    console.table(readableRules);
    console.log("Raw DNR rules (JSON):", rules);
  } catch (err) {
    console.error("[DNR] Failed to fetch rules:", err);
  }
};