# Block Site Extension
An extension that will block or redirect requests in browser used `declarativeNetRequest` for generating dynamic rules.
![blocker.png](/images/blocker.png "blocker")
## How to work with extension
To block a resource, enter a part of its name in the left input field without specifying the protocol. For example, entering "youtube" will block all subdomains of this resource. In the right input field, enter the URL for redirection, fully specified with the protocol, e.g., "https://google.com". Then click the save button. If the redirect URL is left empty, the target site will simply be blocked. To modify a rule, delete the old rule and add a new one.