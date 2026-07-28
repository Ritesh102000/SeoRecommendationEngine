# Privacy Policy — SEO Lens

_Last updated: 28 July 2026_

SEO Lens does not collect, transmit, sell or share any personal information.

## What the extension accesses

**The page you scan.** When you click *Scan page*, the extension reads the
current tab's DOM — title, meta tags, headings, text, links, images and
structured data. This happens only on your click, only in that tab, and the
extension never modifies the page.

**Competitor pages you add.** If you add competitor URLs, the extension fetches
those pages directly from your browser, exactly as visiting them would, and
parses them locally. Requests are sent without cookies or credentials. Chrome
asks for your permission for each site before any request is made, and you can
revoke it at any time from `chrome://extensions`.

## What leaves your browser

Nothing.

There is no backend, no analytics, no telemetry, no crash reporting and no
third-party service of any kind. The extension makes no network requests other
than fetching the competitor URLs you explicitly enter. All analysis — parsing,
keyword extraction, TF-IDF scoring and clustering — runs on your own machine.

## What is stored, and where

The following are kept in Chrome's local extension storage on your device:

- the competitor URLs you add,
- your most recent scan result, so reopening the popup does not lose your work,
- a cache of fetched competitor pages, expiring after 6 hours.

This data never leaves your device. Remove it at any time by using *Refetch
(ignore cache)*, removing competitors from the list, or uninstalling the
extension — uninstalling deletes all of it.

## Permissions

| Permission | Why |
| --- | --- |
| `activeTab`, `scripting` | Read the current page's content when you click Scan |
| `storage` | Save your competitor list and cache pages locally |
| Optional host access | Fetch the specific competitor URLs you add. Optional and requested at the moment you need it — never granted up front |

## Children

The extension is a developer/marketing tool and is not directed at children
under 13. It collects no personal data from anyone.

## Changes

Any change to this policy will be published with a new version of the extension
and reflected in the date above.

## Contact

Open an issue on the project repository.
