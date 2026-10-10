// Synthetic HTTP documents only. No production response or browser API is replaced.
export function frameUrls(token, step = 'initial') {
  const query = new URLSearchParams({ token });
  return {
    main: `http://frame-parent.bd-e2e.test/frames/main?${query}`,
    middle: `http://frame-basic.bd-e2e.test/frames/middle?${query}`,
    leaf: `http://frame-daily.bd-e2e.test/frames/leaf?${query}&step=${step}`
  };
}

export function frameFixtureHtml(input) {
  const url = new URL(input);
  const token = url.searchParams.get('token');
  if (!token || !/^[a-zA-Z0-9-]+$/.test(token)) return null;
  const urls = frameUrls(token);
  const role = ['main', 'middle', 'leaf'].find(role => {
    const expected = new URL(urls[role]);
    return url.protocol === expected.protocol && url.hostname === expected.hostname &&
      url.port === expected.port && url.pathname === expected.pathname;
  });
  if (!role) return null;
  const child = role === 'main' ? urls.middle : role === 'middle' ? urls.leaf : null;
  return '<!doctype html><html><head>' +
    `<title>BD frame ${role}</title></head><body data-frame-role="${role}">` +
    `<h1>BD frame ${role}</h1>` +
    (child ? `<iframe id="child" src="${child.replaceAll('&', '&amp;')}"></iframe>` : '') +
    '</body></html>';
}
