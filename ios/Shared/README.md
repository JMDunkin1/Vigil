# Shared iOS filtering assets

`PhoneBlocklist.swift` reads Vigil's generated `adult-blocklist.sdi` resource.
Browser and system-filter targets that use this index should copy the artifact
produced in `data/adult-blocklist.sdi` into their bundle under that name.
Narrow companions with an exact host/path allowlist, including VigilInstagram
and the YouTube companion, should not compile or bundle it. Absence is explicit:
`loadBundled()` returns `nil`; a present but corrupt, oversized, or unsupported
artifact throws.

The artifact metadata preserves the selected source's label, URL, homepage, and
license. UI or distribution notices must continue to surface that attribution;
generating the compact index does not relicense the source list.

Format v2 stores a SHA-256-protected table of front-coded block offsets so an
app can build its sparse lookup index without decoding every domain at startup.
The reader continues to accept format v1 artifacts during rollout, while new
artifacts are always generated as v2.
