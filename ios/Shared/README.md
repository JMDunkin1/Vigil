# Shared iOS filtering assets

`PhoneBlocklist.swift` reads Sentinel's generated `adult-blocklist.sdi` resource.
The app target should copy the artifact produced in `data/adult-blocklist.sdi`
into its bundle under that name. Absence is explicit: `loadBundled()` returns
`nil`; a present but corrupt, oversized, or unsupported artifact throws.

The artifact metadata preserves the selected source's label, URL, homepage, and
license. UI or distribution notices must continue to surface that attribution;
generating the compact index does not relicense the source list.
