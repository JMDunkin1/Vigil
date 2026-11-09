# Shared-file and link-index search rules

Reviewed November 7, 2026, following the screenshot of the Google query
`abella danger gofile` and the request to cover multiple sharing services.

## What was verified

The exact query was reproduced in Google with `safe=active`. Google displayed
the locked-SafeSearch banner and Rentry results containing Mega and Gofile
links. Another result exposed `gofile.today/l/d/...`; this is an observed
alternate sharing destination, not a claim of affiliation with Gofile.
Browser security policy rejected opening the Rentry result. No alternate
browser, fetch, or proxy was used to work around that rejection. The precise
VIDZ4ALL entry's full outbound-link inventory remains unverified.

The current fetched homepages of unionofthecrowns.com and
vibranthomehealthcare.com contain generic articles, unlike the search snippets
in the screenshot. Direct ordinary HTTP reads returned 403. Those observations
do not establish that either entire domain is a dedicated adult/file index.

Primary service evidence for broader category coverage:

| Service | Evidence |
| --- | --- |
| Bunkr and album index | [Bunkr](https://bunkr.cr/) and [FAQ](https://bunkr.cr/faq) identify file hosting and announce the migration from bunkr-albums.io to balbums.st. The linked [album index](https://balbums.st/) exposes searchable albums and multiple explicitly labeled adult entries. |
| Pixeldrain | [Service](https://pixeldrain.com/) and [documentation](https://docs.pixeldrain.com/questions_and_answers/) identify file storage and sharing. |
| Catbox and Litterbox | [Service](https://catbox.moe/) links temporary storage at litterbox.catbox.moe; the [FAQ](https://catbox.moe/faq.php) documents files.catbox.moe and support for adult uploads. |
| MediaFire | [Service](https://www.mediafire.com/) documents file/folder sharing and direct download links. |
| Send.now | [Service](https://send.now/) documents link-based file and folder transfers. |
| SwissTransfer | [Service](https://www.swisstransfer.com/en) documents temporary files shared by download link. |
| Filebin | [Service](https://filebin.net/) documents upload/download bins shared by URL. |
| Sendvid and imgbox | [Sendvid](https://sendvid.com/) documents video links; [imgbox](https://imgbox.com/) documents image hosting and directly links Sendvid. |
| Streamable | [Service](https://streamable.com/) identifies video upload and hosting. |
| WeTransfer and short links | [Official firewall inventory](https://wetransfer.com/help-center/troubleshooting/configure-firewall) identifies wetransfer.com and we.tl. |
| OneDrive and short links | [Microsoft sharing documentation](https://support.microsoft.com/en-us/onedrive/share-files-and-folders-in-microsoft-onedrive) identifies 1drv.ms short links. |
| pCloud | [Service](https://www.pcloud.com/) documents sharing and links its my.pcloud.com host. |
| Rentry | The [service homepage](https://rentry.co/) identifies Markdown pastes; rentry.co and rentry.org were already in Vigil's paste-service inventory. |

Existing Mega, Gofile, Drive, Dropbox, 4shared, Cyberdrop, Pixl, Erome,
paste-service and link-redirector entries remain in force. Inaccessible roots
(including Cyberdrop, Krakenfiles, 1fichier and Saint) were not treated as
evidence for new mirror domains.

## Enforcement

- Reviewed album directory balbums.st and its published old domain receive
  permanent domain bans through the shared priority policy.
- The expanded service inventory applies to Google results when a verified
  locked-SafeSearch banner or filtered-results notice is observed on that URL.
  Entire result cards are hidden; link and context-menu activation is guarded
  before delayed DOM scans.
- Known domains, subdomains, short links, Google redirect citations, and
  distinctive service names in snippets are covered. Generic words such as
  `drive`, `box`, `send now`, `litterbox`, and `streamable` are not service-name
  matches by themselves.
- Explicit sharing/index descriptions (file hosting/sharing, public/shared
  folders or albums, download/folder/album/mirror links) also cover unknown
  provider names under that same SafeSearch condition. A standalone `download`,
  `file`, `folder`, `album`, or `mirror` is insufficient.
  Existing broader contributor rules still apply when Google specifically
  confirms filtered results; the new category does not relax those rules.
- The same inventory supplies contributor evidence for a filtered search and
  strips service qualifiers from cached subject identity. Switching file
  services cannot change that subject. Ordinary-context and expiry boundaries
  remain in place.
- Reader collection checks retain their requirement for real shared-file
  destinations and corroborating evidence. Homepages are not counted as files.
- Exact hostname parsing preserves lookalike and userinfo boundaries.

Regression fixtures use synthetic destinations and load no remote media.
They cover alternate services with and without notices, whole-card hiding,
dynamic content, navigation interception, subject isolation, hostname spoofs,
and permanent index denial. Shared generation distributes the browser guard
to Safari, including the iPhone bundle. Installation must still use the
verified app-and-policy update transaction.
